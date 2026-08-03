import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalSha256Omitting,
  receiptHashIsValid,
  type Authority,
} from "../../packages/contracts/src/index.js";
import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const requestedAt = "2026-07-28T13:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function readEnvelope(
  tool: string,
  requestId: string,
  principalId = "user_local",
  authority = "user_stated",
) {
  return {
    schema_version: "1.0.0",
    request_id: requestId,
    tool,
    actor_claim: {
      principal_id: principalId,
      authority,
    },
    scopes: [{ kind: "workspace", id: "workspace_local" }],
    purpose: "restore exact-scope task context",
    reason: "explicit integration test request",
    requested_at: requestedAt,
    safety_class: "read_only",
  };
}

function runtime(
  storage: SqliteStorageClient,
  allowedAuthorities: Authority[] = ["user_stated", "tool_result"],
): MemoryRuntime {
  return new MemoryRuntime({
    storage,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [
          { kind: "workspace", id: "workspace_local" },
        ],
        allowed_authorities: allowedAuthorities,
        destructive_tools_enabled: false,
      },
      default_token_budget: 1_800,
    },
  });
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("principal-bound memory kernel", () => {
  it("persists every supported evidence source as L0 without publication", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("evidence-adapter-variants"),
    });
    const kernel = runtime(storage, [
      "user_stated",
      "observed",
      "tool_result",
      "imported",
    ]);
    const result = await kernel.memoryEvidenceIngest({
      envelope: {
        ...readEnvelope("memory_evidence_ingest", "request_ingest_variants"),
        safety_class: "proposal",
        idempotency_key: "evidence-ingest-integration-variants-001",
      },
      batch: {
        scope: { kind: "workspace", id: "workspace_local" },
        outcome: "partial",
        items: [
          {
            kind: "conversation_turn",
            speaker: "user",
            occurred_at: "2026-07-28T12:56:00.000Z",
            sensitivity: "personal",
            text: "Keep the original claim.",
          },
          {
            kind: "conversation_turn",
            speaker: "assistant",
            occurred_at: "2026-07-28T12:57:00.000Z",
            sensitivity: "internal",
            text: "This is an observation, not a user claim.",
          },
          {
            kind: "tool_result",
            tool_name: "workspace_read",
            occurred_at: "2026-07-28T12:58:00.000Z",
            sensitivity: "internal",
            text: "source verified",
          },
          {
            kind: "text_file",
            source_name: "architecture.md",
            media_type: "text/markdown",
            occurred_at: requestedAt,
            sensitivity: "internal",
            text: "# Evidence\n\nL0 remains canonical.",
          },
        ],
      },
    });
    const health = await storage.health();
    await storage.close();

    expect(result.status, JSON.stringify(result)).toBe("OK");
    if (result.status !== "OK") {
      throw new Error("all supported evidence variants must be admitted");
    }
    expect(result.data).toMatchObject({
      adaptation: {
        mode: "fast_l0",
        item_count: 4,
        candidate_count: 0,
      },
    });
    expect(health.counts).toMatchObject({
      evidence_events: 4,
      episodes: 1,
      memory_candidates: 0,
      memory_objects: 0,
      memory_revisions: 0,
      learning_candidates: 0,
      learning_release_pointers: 0,
    });
  });

  it("adapts common text input into idempotent L0 evidence only", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("evidence-adapter"),
    });
    const kernel = runtime(storage);
    const ingestInput = {
      envelope: {
        ...readEnvelope("memory_evidence_ingest", "request_ingest_1"),
        safety_class: "proposal",
        idempotency_key: "evidence-ingest-integration-001",
      },
      batch: {
        scope: { kind: "workspace", id: "workspace_local" },
        outcome: "succeeded",
        items: [
          {
            kind: "conversation_turn",
            speaker: "user",
            occurred_at: "2026-07-28T12:59:00.000Z",
            sensitivity: "personal",
            text: "Keep raw evidence separate from durable memory.",
          },
          {
            kind: "tool_result",
            tool_name: "workspace_read",
            occurred_at: requestedAt,
            sensitivity: "internal",
            text: "source lineage verified",
          },
        ],
      },
    };

    const first = await kernel.memoryEvidenceIngest(ingestInput);
    const replay = await kernel.memoryEvidenceIngest(ingestInput);
    const conflict = await kernel.memoryEvidenceIngest({
      ...ingestInput,
      batch: {
        ...ingestInput.batch,
        items: ingestInput.batch.items.map((item, index) =>
          index === 0
            ? { ...item, text: "Changed text under the same idempotency key." }
            : item,
        ),
      },
    });
    const deniedAuthority = await kernel.memoryEvidenceIngest({
      ...ingestInput,
      envelope: {
        ...ingestInput.envelope,
        request_id: "request_ingest_denied_authority",
        idempotency_key: "evidence-ingest-integration-denied-001",
      },
      batch: {
        ...ingestInput.batch,
        items: [
          {
            kind: "conversation_turn",
            speaker: "assistant",
            occurred_at: requestedAt,
            sensitivity: "internal",
            text: "Observed text requires observed authority.",
          },
        ],
      },
    });
    const secretMarker = "SECRET_INGEST_MARKER_MUST_NOT_ECHO";
    const rejectedSecret = await kernel.memoryEvidenceIngest({
      ...ingestInput,
      envelope: {
        ...ingestInput.envelope,
        request_id: "request_ingest_secret",
        idempotency_key: "evidence-ingest-integration-secret-001",
      },
      batch: {
        ...ingestInput.batch,
        items: [
          {
            kind: "conversation_turn",
            speaker: "user",
            occurred_at: requestedAt,
            sensitivity: "secret",
            text: secretMarker,
          },
        ],
      },
    });
    const health = await storage.health();
    await storage.close();

    expect(first).toEqual(replay);
    expect(first.status, JSON.stringify(first)).toBe("OK");
    if (first.status !== "OK") {
      throw new Error("evidence ingestion must return a durable receipt");
    }
    expect(conflict).toMatchObject({
      status: "FAILED",
      error: { code: "CONFLICT" },
    });
    expect(deniedAuthority).toMatchObject({
      status: "FAILED",
      error: { code: "PERMISSION_DENIED" },
    });
    expect(rejectedSecret.status).toBe("FAILED");
    expect(JSON.stringify(rejectedSecret)).not.toContain(secretMarker);
    expect(first.data).toMatchObject({
      adaptation: {
        mode: "fast_l0",
        item_count: 2,
        candidate_count: 0,
      },
    });
    expect(health.counts).toMatchObject({
      evidence_events: 2,
      episodes: 1,
      mutation_receipts: 1,
      memory_candidates: 0,
      memory_objects: 0,
      memory_revisions: 0,
      learning_candidates: 0,
    });
  });

  it("commits idempotently, searches, explains, and freezes context", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("kernel-loop"),
    });
    const kernel = runtime(storage);
    const command = inlineEpisode({});
    const commitInput = {
      envelope: {
        ...readEnvelope("memory_episode_commit", "request_commit_1"),
        safety_class: "proposal",
        idempotency_key: command.idempotencyKey,
      },
      episode: command.episode,
      evidence: command.evidence,
      blobs: [],
    };

    const firstCommit = await kernel.memoryEpisodeCommit(commitInput);
    const secondCommit = await kernel.memoryEpisodeCommit(commitInput);
    const search = await kernel.memorySearch({
      envelope: readEnvelope("memory_search", "request_search_1"),
      query: "governed context",
      limit: 20,
      include_sensitive: false,
    });
    const get = await kernel.memoryGet({
      envelope: readEnvelope("memory_get", "request_get_1"),
      evidence_id: command.evidence[0]?.evidence_id,
      scope: command.episode.scope,
    });
    const explain = await kernel.memoryExplain({
      envelope: readEnvelope("memory_explain", "request_explain_1"),
      evidence_id: command.evidence[0]?.evidence_id,
      scope: command.episode.scope,
    });
    if (firstCommit.status !== "OK") {
      throw new Error("expected committed receipt");
    }
    const mutationReceipt = (
      firstCommit.data as { receipt: { receipt_id: string } }
    ).receipt;
    const receiptGet = await kernel.memoryReceiptGet({
      envelope: readEnvelope(
        "memory_receipt_get",
        "request_receipt_get_1",
      ),
      receipt_id: mutationReceipt.receipt_id,
    });
    const compiled = await kernel.memoryContextCompile({
      envelope: readEnvelope(
        "memory_context_compile",
        "request_compile_1",
      ),
      recall: {
        schema_version: "1.0.0",
        request_id: "request_compile_1",
        goal: "restore task context",
        query: "governed context",
        scopes: [command.episode.scope],
        as_of: requestedAt,
        token_budget: 1_800,
        include_sensitive: false,
      },
    });
    const health = await storage.health();
    await storage.close();

    expect(firstCommit).toEqual(secondCommit);
    expect(search.status).toBe("OK");
    expect(get.status, JSON.stringify(get)).toBe("OK");
    expect(explain.status, JSON.stringify(explain)).toBe("OK");
    expect(receiptGet.status).toBe("OK");
    expect(compiled.status).toBe("OK");
    expect(health.ledger_epoch).toBe(1);
    expect(health.counts).toMatchObject({
      episodes: 1,
      evidence_events: 1,
      mutation_receipts: 1,
      recall_requests: 5,
      retrieval_receipts: 5,
      context_slices: 1,
    });
    if (compiled.status !== "OK") {
      throw new Error("expected compiled context");
    }
    const data = compiled.data as {
      context_slice: { frozen_hash: string } | null;
      receipt: Parameters<typeof receiptHashIsValid>[0];
    };
    expect(data.context_slice?.frozen_hash).toBe(
      canonicalSha256Omitting(data.context_slice ?? {}, ["frozen_hash"]),
    );
    expect(receiptHashIsValid(data.receipt)).toBe(true);
  });

  it("rejects identity and scope claims before any storage read audit", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("kernel-auth"),
    });
    const kernel = runtime(storage);
    const before = await storage.health();

    const wrongPrincipal = await kernel.memorySearch({
      envelope: readEnvelope(
        "memory_search",
        "request_wrong_principal",
        "attacker",
      ),
      query: "anything",
    });
    const wrongScope = await kernel.memoryGet({
      envelope: readEnvelope("memory_get", "request_wrong_scope"),
      evidence_id: "evidence_storage_1",
      scope: { kind: "workspace", id: "private_workspace" },
    });
    const wrongAuthority = await kernel.memorySearch({
      envelope: readEnvelope(
        "memory_search",
        "request_wrong_authority",
        "user_local",
        "inferred",
      ),
      query: "anything",
    });
    const after = await storage.health();
    await storage.close();

    expect(wrongPrincipal).toMatchObject({
      status: "FAILED",
      error: { code: "PERMISSION_DENIED" },
    });
    expect(wrongScope).toMatchObject({
      status: "FAILED",
      error: { code: "PERMISSION_DENIED" },
    });
    expect(wrongAuthority).toMatchObject({
      status: "FAILED",
      error: { code: "PERMISSION_DENIED" },
    });
    expect(after.counts.recall_requests).toBe(
      before.counts.recall_requests,
    );
    expect(after.counts.retrieval_receipts).toBe(
      before.counts.retrieval_receipts,
    );
  });

  it("keeps projection degradation distinct from no match", async () => {
    const dataRoot = temporaryRoot("kernel-degraded");
    const storage = await SqliteStorageClient.open({
      dataRoot,
    });
    await storage.commitEpisode(inlineEpisode({}));
    const kernel = runtime(storage);

    const response = await kernel.memorySearch({
      envelope: readEnvelope("memory_search", "request_degraded_1"),
      query: "governed context",
    });
    await storage.close();

    expect(response).toMatchObject({
      status: "DEGRADED",
      fallback_lane: "none",
    });
    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    database.exec("DROP TABLE evidence_fts");
    database.close();
    const reopened = await SqliteStorageClient.open({ dataRoot });
    const reopenedKernel = runtime(reopened);
    const unavailable = await reopenedKernel.memorySearch({
      envelope: readEnvelope(
        "memory_search",
        "request_unavailable_1",
      ),
      query: "governed context",
    });
    const health = await reopened.health();
    await reopened.close();

    expect(unavailable).toMatchObject({
      status: "DEGRADED",
      fallback_lane: "none",
    });
    expect(health.ledger_epoch).toBe(1);
    expect(health.counts.recall_requests).toBe(2);
  });

  it("does not expose another principal's evidence in a shared scope", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("kernel-principal-isolation"),
    });
    const foreign = inlineEpisode({
      episodeId: "episode_foreign_1",
      evidenceId: "evidence_foreign_1",
      idempotencyKey: "commit:foreign:0001",
      principalId: "another_user",
      text: "FOREIGN_PRINCIPAL_MARKER",
    });
    await storage.commitEpisode(foreign);
    await storage.drainFtsOutbox();
    const kernel = runtime(storage);

    const search = await kernel.memorySearch({
      envelope: readEnvelope(
        "memory_search",
        "request_principal_isolation_search",
      ),
      query: "FOREIGN_PRINCIPAL_MARKER",
    });
    const get = await kernel.memoryGet({
      envelope: readEnvelope(
        "memory_get",
        "request_principal_isolation_get",
      ),
      evidence_id: "evidence_foreign_1",
      scope: foreign.episode.scope,
    });
    await storage.close();

    expect(search.status).toBe("NO_MATCH");
    expect(get.status).toBe("NO_MATCH");
  });
});

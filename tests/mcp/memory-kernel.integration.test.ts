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

function runtime(storage: SqliteStorageClient): MemoryRuntime {
  return new MemoryRuntime({
    storage,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [
          { kind: "workspace", id: "workspace_local" },
        ],
        allowed_authorities: ["user_stated", "tool_result"],
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
      fallback_lane: "sqlite_authority_without_fts",
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
      fallback_lane: "sqlite_authority_without_fts",
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

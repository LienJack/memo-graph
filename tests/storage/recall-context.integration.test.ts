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
  ContextSliceSchema,
  RecallRequestSchema,
  RetrievalReceiptSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function recallCommand(query = "What should survive the next session?") {
  const episode = inlineEpisode({});
  const evidence = episode.evidence[0];
  if (evidence === undefined) {
    throw new Error("fixture requires evidence");
  }
  const createdAt = "2026-07-28T12:02:00.000Z";
  const request = RecallRequestSchema.parse({
    schema_version: "1.0.0",
    request_id: "recall_storage_1",
    goal: "Restore durable context",
    query,
    scopes: [evidence.scope],
    as_of: createdAt,
    token_budget: 128,
    include_sensitive: false,
  });
  const unsealedSlice = {
    schema_version: "1.0.0",
    context_slice_id: "context_storage_1",
    request_id: request.request_id,
    compiler_version: "1.0.0",
    created_at: createdAt,
    token_budget: request.token_budget,
    token_used: 24,
    items: [
      {
        memory_id: "memory_evidence_storage_1",
        revision_id: "revision_evidence_storage_1",
        abstraction: "l0_evidence",
        lifecycle: "active",
        authority: evidence.authority,
        sensitivity: evidence.sensitivity,
        scope: evidence.scope,
        content: evidence.payload,
        evidence_ids: [evidence.evidence_id],
        selection_reason: "exact lexical match in the authoritative ledger",
        uncertainty: "raw evidence has not been admitted as L1 memory",
        token_estimate: 24,
      },
    ],
  } as const;
  const contextSlice = ContextSliceSchema.parse({
    ...unsealedSlice,
    frozen_hash: canonicalSha256(unsealedSlice),
  });
  const receipt = RetrievalReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: "retrieval_storage_1",
      created_at: createdAt,
      state: "durable",
      request_hash: canonicalSha256(request),
      receipt_hash: `sha256:${"0".repeat(64)}`,
      kind: "retrieval",
      context_slice_id: contextSlice.context_slice_id,
      compiler_version: "1.0.0",
      policy_version: "1.0.0",
      items: [
        {
          memory_id: contextSlice.items[0]?.memory_id,
          revision_id: contextSlice.items[0]?.revision_id,
          decision: "included",
          reason_codes: ["LEXICAL_MATCH"],
          lane: "sqlite_fts",
          score: -1,
        },
      ],
    }),
  );
  return {
    episode,
    command: {
      principal_id: "user_local",
      request,
      receipt,
      context_slice: contextSlice,
    },
  };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("recall, context, and retrieval receipts", () => {
  it("persists a sealed recall atomically without advancing the ledger", async () => {
    const dataRoot = temporaryRoot("recall");
    const fixture = recallCommand();
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(fixture.episode);

    const before = await storage.health();
    const first = await storage.recordRecall(fixture.command);
    const replay = await storage.recordRecall(fixture.command);
    const after = await storage.health();
    const receipt = await storage.getReceipt({
      receipt_id: fixture.command.receipt.receipt_id,
      principal_id: "user_local",
      scopes: fixture.command.request.scopes,
    });
    const wrongPrincipalReceipt = await storage.getReceipt({
      receipt_id: fixture.command.receipt.receipt_id,
      principal_id: "another_user",
      scopes: fixture.command.request.scopes,
    });
    const wrongScopeReceipt = await storage.getReceipt({
      receipt_id: fixture.command.receipt.receipt_id,
      principal_id: "user_local",
      scopes: [{ kind: "workspace", id: "another_workspace" }],
    });
    const evidence = await storage.getEvidence({
      evidence_id: fixture.episode.evidence[0]?.evidence_id,
      principal_id: "user_local",
      scope: fixture.episode.episode.scope,
    });
    const explanation = await storage.explainEvidence({
      evidence_id: fixture.episode.evidence[0]?.evidence_id,
      principal_id: "user_local",
      scope: fixture.episode.episode.scope,
    });
    await storage.close();

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(receipt).toEqual(fixture.command.receipt);
    expect(wrongPrincipalReceipt).toBeNull();
    expect(wrongScopeReceipt).toBeNull();
    expect(evidence).toEqual(fixture.episode.evidence[0]);
    expect(explanation?.episodes).toEqual([fixture.episode.episode]);
    expect(before.ledger_epoch).toBe(1);
    expect(after.ledger_epoch).toBe(1);
    expect(after.counts).toMatchObject({
      recall_requests: 1,
      retrieval_receipts: 1,
      context_slices: 1,
      receipt_access_scopes: 2,
    });
  });

  it("rejects request-id conflicts and invalid context seals", async () => {
    const dataRoot = temporaryRoot("recall-conflict");
    const fixture = recallCommand();
    const changed = recallCommand("A different query cannot reuse the request id.");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(fixture.episode);
    await storage.recordRecall(fixture.command);

    await expect(storage.recordRecall(changed.command)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      storage.recordRecall({
        ...fixture.command,
        request: {
          ...fixture.command.request,
          request_id: "recall_bad_seal",
        },
        context_slice: {
          ...fixture.command.context_slice,
          request_id: "recall_bad_seal",
          frozen_hash: canonicalSha256Omitting(
            fixture.command.context_slice,
            ["frozen_hash"],
          ),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await storage.close();
  });

  it("enforces append-only recall tables inside SQLite", async () => {
    const dataRoot = temporaryRoot("recall-append-only");
    const fixture = recallCommand();
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(fixture.episode);
    await storage.recordRecall(fixture.command);
    await storage.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    expect(() =>
      database.exec(
        "UPDATE recall_requests SET created_at = '2026-07-28T00:00:00Z'",
      ),
    ).toThrow(/APPEND_ONLY/);
    expect(() =>
      database.exec("DELETE FROM retrieval_receipts"),
    ).toThrow(/APPEND_ONLY/);
    expect(() =>
      database.exec("DELETE FROM receipt_access_scopes"),
    ).toThrow(/APPEND_ONLY/);
    database.close();
  });
});

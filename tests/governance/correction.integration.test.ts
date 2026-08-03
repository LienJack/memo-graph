import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  memoryCandidate,
  memoryProposal,
  revisionCommand,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const AS_OF = "2026-07-28T13:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
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
        allowed_authorities: ["user_stated"],
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

describe("correction and canonical eligibility", () => {
  it("suppresses a predecessor before governed FTS catches up", async () => {
    const dataRoot = temporaryRoot("correction-lag");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    const first = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          scope: { kind: "workspace", id: "workspace_local" },
          text: "Prefer concise Chinese explanations.",
        }),
      }),
      evaluation: {
        decision: "activate",
        reason: "live exact-scope user-stated evidence is eligible",
      },
    });
    await storage.drainFtsOutbox();
    const oldRevision = first.current_revision_id;
    const oldContextRequest = {
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_old_context",
        tool: "memory_context_compile",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [{ kind: "workspace", id: "workspace_local" }],
        purpose: "Freeze the predecessor for audit",
        reason: "Prove audit history remains immutable",
        requested_at: AS_OF,
        safety_class: "read_only",
      },
      recall: {
        schema_version: "1.0.0",
        request_id: "request_old_context",
        goal: "restore old preference",
        query: "concise Chinese explanations",
        scopes: [{ kind: "workspace", id: "workspace_local" }],
        as_of: AS_OF,
        token_budget: 1_800,
        include_sensitive: false,
      },
    } as const;
    const frozenOldContext = await runtime(storage).memoryContextCompile(
      oldContextRequest,
    );
    expect(frozenOldContext.status).toBe("OK");
    if (frozenOldContext.status !== "OK") {
      throw new Error("predecessor Context must compile before correction");
    }
    const frozenReceiptId = (
      frozenOldContext.data as {
        receipt: { receipt_id: string };
      }
    ).receipt.receipt_id;
    const replacement = memoryCandidate({
      candidateId: "candidate_pref_corrected",
      scope: { kind: "workspace", id: "workspace_local" },
      text: "Prefer one falsifiable conclusion with verification evidence.",
    });
    const corrected = await storage.applyMemoryRevision(
      revisionCommand({
        memoryId: first.memory_id,
        expectedRevisionId: oldRevision,
        candidate: replacement,
        idempotencyKey: "memory-correction-lag-001",
      }),
    );

    const staleSearch = await storage.searchGovernedMemory({
      query: "concise Chinese explanations",
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      as_of: AS_OF,
      include_sensitive: false,
      context_scope: null,
      limit: 20,
    });
    const currentSearch = await storage.searchGovernedMemory({
      query: "falsifiable conclusion verification evidence",
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      as_of: AS_OF,
      include_sensitive: false,
      context_scope: null,
      limit: 20,
    });

    expect(staleSearch.items).toHaveLength(0);
    expect(staleSearch.exclusions).toContainEqual(
      expect.objectContaining({
        memory_id: first.memory_id,
        revision_id: oldRevision,
        reason_code: "SUPERSEDED",
      }),
    );
    expect(
      await runtime(storage).memoryContextCompile(oldContextRequest),
    ).toMatchObject({
      status: "FAILED",
      error: { code: "CONFLICT" },
    });
    expect(currentSearch.items).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          memory_id: first.memory_id,
          revision_id: corrected.current_revision_id,
          content_hash: replacement.content_hash,
        }),
        lane: "sqlite_canonical",
      }),
    ]);

    const compiled = await runtime(storage).memoryContextCompile({
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_corrected_context",
        tool: "memory_context_compile",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [{ kind: "workspace", id: "workspace_local" }],
        purpose: "Compile corrected governed Context",
        reason: "Prove correction is immediate",
        requested_at: AS_OF,
        safety_class: "read_only",
      },
      recall: {
        schema_version: "1.0.0",
        request_id: "request_corrected_context",
        goal: "restore corrected preference",
        query: "falsifiable conclusion verification evidence",
        scopes: [{ kind: "workspace", id: "workspace_local" }],
        as_of: AS_OF,
        token_budget: 1_800,
        include_sensitive: false,
      },
    });
    expect(compiled.status).toBe("OK");
    if (compiled.status !== "OK") {
      throw new Error("corrected Context must compile");
    }
    expect(compiled.data).toMatchObject({
      context_slice: {
        items: [
          {
            memory_id: first.memory_id,
            revision_id: corrected.current_revision_id,
            abstraction: "l1_memory",
          },
        ],
      },
    });
    const governedSearch = await runtime(storage).memorySearch({
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_corrected_search",
        tool: "memory_search",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [{ kind: "workspace", id: "workspace_local" }],
        purpose: "Search canonical governed memory",
        reason: "Prove search uses the eligibility oracle",
        requested_at: AS_OF,
        safety_class: "read_only",
      },
      query: "falsifiable conclusion verification evidence",
      limit: 20,
      include_sensitive: false,
    });
    expect(governedSearch).toMatchObject({
      status: "OK",
      data: {
        items: [
          {
            abstraction: "l1_memory",
            memory_id: first.memory_id,
            revision_id: corrected.current_revision_id,
          },
        ],
      },
    });
    const governedGet = await runtime(storage).memoryGet({
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_corrected_get",
        tool: "memory_get",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [{ kind: "workspace", id: "workspace_local" }],
        purpose: "Read the canonical governed memory",
        reason: "Prove get uses the eligibility oracle",
        requested_at: AS_OF,
        safety_class: "read_only",
      },
      memory_id: first.memory_id,
      scope: { kind: "workspace", id: "workspace_local" },
      include_sensitive: false,
    });
    const governedExplain = await runtime(storage).memoryExplain({
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_corrected_explain",
        tool: "memory_explain",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [{ kind: "workspace", id: "workspace_local" }],
        purpose: "Explain the canonical governed memory",
        reason: "Prove explain uses the eligibility oracle",
        requested_at: AS_OF,
        safety_class: "read_only",
      },
      memory_id: first.memory_id,
      scope: { kind: "workspace", id: "workspace_local" },
      include_sensitive: false,
    });
    expect(governedGet).toMatchObject({
      status: "OK",
      data: {
        result: {
          memory_id: first.memory_id,
          revision_id: corrected.current_revision_id,
        },
      },
    });
    expect(governedExplain).toMatchObject({
      status: "OK",
      data: {
        result: {
          memory: {
            memory_id: first.memory_id,
            revision_id: corrected.current_revision_id,
          },
          evidence_ids: ["evidence_storage_1"],
        },
      },
    });
    const historicalReceipt = await storage.getReceipt({
      receipt_id: frozenReceiptId,
      principal_id: "user_local",
      scopes: [{ kind: "workspace", id: "workspace_local" }],
    });
    expect(historicalReceipt).toMatchObject({
      kind: "retrieval",
      items: [
        expect.objectContaining({
          revision_id: oldRevision,
          decision: "included",
        }),
      ],
    });

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    const projectedBeforeDrain = database
      .prepare(
        `SELECT revision_id FROM memory_fts
         WHERE memory_id = ? ORDER BY revision_id`,
      )
      .all(first.memory_id) as Array<{ revision_id: string }>;
    database.close();
    expect(projectedBeforeDrain).toEqual([{ revision_id: oldRevision }]);

    await storage.drainFtsOutbox();
    const afterDrain = await storage.searchGovernedMemory({
      query: "falsifiable conclusion verification evidence",
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      as_of: AS_OF,
      include_sensitive: false,
      context_scope: null,
      limit: 20,
    });
    expect(afterDrain.items[0]).toMatchObject({
      item: { revision_id: corrected.current_revision_id },
      lane: "memory_fts",
    });
    await storage.rebuildFts();
    const afterRebuild = await storage.searchGovernedMemory({
      query: "falsifiable conclusion verification evidence",
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      as_of: AS_OF,
      include_sensitive: false,
      context_scope: null,
      limit: 20,
    });
    expect(afterRebuild.items).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          revision_id: corrected.current_revision_id,
        }),
        lane: "memory_fts",
      }),
    ]);
    await storage.close();
  });

  it.each([
    ["working", "CANDIDATE_ONLY", "SOURCE_INACTIVE"],
    ["candidate", "CANDIDATE_ONLY", "SOURCE_INACTIVE"],
    ["superseded", "SUPERSEDED", "SOURCE_SUPERSEDED"],
    ["quarantined", "QUARANTINED", "SOURCE_INACTIVE"],
    ["revoked", "REVOKED", "SOURCE_REVOKED"],
    ["purged", "TOMBSTONED", "SOURCE_TOMBSTONED"],
  ] as const)(
    "returns a stable reason for %s lifecycle",
    async (lifecycle, reasonCode, sourceReasonCode) => {
      const dataRoot = temporaryRoot(`eligibility-${lifecycle}`);
      const storage = await SqliteStorageClient.open({ dataRoot });
      await storage.commitEpisode(inlineEpisode({}));
      const admitted = await storage.admitMemory({
        request: memoryProposal({
          candidate: memoryCandidate({
            scope: { kind: "workspace", id: "workspace_local" },
          }),
        }),
        evaluation: {
          decision: "activate",
          reason: "live exact-scope user-stated evidence is eligible",
        },
      });
      await storage.close();

      setLifecycle(
        dataRoot,
        admitted.memory_id,
        lifecycle,
        admitted.current_revision_id,
      );
      const reopened = await SqliteStorageClient.open({ dataRoot });
      const eligibility = await reopened.checkMemoryEligibility({
        memory_id: admitted.memory_id,
        revision_id: admitted.current_revision_id,
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        as_of: AS_OF,
        include_sensitive: false,
        context_scope: null,
      });
      expect(eligibility).toEqual({
        eligible: false,
        memory_id: admitted.memory_id,
        revision_id: admitted.current_revision_id,
        reason_code: reasonCode,
      });
      expect(
        (
          await reopened.validateProjectionSources({
            principal_id: "user_local",
            scope: { kind: "workspace", id: "workspace_local" },
            as_of: AS_OF,
            revision_ids: [admitted.current_revision_id],
          })
        ).results[0],
      ).toMatchObject({
        status: "ineligible",
        reason_code: sourceReasonCode,
      });
      await reopened.close();
    },
  );

  it.each([
    {
      name: "not-yet-valid",
      validFrom: "2026-07-28T12:00:00.000Z",
      validTo: null,
      reasonCode: "NOT_YET_VALID",
      asOf: "2026-07-28T11:59:59.000Z",
    },
    {
      name: "expired",
      validFrom: "2026-07-27T00:00:00.000Z",
      validTo: "2026-07-28T12:59:59.000Z",
      reasonCode: "EXPIRED",
      asOf: AS_OF,
    },
  ] as const)(
    "returns a stable reason for $name validity",
    async ({ name, validFrom, validTo, reasonCode, asOf }) => {
      const dataRoot = temporaryRoot(`eligibility-${name}`);
      const storage = await SqliteStorageClient.open({ dataRoot });
      await storage.commitEpisode(inlineEpisode({}));
      const admitted = await storage.admitMemory({
        request: memoryProposal({
          candidate: memoryCandidate({
            scope: { kind: "workspace", id: "workspace_local" },
            validFrom,
            validTo,
          }),
        }),
        evaluation: {
          decision: "activate",
          reason: "fixture activation; eligibility still checks validity",
        },
      });
      const eligibility = await storage.checkMemoryEligibility({
        memory_id: admitted.memory_id,
        revision_id: admitted.current_revision_id,
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        as_of: asOf,
        include_sensitive: false,
        context_scope: null,
      });
      expect(eligibility).toMatchObject({
        eligible: false,
        reason_code: reasonCode,
      });
      await storage.close();
    },
  );

  it("excludes an active revision while its logical key has an open conflict", async () => {
    const dataRoot = temporaryRoot("eligibility-conflict");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      }),
      evaluation: {
        decision: "activate",
        reason: "activate the canonical fixture",
      },
    });
    const conflict = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_conflicting_pref",
          scope: { kind: "workspace", id: "workspace_local" },
          text: "Always return exhaustive unverified prose.",
        }),
        idempotencyKey: "memory-conflict-eligibility-001",
        requestId: "request_conflict_eligibility",
      }),
      evaluation: {
        decision: "activate",
        reason: "conflicting content must not replace the pointer",
      },
    });
    expect(conflict.outcome).toBe("CONFLICT");
    const eligibility = await storage.checkMemoryEligibility({
      memory_id: admitted.memory_id,
      revision_id: admitted.current_revision_id,
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      as_of: AS_OF,
      include_sensitive: false,
      context_scope: null,
    });
    expect(eligibility).toMatchObject({
      eligible: false,
      reason_code: "OPEN_CONFLICT",
    });
    await storage.rebuildFts();
    await storage.close();
    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    const projectionCount = database
      .prepare(
        "SELECT count(*) AS count FROM memory_fts WHERE memory_id = ?",
      )
      .get(admitted.memory_id) as { count: number };
    database.close();
    expect(projectionCount.count).toBe(0);
  });

  it("honors the latest applicable usage block", async () => {
    const dataRoot = temporaryRoot("eligibility-usage");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      }),
      evaluation: { decision: "activate", reason: "activate the fixture" },
    });
    await storage.close();
    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    database
      .prepare(
        `INSERT INTO memory_usage_rules (
           usage_rule_id, memory_id, revision_id, effect,
           context_scope_kind, context_scope_id, principal_id,
           actor_authority, reason, occurred_at
         ) VALUES (?, ?, ?, 'block', 'workspace', 'workspace_local',
                   'user_local', 'user_stated', ?, ?)`,
      )
      .run(
        "usage_rule_block_context",
        admitted.memory_id,
        admitted.current_revision_id,
        "user disabled this memory in the workspace",
        "2026-07-28T12:30:00.000Z",
      );
    database.close();
    const reopened = await SqliteStorageClient.open({ dataRoot });
    const eligibility = await reopened.checkMemoryEligibility({
      memory_id: admitted.memory_id,
      revision_id: admitted.current_revision_id,
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      as_of: AS_OF,
      include_sensitive: false,
      context_scope: { kind: "workspace", id: "workspace_local" },
    });
    expect(eligibility).toMatchObject({
      eligible: false,
      reason_code: "USAGE_BLOCKED",
    });
    expect(
      (
        await reopened.validateProjectionSources({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
          as_of: AS_OF,
          context_scope: {
            kind: "workspace",
            id: "workspace_local",
          },
          revision_ids: [admitted.current_revision_id],
        })
      ).results[0],
    ).toMatchObject({
      status: "ineligible",
      reason_code: "SOURCE_USAGE_BLOCKED",
    });
    await reopened.close();
  });
});

function setLifecycle(
  dataRoot: string,
  memoryId: string,
  lifecycle:
    | "working"
    | "candidate"
    | "superseded"
    | "quarantined"
    | "revoked"
    | "purged",
  revisionId: string,
): void {
  const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
  database.exec("PRAGMA foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO governance_write_guard (singleton, operation, opened_at)
       VALUES (1, 'eligibility-fixture', ?)`,
    )
    .run(AS_OF);
  database
    .prepare(
      `UPDATE memory_objects
       SET lifecycle = ?, current_revision_id = ?, context_eligible = 0,
           updated_at = ?
       WHERE memory_id = ?`,
    )
    .run(
      lifecycle,
      lifecycle === "purged" ? null : revisionId,
      AS_OF,
      memoryId,
    );
  database.exec("DELETE FROM governance_write_guard WHERE singleton = 1");
  database.close();
}

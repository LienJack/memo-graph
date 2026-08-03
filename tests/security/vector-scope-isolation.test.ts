import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  VectorQueryResultSchema,
  VectorQuerySchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  LayeredLaneRetrievers,
  MemoryRuntime,
  RecallOrchestrator,
} from "../../packages/memory-kernel/src/index.js";
import {
  SemanticVectorRetriever,
  VectorRuntimeError,
  VectorScopeProjector,
} from "../../packages/vector-retrieval/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  revisionCommand,
} from "../helpers/governance-examples.js";
import {
  InMemoryVectorRuntimeFactory,
} from "../helpers/in-memory-vector-runtime.js";
import {
  seedLayeredProjectionSources,
} from "../helpers/projection-examples.js";
import {
  VECTOR_NOW,
  qualifiedVectorEpoch,
} from "../helpers/vector-examples.js";
import {
  VECTOR_RECALL_AS_OF,
  vectorLanePolicy,
} from "../helpers/governed-vector-harness.js";

const roots: string[] = [];
const LOCAL_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const FOREIGN_SCOPE = {
  kind: "workspace",
  id: "workspace_foreign",
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function fixture(options: { sensitive?: boolean } = {}) {
  const root = await mkdtemp(
    join(
      await realpath(tmpdir()),
      "memo-graph-vector-scope-isolation-",
    ),
  );
  roots.push(root);
  let storage = await SqliteStorageClient.open({ dataRoot: root });
  const local = await seedLayeredProjectionSources(storage, {
    prefix: "vector_local",
    scopeId: LOCAL_SCOPE.id,
  });
  const foreign = await seedLayeredProjectionSources(storage, {
    prefix: "vector_foreign",
    scopeId: FOREIGN_SCOPE.id,
  });
  const protectedRevisions: string[] = [];
  let secretRejected = false;
  if (options.sensitive) {
    const sensitiveSource = local[0];
    const secretSource = local[1];
    if (sensitiveSource === undefined || secretSource === undefined) {
      throw new Error("protected vector sources are missing");
    }
    await expect(
      storage.applyMemoryRevision(
        revisionCommand({
          memoryId: secretSource.memory_id,
          expectedRevisionId: secretSource.current_revision_id,
          candidate: memoryCandidate({
            candidateId: "candidate_vector_secret_isolation",
            logicalKey: "projection.vector_local_semantic_b",
            scope: LOCAL_SCOPE,
            sensitivity: "secret",
            text:
              "secret vector membership sentinel must stay encrypted",
            evidenceIds: ["evidence_vector_local_semantic_b"],
          }),
          idempotencyKey: "vector-secret-isolation-revision",
        }),
      ),
    ).rejects.toMatchObject({
      code: "ENCRYPTION_REQUIRED",
    });
    secretRejected = true;
    await storage.close();
    const sensitiveText =
      "sensitive vector membership sentinel must stay canonical only";
    const sensitiveContent = {
      storage: "inline",
      text: sensitiveText,
      media_type: "text/plain",
    } as const;
    // This fixture deliberately simulates a legacy sensitive row that
    // predates the current admission quarantine. The reader boundary must
    // remain safe even when canonical storage already contains such data.
    const database = new DatabaseSync(
      join(root, "ledger", "memory.db"),
    );
    database.exec("DROP TRIGGER memory_revisions_no_update");
    database.prepare(
      `UPDATE memory_revisions
       SET sensitivity = 'sensitive',
           content_inline = ?,
           content_hash = ?
       WHERE revision_id = ?`,
    ).run(
      sensitiveText,
      canonicalSha256(sensitiveContent),
      sensitiveSource.current_revision_id,
    );
    database.exec(`
      CREATE TRIGGER memory_revisions_no_update
      BEFORE UPDATE ON memory_revisions BEGIN
        SELECT RAISE(ABORT, 'APPEND_ONLY:memory_revisions');
      END
    `);
    database.close();
    storage = await SqliteStorageClient.open({ dataRoot: root });
    protectedRevisions.push(sensitiveSource.current_revision_id);
  }
  const epoch = qualifiedVectorEpoch();
  await storage.registerVectorEmbeddingEpoch({
    epoch,
    registered_at: VECTOR_NOW,
  });
  await storage.configureVectorProjection({
    mode: "evaluating",
    epoch_id: epoch.epoch_id,
    configured_at: VECTOR_NOW,
  });
  const vectorRuntime = new InMemoryVectorRuntimeFactory();
  const projector = new VectorScopeProjector({
    storage,
    dataRoot: root,
    modelRoot: join(root, "models"),
    epoch,
    runtimeFactory: vectorRuntime.runtimeFactory(),
  });
  const projected = await projector.drain({
    worker_id: "vector_scope_isolation_projector",
    claimed_at: "2026-07-29T06:00:01.000Z",
    lease_expires_at: "2026-07-29T06:01:00.000Z",
    completed_at: "2026-07-29T06:00:05.000Z",
    retry_at: "2026-07-29T06:01:05.000Z",
  });
  expect(projected).toMatchObject({
    claimed: 2,
    published: 2,
    failed: 0,
    stale: 0,
  });
  return {
    root,
    storage,
    local,
    foreign,
    protectedRevisions,
    secretRejected,
    epoch,
    vectorRuntime,
    projector,
  };
}

function retriever(options: {
  current: Awaited<ReturnType<typeof fixture>>;
  runtimeFactory?: ConstructorParameters<
    typeof SemanticVectorRetriever
  >[0]["runtimeFactory"];
}) {
  return new SemanticVectorRetriever({
    storage: options.current.storage,
    dataRoot: options.current.root,
    modelRoot: join(options.current.root, "models"),
    epoch: options.current.epoch,
    runtimeFactory:
      options.runtimeFactory ??
      options.current.vectorRuntime.queryRuntimeFactory(),
    allowEvaluating: true,
  });
}

function orchestrator(
  current: Awaited<ReturnType<typeof fixture>>,
  vectorRetriever: SemanticVectorRetriever,
) {
  const lanes = new LayeredLaneRetrievers(current.storage, {
    vectorRetriever,
  });
  return {
    lanes,
    recall: new RecallOrchestrator({
      storage: current.storage,
      retriever: lanes,
    }),
  };
}

describe("semantic vector scope and privacy isolation", () => {
  it("turns an adversarial foreign hit into opaque evidence in recall, Context, receipt, and telemetry", async () => {
    const current = await fixture();
    try {
      const foreign = current.foreign[0];
      if (foreign === undefined) {
        throw new Error("foreign vector fixture is missing");
      }
      const malicious = retriever({
        current,
        runtimeFactory: {
          open: async () => ({
            query: async (input) => {
              const query = VectorQuerySchema.parse(input);
              return VectorQueryResultSchema.parse({
                schema_version: "1.0.0",
                request_id: query.request_id,
                status: "complete",
                embedding_epoch_id: query.embedding_epoch_id,
                generation_id: query.generation_id,
                source_frontier_hash: query.source_frontier_hash,
                hits: [
                  {
                    revision_id: foreign.current_revision_id,
                    source_content_hash: `sha256:${"9".repeat(64)}`,
                    distance: 0.01,
                    rank: 1,
                  },
                ],
                complete: true,
                reason_codes: [],
              });
            },
            close: async () => undefined,
          }),
        },
      });
      const governed = orchestrator(current, malicious);
      const recalled = await governed.recall.recall({
        principal_id: "user_local",
        scope: LOCAL_SCOPE,
        query: "adversarial foreign vector hit",
        as_of: VECTOR_RECALL_AS_OF,
        include_sensitive: false,
        lane_policy: vectorLanePolicy(["semantic_vector"]),
      });
      expect(recalled.status).toBe("DEGRADED");
      expect(recalled.candidates).toEqual([]);
      expect(recalled.exclusions).toEqual([
        expect.objectContaining({
          lane: "semantic_vector",
          reason_code: "VECTOR_HIT_INELIGIBLE",
          memory_id: expect.stringMatching(/^vector-rejected-memory:/u),
          revision_id: expect.stringMatching(
            /^vector-rejected-revision:/u,
          ),
        }),
      ]);

      const runtime = new MemoryRuntime({
        storage: current.storage,
        clock: () => VECTOR_RECALL_AS_OF,
        policy: {
          principal: {
            principal_id: "user_local",
            allowed_scopes: [LOCAL_SCOPE],
            allowed_authorities: ["user_stated"],
            destructive_tools_enabled: false,
          },
          default_token_budget: 1_800,
          lane_policy: vectorLanePolicy(["semantic_vector"]),
        },
        laneRetriever: governed.lanes,
      });
      const compiled = await runtime.memoryContextCompile({
        envelope: {
          schema_version: "1.0.0",
          request_id: "request_vector_scope_isolation",
          tool: "memory_context_compile",
          safety_class: "read_only",
          actor_claim: {
            principal_id: "user_local",
            authority: "user_stated",
          },
          scopes: [LOCAL_SCOPE],
          purpose: "Prove foreign vector membership remains opaque",
          reason: "Compile only exact authorized scope",
          requested_at: VECTOR_RECALL_AS_OF,
        },
        recall: {
          schema_version: "1.0.0",
          request_id: "request_vector_scope_isolation",
          goal: "Restore local governed context",
          query: "adversarial foreign vector hit",
          scopes: [LOCAL_SCOPE],
          as_of: VECTOR_RECALL_AS_OF,
          token_budget: 1_800,
          include_sensitive: false,
        },
      });
      const rendered = JSON.stringify({ recalled, compiled });
      expect(rendered).not.toContain(foreign.current_revision_id);
      expect(rendered).not.toContain(FOREIGN_SCOPE.id);
      expect(rendered).not.toContain("vector_foreign");
      expect(rendered).not.toContain(
        "Agent memory must remain governed.",
      );
    } finally {
      await current.storage.close();
    }
  });

  it("keeps a published local scope queryable when a foreign scope changes", async () => {
    const current = await fixture();
    try {
      const foreign = current.foreign[0];
      if (foreign === undefined) {
        throw new Error("foreign correction fixture is missing");
      }
      await current.storage.applyMemoryRevision(
        revisionCommand({
          memoryId: foreign.memory_id,
          expectedRevisionId: foreign.current_revision_id,
          candidate: memoryCandidate({
            candidateId: "candidate_vector_foreign_corrected",
            logicalKey: "projection.vector_foreign_semantic_a",
            scope: FOREIGN_SCOPE,
            text: "Foreign correction must not degrade local vectors.",
            evidenceIds: ["evidence_vector_foreign_semantic_a"],
          }),
          idempotencyKey: "vector-foreign-correction-0001",
        }),
      );
      await expect(
        current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: FOREIGN_SCOPE,
        }),
      ).resolves.toMatchObject({ state: "pending" });
      await expect(
        current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: LOCAL_SCOPE,
        }),
      ).resolves.toMatchObject({ state: "published" });

      const governed = orchestrator(
        current,
        retriever({ current }),
      );
      const recalled = await governed.recall.recall({
        principal_id: "user_local",
        scope: LOCAL_SCOPE,
        query: "agent memory governed",
        as_of: VECTOR_RECALL_AS_OF,
        include_sensitive: false,
        lane_policy: vectorLanePolicy(["semantic_vector"]),
      });
      expect(recalled.status).toBe("OK");
      expect(recalled.candidates.length).toBeGreaterThan(0);
      expect(
        recalled.candidates.every(
          (candidate) =>
            candidate.kind === "memory" &&
            candidate.memory.scope.id === LOCAL_SCOPE.id,
        ),
      ).toBe(true);
      expect(JSON.stringify(recalled)).not.toContain(
        foreign.current_revision_id,
      );
    } finally {
      await current.storage.close();
    }
  });

  it("keeps runtime failure cooldown isolated to the failed exact scope", async () => {
    const current = await fixture();
    try {
      const base = current.vectorRuntime.queryRuntimeFactory();
      const shared = retriever({
        current,
        runtimeFactory: {
          open: async (input) =>
            input.scope.id === FOREIGN_SCOPE.id
              ? {
                  query: async () => {
                    throw new VectorRuntimeError("PROCESS_EXIT", {
                      retryable: true,
                    });
                  },
                  close: async () => undefined,
                }
              : base.open(input),
        },
      });
      const governed = orchestrator(current, shared);
      const foreign = await governed.recall.recall({
        principal_id: "user_local",
        scope: FOREIGN_SCOPE,
        query: "foreign scope runtime failure",
        as_of: VECTOR_RECALL_AS_OF,
        include_sensitive: false,
        lane_policy: vectorLanePolicy(["semantic_vector"]),
      });
      expect(foreign.status).toBe("DEGRADED");
      expect(
        foreign.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        reason_codes: ["VECTOR_PROCESS_EXIT"],
      });

      const local = await governed.recall.recall({
        principal_id: "user_local",
        scope: LOCAL_SCOPE,
        query: "agent memory governed",
        as_of: VECTOR_RECALL_AS_OF,
        include_sensitive: false,
        lane_policy: vectorLanePolicy(["semantic_vector"]),
      });
      expect(local.status).toBe("OK");
      expect(local.candidates.length).toBeGreaterThan(0);
      expect(
        local.candidates.every(
          (candidate) =>
            candidate.kind === "memory" &&
            candidate.memory.scope.id === LOCAL_SCOPE.id,
        ),
      ).toBe(true);
    } finally {
      await current.storage.close();
    }
  });

  it("never projects sensitive or secret membership while authorized sensitive L1 recall remains available", async () => {
    const current = await fixture({ sensitive: true });
    try {
      const localSnapshot = [...current.vectorRuntime.snapshots.values()]
        .find((snapshot) => snapshot.scope.id === LOCAL_SCOPE.id);
      if (localSnapshot === undefined) {
        throw new Error("local vector snapshot is missing");
      }
      expect(
        localSnapshot.records.map((record) => record.revision_id),
      ).not.toEqual(
        expect.arrayContaining(current.protectedRevisions),
      );
      expect(current.secretRejected).toBe(true);
      await current.storage.drainFtsOutbox();
      const governed = orchestrator(
        current,
        retriever({ current }),
      );
      const recent = await governed.recall.recall({
        principal_id: "user_local",
        scope: LOCAL_SCOPE,
        query: "sensitive vector membership sentinel",
        as_of: VECTOR_RECALL_AS_OF,
        include_sensitive: true,
        lane_policy: vectorLanePolicy(["recent_l1"]),
      });
      expect(
        recent.candidates.some(
          (candidate) =>
            candidate.kind === "memory" &&
            current.protectedRevisions.includes(
              candidate.memory.revision_id,
            ) &&
            candidate.memory.sensitivity === "sensitive",
        ),
      ).toBe(true);

      const semantic = await governed.recall.recall({
        principal_id: "user_local",
        scope: LOCAL_SCOPE,
        query: "sensitive vector membership sentinel",
        as_of: VECTOR_RECALL_AS_OF,
        include_sensitive: true,
        lane_policy: vectorLanePolicy(["semantic_vector"]),
      });
      const rendered = JSON.stringify(semantic);
      for (const protectedRevision of current.protectedRevisions) {
        expect(rendered).not.toContain(protectedRevision);
      }
      expect(rendered).not.toContain(
        "sensitive vector membership sentinel",
      );
      expect(rendered).not.toContain(
        "secret vector membership sentinel",
      );
    } finally {
      await current.storage.close();
    }
  });
});

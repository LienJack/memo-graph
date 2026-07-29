import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  ScopeSchema,
} from "../../packages/contracts/src/index.js";
import {
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import {
  VectorScopeProjector,
  vectorGenerationLayout,
} from "../../packages/vector-retrieval/src/index.js";
import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  InMemoryVectorRuntimeFactory,
} from "../helpers/in-memory-vector-runtime.js";
import {
  PURGE_NOW,
  deleteRequest,
} from "../helpers/purge-examples.js";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";
import {
  VECTOR_NOW,
  qualifiedVectorEpoch,
  VECTOR_SCOPE,
} from "../helpers/vector-examples.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("vector purge and source boundary", () => {
  it("lists only governed non-sensitive exact-scope sources for rebuild", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-vector-purge-"),
    );
    roots.push(root);
    const client = await SqliteStorageClient.open({ dataRoot: root });
    try {
      const sources = await seedProjectionSources(client);
      const sensitive = memoryCandidate({
        candidateId: "candidate_vector_sensitive_excluded",
        logicalKey: "projection.vector.sensitive",
        scope: VECTOR_SCOPE,
        sensitivity: "sensitive",
        text: "This sensitive passage must never enter the vector index.",
        evidenceIds: ["evidence_vector_sensitive_excluded"],
      });
      await client.commitEpisode(
        inlineEpisode({
          episodeId: "episode_vector_sensitive_excluded",
          evidenceId: "evidence_vector_sensitive_excluded",
          idempotencyKey: "commit:vector-sensitive:0001",
          text: "Sensitive source evidence.",
        }),
      );
      const admittedSensitive = await client.admitMemory({
        request: memoryProposal({
          candidate: sensitive,
          idempotencyKey: "memory-vector-sensitive-0001",
          requestId: "request_vector_sensitive",
        }),
        evaluation: {
          decision: "quarantine",
          reason: "Prove projection sensitivity exclusion.",
        },
      });
      const epoch = qualifiedVectorEpoch();
      await client.registerVectorEmbeddingEpoch({
        epoch,
        registered_at: VECTOR_NOW,
      });
      await client.configureVectorProjection({
        mode: "evaluating",
        epoch_id: epoch.epoch_id,
        configured_at: VECTOR_NOW,
      });
      const listed = await client.listProjectionSources({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        as_of: VECTOR_NOW,
        include_sensitive: false,
        context_scope: null,
        limit: 1_000,
      });
      expect(listed.items.map((item) => item.revision_id).sort()).toEqual(
        sources.map((source) => source.revision_id).sort(),
      );
      expect(
        listed.items.every((item) =>
          !["sensitive", "secret"].includes(item.sensitivity)
        ),
      ).toBe(true);
      expect(
        listed.items.some((item) =>
          item.revision_id === admittedSensitive.current_revision_id
        ),
      ).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("replaces the exact scope after purge and removes every obsolete generation", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-vector-purge-files-"),
    );
    roots.push(root);
    const client = await SqliteStorageClient.open({ dataRoot: root });
    const modelSentinel = join(root, "model-snapshot.keep");
    await writeFile(modelSentinel, "operator model material", "utf8");
    try {
      const sources = await seedProjectionSources(client);
      const epoch = qualifiedVectorEpoch();
      await client.registerVectorEmbeddingEpoch({
        epoch,
        registered_at: VECTOR_NOW,
      });
      await client.configureVectorProjection({
        mode: "evaluating",
        epoch_id: epoch.epoch_id,
        configured_at: VECTOR_NOW,
      });
      const runtimeFactory = new InMemoryVectorRuntimeFactory();
      const projector = new VectorScopeProjector({
        storage: client,
        dataRoot: root,
        modelRoot: join(root, "models"),
        epoch,
        runtimeFactory: runtimeFactory.runtimeFactory(),
      });
      await projector.drain({
        worker_id: "vector_purge_initial",
        claimed_at: "2026-07-29T06:00:01.000Z",
        lease_expires_at: "2026-07-29T06:01:00.000Z",
        completed_at: "2026-07-29T06:00:05.000Z",
        retry_at: "2026-07-29T06:01:05.000Z",
      });
      const before = await client.vectorProjectionCheckpoint({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
      });
      const oldLayout = await vectorGenerationLayout({
        dataRoot: root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: epoch.epoch_id,
        generationId: before.desired_generation_id,
      });

      const approvals = new TestApprovalRegistry();
      const kernel = new MemoryRuntime({
        storage: client,
        approvalRegistry: approvals,
        clock: () => PURGE_NOW,
        policy: {
          principal: {
            principal_id: "user_local",
            allowed_scopes: [
              ScopeSchema.parse(VECTOR_SCOPE),
            ],
            allowed_authorities: ["user_stated"],
            destructive_tools_enabled: true,
          },
          default_token_budget: 1_800,
        },
      });
      const source = sources[0];
      const request = deleteRequest({
        memoryId: source.memory_id,
        revisionId: source.revision_id,
        idempotencyKey: "vector-delete-purge-0001",
        approvalId: "approval_vector_delete_purge",
      });
      approvals.approve(request);
      const deleted = await kernel.memoryDelete(request);
      expect(deleted.status).toBe("OK");
      if (deleted.status !== "OK") {
        throw new Error("vector purge fixture deletion failed");
      }
      const purgeJobId = (
        deleted.data as { purge_job_id: string }
      ).purge_job_id;
      await expect(
        client.runPurge({ purge_job_id: purgeJobId }),
      ).resolves.toMatchObject({
        completed: true,
        residual_hashes: [],
      });
      const rebuilt = await projector.drain({
        worker_id: "vector_purge_replacement",
        claimed_at: "2026-07-29T06:02:01.000Z",
        lease_expires_at: "2026-07-29T06:03:00.000Z",
        completed_at: "2026-07-29T06:02:05.000Z",
        retry_at: "2026-07-29T06:03:05.000Z",
      });
      expect(rebuilt).toMatchObject({
        claimed: 1,
        published: 1,
        stale: 0,
        failed: 0,
      });
      const after = await client.vectorProjectionCheckpoint({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
      });
      expect(after.desired_generation_id).not.toBe(
        before.desired_generation_id,
      );
      const newLayout = await vectorGenerationLayout({
        dataRoot: root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: epoch.epoch_id,
        generationId: after.desired_generation_id,
      });
      await expect(access(oldLayout.activeRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const replacement = await readFile(
        join(newLayout.activeRoot, "vector.snapshot.json"),
        "utf8",
      );
      expect(replacement).not.toContain(source.revision_id);
      expect(replacement).not.toContain(
        "SQLite is the canonical memory authority.",
      );
      await expect(access(modelSentinel)).resolves.toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

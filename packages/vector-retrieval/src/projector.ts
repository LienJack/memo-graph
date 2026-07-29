import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  IdentifierSchema,
  ScopeSchema,
  VectorEmbeddingEpochSchema,
  VectorProjectionReceiptSchema,
  VectorScopeCheckpointSchema,
  buildVectorScopeSnapshot,
  canonicalJson,
  canonicalSha256,
  type Scope,
  type VectorEmbeddingEpoch,
  type VectorFailureCategory,
  type VectorProjectionReceipt,
  type VectorScopeCheckpoint,
  type VectorScopeSnapshot,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  VectorProcessHost,
  VectorRuntimeError,
} from "./process-host.js";

const ProjectionJobSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    job_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    reason: z.enum([
      "enable",
      "canonical_change",
      "temporal_transition",
      "epoch_change",
      "purge",
      "rebuild",
      "recovery",
    ]),
    desired_epoch_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    desired_generation_id: IdentifierSchema,
    source_frontier_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    attempt: z.number().int().nonnegative(),
    lease_id: IdentifierSchema.nullable(),
    lease_expires_at: z.string().datetime({ offset: true }).nullable(),
  })
  .passthrough();

const ProjectionSourceSchema = z
  .object({
    revision_id: IdentifierSchema,
    sensitivity: z.enum([
      "public",
      "internal",
      "personal",
      "sensitive",
      "secret",
    ]),
    content: z
      .object({
        storage: z.literal("inline"),
        text: z.string().trim().min(1).max(20_000),
      })
      .passthrough(),
    content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .passthrough();

const ProjectionSourceListSchema = z
  .object({
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    items: z.array(ProjectionSourceSchema).max(100_000),
  })
  .strict();

export type VectorProjectionJob = z.infer<
  typeof ProjectionJobSchema
>;

export type VectorProjectionStorage = {
  claimVectorProjectionJobs(input: {
    worker_id: string;
    claimed_at: string;
    lease_expires_at: string;
    limit: number;
  }): Promise<{ jobs: unknown[] }>;
  vectorProjectionCheckpoint(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<VectorScopeCheckpoint>;
  listProjectionSources(input: {
    principal_id: string;
    scope: Scope;
    as_of: string;
    include_sensitive: false;
    context_scope: null;
    limit: number;
  }): Promise<unknown>;
  applyVectorProjectionJob(input: {
    job_id: string;
    worker_id: string;
    lease_token: string;
    receipt: VectorProjectionReceipt;
  }): Promise<unknown>;
  staleVectorProjectionJob(input: {
    job_id: string;
    worker_id: string;
    lease_token: string;
    receipt: VectorProjectionReceipt;
  }): Promise<unknown>;
  failVectorProjectionJob(input: {
    job_id: string;
    worker_id: string;
    lease_token: string;
    retry_at: string;
    receipt: VectorProjectionReceipt;
  }): Promise<unknown>;
};

export type VectorProjectionRuntime = {
  embedPassages(passages: readonly string[]): Promise<number[][]>;
  replaceScope(snapshot: VectorScopeSnapshot): Promise<VectorScopeSnapshot>;
  readScopeSnapshot(): Promise<VectorScopeSnapshot | null>;
  close(): Promise<void>;
};

export type VectorProjectionRuntimeFactory = {
  open(input: {
    dataRoot: string;
    modelRoot: string;
    principalId: string;
    scope: Scope;
    expectedEpoch: VectorEmbeddingEpoch;
  }): Promise<VectorProjectionRuntime>;
};

export type VectorGenerationLayout = {
  vectorRoot: string;
  scopeKey: string;
  epochKey: string;
  generationKey: string;
  generationRoot: string;
  quarantineRoot: string;
  activeRoot: string;
};

export type VectorProjectionOutcome = {
  job_id: string;
  status: "published" | "stale" | "failed";
  generation_id: string;
  logical_digest: string | null;
  failure_category: VectorFailureCategory | null;
};

export type VectorProjectionDrainResult = {
  claimed: number;
  published: number;
  stale: number;
  failed: number;
  outcomes: VectorProjectionOutcome[];
};

function assertContained(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new VectorRuntimeError("PROTOCOL_INVALID");
  }
}

async function ensureDirectory(path: string, root: string): Promise<string> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new VectorRuntimeError("PROTOCOL_INVALID");
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  await mkdir(path, { recursive: true });
  const canonical = await realpath(path);
  assertContained(root, canonical);
  return canonical;
}

function digestSegment(input: unknown): string {
  return canonicalSha256(input).slice("sha256:".length);
}

export async function vectorGenerationLayout(input: {
  dataRoot: string;
  principalId: string;
  scope: z.input<typeof ScopeSchema>;
  epochId: string;
  generationId: string;
}): Promise<VectorGenerationLayout> {
  const requestedRoot = resolve(input.dataRoot);
  try {
    if ((await lstat(requestedRoot)).isSymbolicLink()) {
      throw new VectorRuntimeError("PROTOCOL_INVALID");
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const scope = ScopeSchema.parse(input.scope);
  const principalId = IdentifierSchema.parse(input.principalId);
  const epochId = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
    .parse(input.epochId);
  const generationId = IdentifierSchema.parse(input.generationId);
  const vectorRoot = await ensureDirectory(
    join(root, "derived", "vector", "generations"),
    root,
  );
  const scopeKey = digestSegment({
    namespace: canonicalSha256({ data_root: root }),
    principal_id: principalId,
    scope,
  });
  const epochKey = digestSegment({ embedding_epoch_id: epochId });
  const generationKey = digestSegment({
    generation_id: generationId,
  });
  const generationRoot = await ensureDirectory(
    join(vectorRoot, scopeKey, epochKey, generationKey),
    root,
  );
  return {
    vectorRoot,
    scopeKey,
    epochKey,
    generationKey,
    generationRoot,
    quarantineRoot: join(generationRoot, "quarantine"),
    activeRoot: join(generationRoot, "active"),
  };
}

export async function activeVectorGenerationRoot(input: {
  dataRoot: string;
  principalId: string;
  scope: z.input<typeof ScopeSchema>;
  epochId: string;
  generationId: string;
}): Promise<string> {
  const layout = await vectorGenerationLayout(input);
  try {
    const active = await lstat(layout.activeRoot);
    if (active.isSymbolicLink() || !active.isDirectory()) {
      throw new VectorRuntimeError("PROTOCOL_INVALID");
    }
    const canonical = await realpath(layout.activeRoot);
    assertContained(layout.vectorRoot, canonical);
    return canonical;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new VectorRuntimeError("INDEX_MISSING");
    }
    throw error;
  }
}

async function removeGenerationPath(
  vectorRoot: string,
  path: string,
): Promise<void> {
  assertContained(vectorRoot, path);
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new VectorRuntimeError("PROTOCOL_INVALID");
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  await rm(path, { recursive: true, force: true });
}

function sourceSetDigest(
  sourceList: z.infer<typeof ProjectionSourceListSchema>,
): string {
  return canonicalSha256({
    ledger_epoch: sourceList.ledger_epoch,
    tombstone_epoch: sourceList.tombstone_epoch,
    sources: sourceList.items
      .map((item) => ({
        revision_id: item.revision_id,
        content_hash: item.content_hash,
      }))
      .sort((left, right) =>
        left.revision_id.localeCompare(right.revision_id)
      ),
  });
}

function receipt(input: {
  job: VectorProjectionJob;
  receiptId: string;
  outcome: "published" | "stale" | "failed";
  logicalDigest: string | null;
  failureCategory: VectorFailureCategory | null;
  reasonCodes: string[];
  createdAt: string;
}): VectorProjectionReceipt {
  const body = {
    schema_version: "1.0.0" as const,
    receipt_id: input.receiptId,
    job_id: input.job.job_id,
    principal_id: input.job.principal_id,
    scope: input.job.scope,
    embedding_epoch_id: input.job.desired_epoch_id,
    generation_id: input.job.desired_generation_id,
    source_frontier_hash: input.job.source_frontier_hash,
    logical_digest: input.logicalDigest,
    outcome: input.outcome,
    failure_category: input.failureCategory,
    reason_codes: input.reasonCodes,
    created_at: input.createdAt,
  };
  return VectorProjectionReceiptSchema.parse({
    ...body,
    receipt_hash: canonicalSha256(body),
  });
}

function failureCategory(error: unknown): VectorFailureCategory {
  return error instanceof VectorRuntimeError
    ? error.category
    : "INDEX_CORRUPT";
}

const defaultRuntimeFactory: VectorProjectionRuntimeFactory = {
  open: (input) => VectorProcessHost.open(input),
};

export class VectorScopeProjector {
  readonly #storage: VectorProjectionStorage;
  readonly #dataRoot: string;
  readonly #modelRoot: string;
  readonly #epoch: VectorEmbeddingEpoch;
  readonly #runtimeFactory: VectorProjectionRuntimeFactory;
  readonly #batchSize: number;

  constructor(input: {
    storage: VectorProjectionStorage;
    dataRoot: string;
    modelRoot: string;
    epoch: VectorEmbeddingEpoch;
    runtimeFactory?: VectorProjectionRuntimeFactory;
    batchSize?: number;
  }) {
    this.#storage = input.storage;
    this.#dataRoot = input.dataRoot;
    this.#modelRoot = input.modelRoot;
    this.#epoch = VectorEmbeddingEpochSchema.parse(input.epoch);
    this.#runtimeFactory =
      input.runtimeFactory ?? defaultRuntimeFactory;
    this.#batchSize = z.number().int().min(1).max(32)
      .parse(input.batchSize ?? 16);
  }

  async drain(input: {
    worker_id: string;
    claimed_at: string;
    lease_expires_at: string;
    completed_at: string;
    retry_at: string;
    limit?: number;
  }): Promise<VectorProjectionDrainResult> {
    const workerId = IdentifierSchema.parse(input.worker_id);
    const claimed = await this.#storage.claimVectorProjectionJobs({
      worker_id: workerId,
      claimed_at: input.claimed_at,
      lease_expires_at: input.lease_expires_at,
      limit: z.number().int().min(1).max(100).parse(input.limit ?? 10),
    });
    const jobs = ProjectionJobSchema.array().parse(claimed.jobs);
    const outcomes: VectorProjectionOutcome[] = [];
    for (const job of jobs) {
      outcomes.push(
        await this.#project({
          job,
          workerId,
          asOf: input.claimed_at,
          completedAt: input.completed_at,
          retryAt: input.retry_at,
        }),
      );
    }
    return {
      claimed: jobs.length,
      published: outcomes.filter(
        (outcome) => outcome.status === "published",
      ).length,
      stale: outcomes.filter(
        (outcome) => outcome.status === "stale",
      ).length,
      failed: outcomes.filter(
        (outcome) => outcome.status === "failed",
      ).length,
      outcomes,
    };
  }

  async #project(input: {
    job: VectorProjectionJob;
    workerId: string;
    asOf: string;
    completedAt: string;
    retryAt: string;
  }): Promise<VectorProjectionOutcome> {
    const { job } = input;
    if (
      job.lease_id === null ||
      job.desired_epoch_id !== this.#epoch.epoch_id
    ) {
      return this.#fail(
        input,
        job.desired_epoch_id === this.#epoch.epoch_id
          ? "PROTOCOL_INVALID"
          : "EPOCH_STALE",
      );
    }
    const starting = VectorScopeCheckpointSchema.parse(
      await this.#storage.vectorProjectionCheckpoint({
        principal_id: job.principal_id,
        scope: job.scope,
      }),
    );
    if (
      starting.desired_epoch_id !== job.desired_epoch_id ||
      starting.desired_generation_id !==
        job.desired_generation_id ||
      starting.frontier.source_frontier_hash !==
        job.source_frontier_hash ||
      starting.state !== "building"
    ) {
      return this.#stale(input);
    }
    const layout = await vectorGenerationLayout({
      dataRoot: this.#dataRoot,
      principalId: job.principal_id,
      scope: job.scope,
      epochId: job.desired_epoch_id,
      generationId: job.desired_generation_id,
    });
    await removeGenerationPath(
      layout.vectorRoot,
      layout.generationRoot,
    );
    await mkdir(layout.quarantineRoot, { recursive: true });
    let runtime: VectorProjectionRuntime | null = null;
    let publishedPath = false;
    try {
      const before = ProjectionSourceListSchema.parse(
        await this.#storage.listProjectionSources({
          principal_id: job.principal_id,
          scope: job.scope,
          as_of: input.asOf,
          include_sensitive: false,
          context_scope: null,
          limit: 100_000,
        }),
      );
      if (
        before.ledger_epoch !== starting.frontier.ledger_epoch ||
        before.tombstone_epoch !==
          starting.frontier.tombstone_epoch ||
        before.items.some((item) =>
          item.sensitivity === "sensitive" ||
          item.sensitivity === "secret"
        )
      ) {
        return await this.#stale(input);
      }
      runtime = await this.#runtimeFactory.open({
        dataRoot: layout.quarantineRoot,
        modelRoot: this.#modelRoot,
        principalId: job.principal_id,
        scope: job.scope,
        expectedEpoch: this.#epoch,
      });
      const vectors: number[][] = [];
      for (
        let offset = 0;
        offset < before.items.length;
        offset += this.#batchSize
      ) {
        const batch = before.items.slice(
          offset,
          offset + this.#batchSize,
        );
        vectors.push(
          ...await runtime.embedPassages(
            batch.map((item) => item.content.text),
          ),
        );
      }
      const snapshot = buildVectorScopeSnapshot({
        schema_version: "1.0.0",
        principal_id: job.principal_id,
        scope: job.scope,
        embedding_epoch_id: job.desired_epoch_id,
        generation_id: job.desired_generation_id,
        frontier: starting.frontier,
        records: before.items.map((item, index) => ({
          schema_version: "1.0.0",
          revision_id: item.revision_id,
          source_content_hash: item.content_hash,
          vector: vectors[index] ?? [],
        })),
      });
      await runtime.replaceScope(snapshot);
      const verified = await runtime.readScopeSnapshot();
      if (
        verified === null ||
        canonicalJson(verified) !== canonicalJson(snapshot)
      ) {
        throw new VectorRuntimeError("INDEX_CORRUPT");
      }
      await runtime.close();
      runtime = null;
      const [ending, endingCheckpoint] = await Promise.all([
        this.#storage.listProjectionSources({
          principal_id: job.principal_id,
          scope: job.scope,
          as_of: input.asOf,
          include_sensitive: false,
          context_scope: null,
          limit: 100_000,
        }),
        this.#storage.vectorProjectionCheckpoint({
          principal_id: job.principal_id,
          scope: job.scope,
        }),
      ]);
      const after = ProjectionSourceListSchema.parse(ending);
      const checkpoint =
        VectorScopeCheckpointSchema.parse(endingCheckpoint);
      if (
        sourceSetDigest(after) !== sourceSetDigest(before) ||
        after.ledger_epoch !== before.ledger_epoch ||
        after.tombstone_epoch !== before.tombstone_epoch ||
        checkpoint.desired_epoch_id !== job.desired_epoch_id ||
        checkpoint.desired_generation_id !==
          job.desired_generation_id ||
        checkpoint.frontier.source_frontier_hash !==
          job.source_frontier_hash ||
        checkpoint.state !== "building"
      ) {
        return await this.#stale(input);
      }
      await rename(layout.quarantineRoot, layout.activeRoot);
      publishedPath = true;
      const appliedReceipt = receipt({
        job,
        receiptId: `vector-receipt:${digestSegment({
          job_id: job.job_id,
          outcome: "published",
          logical_digest: snapshot.logical_digest,
        }).slice(0, 46)}`,
        outcome: "published",
        logicalDigest: snapshot.logical_digest,
        failureCategory: null,
        reasonCodes: [
          job.reason === "purge"
            ? "VECTOR_PURGE_REPLACEMENT_PUBLISHED"
            : "VECTOR_SCOPE_PUBLISHED",
        ],
        createdAt: input.completedAt,
      });
      await this.#storage.applyVectorProjectionJob({
        job_id: job.job_id,
        worker_id: input.workerId,
        lease_token: job.lease_id,
        receipt: appliedReceipt,
      });
      if (
        starting.active_generation_id !== null &&
        starting.active_epoch_id !== null &&
        (
          starting.active_generation_id !==
            job.desired_generation_id ||
          starting.active_epoch_id !== job.desired_epoch_id
        )
      ) {
        const prior = await vectorGenerationLayout({
          dataRoot: this.#dataRoot,
          principalId: job.principal_id,
          scope: job.scope,
          epochId: starting.active_epoch_id,
          generationId: starting.active_generation_id,
        });
        await removeGenerationPath(
          prior.vectorRoot,
          prior.generationRoot,
        );
      }
      return {
        job_id: job.job_id,
        status: "published",
        generation_id: job.desired_generation_id,
        logical_digest: snapshot.logical_digest,
        failure_category: null,
      };
    } catch (error) {
      if (publishedPath) {
        await removeGenerationPath(
          layout.vectorRoot,
          layout.activeRoot,
        );
        try {
          return await this.#stale(input);
        } catch {
          // Fall through to a typed failure if the job was not made stale.
        }
      }
      return this.#fail(input, failureCategory(error));
    } finally {
      await runtime?.close().catch(() => undefined);
      await removeGenerationPath(
        layout.vectorRoot,
        layout.quarantineRoot,
      ).catch(() => undefined);
    }
  }

  async #stale(input: {
    job: VectorProjectionJob;
    workerId: string;
    completedAt: string;
  }): Promise<VectorProjectionOutcome> {
    if (input.job.lease_id === null) {
      return {
        job_id: input.job.job_id,
        status: "failed",
        generation_id: input.job.desired_generation_id,
        logical_digest: null,
        failure_category: "PROTOCOL_INVALID",
      };
    }
    const staleReceipt = receipt({
      job: input.job,
      receiptId: `vector-receipt:${digestSegment({
        job_id: input.job.job_id,
        outcome: "stale",
      }).slice(0, 46)}`,
      outcome: "stale",
      logicalDigest: null,
      failureCategory: null,
      reasonCodes: ["VECTOR_FRONTIER_STALE"],
      createdAt: input.completedAt,
    });
    await this.#storage.staleVectorProjectionJob({
      job_id: input.job.job_id,
      worker_id: input.workerId,
      lease_token: input.job.lease_id,
      receipt: staleReceipt,
    });
    return {
      job_id: input.job.job_id,
      status: "stale",
      generation_id: input.job.desired_generation_id,
      logical_digest: null,
      failure_category: "FRONTIER_STALE",
    };
  }

  async #fail(
    input: {
      job: VectorProjectionJob;
      workerId: string;
      completedAt: string;
      retryAt: string;
    },
    category: VectorFailureCategory,
  ): Promise<VectorProjectionOutcome> {
    if (input.job.lease_id !== null) {
      const failureReceipt = receipt({
        job: input.job,
        receiptId: `vector-receipt:${digestSegment({
          job_id: input.job.job_id,
          outcome: "failed",
          category,
          attempt: input.job.attempt,
        }).slice(0, 46)}`,
        outcome: "failed",
        logicalDigest: null,
        failureCategory: category,
        reasonCodes: [`VECTOR_${category}`],
        createdAt: input.completedAt,
      });
      await this.#storage.failVectorProjectionJob({
        job_id: input.job.job_id,
        worker_id: input.workerId,
        lease_token: input.job.lease_id,
        retry_at: input.retryAt,
        receipt: failureReceipt,
      });
    }
    return {
      job_id: input.job.job_id,
      status: "failed",
      generation_id: input.job.desired_generation_id,
      logical_digest: null,
      failure_category: category,
    };
  }
}

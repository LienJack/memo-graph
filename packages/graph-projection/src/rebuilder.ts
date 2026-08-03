import {
  canonicalJson,
  canonicalSha256,
  type GraphBackendIdentity,
  type GraphScopeSnapshot,
} from "@memo-graph/contracts";
import type {
  GraphProjectionOutboxJob,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import { z } from "zod";

import {
  graphGlobalLogicalDigest,
  normalizeGraphScopeSnapshots,
} from "./logical-digest.js";
import {
  publishGraphGeneration,
  quarantineGraphGeneration,
  type GraphActiveGenerationManifest,
} from "./path-security.js";
import {
  ExactScopeGraphProjector,
} from "./projector.js";
import {
  GraphProcessHost,
  type GraphProcessHostOptions,
} from "./process-host.js";
import type { GraphStore } from "./graph-store.js";

const RebuildOptionsSchema = z
  .object({
    worker_id: z.string().trim().min(1).max(200),
    lease_ms: z.number().int().min(1_000).max(15 * 60_000),
    claim_limit: z.number().int().min(1).max(100),
  })
  .strict();

export type GraphRebuildStorage = Pick<
  SqliteStorageClient,
  | "listGraphProjectionSnapshots"
  | "resetGraphProjectionScopes"
  | "markGraphRestoreUnavailable"
  | "claimGraphProjectionJobs"
  | "graphProjectionCheckpoint"
  | "graphScopeSnapshot"
  | "applyGraphProjectionJob"
  | "failGraphProjectionJob"
>;

export type GraphRebuildResult = {
  generation_id: string;
  global_logical_digest: ReturnType<typeof canonicalSha256>;
  scope_count: number;
  receipt_ids: string[];
  manifest: GraphActiveGenerationManifest;
  store: GraphStore;
};

function generationId(options: {
  rebuiltAt: string;
  globalLogicalDigest: string;
}): string {
  return `graph-${canonicalSha256({
    rebuilt_at: options.rebuiltAt,
    global_logical_digest: options.globalLogicalDigest,
  }).slice("sha256:".length, 39)}`;
}

function sameSnapshots(
  left: readonly GraphScopeSnapshot[],
  right: readonly GraphScopeSnapshot[],
): boolean {
  return canonicalJson(normalizeGraphScopeSnapshots(left)) ===
    canonicalJson(normalizeGraphScopeSnapshots(right));
}

export class DeterministicGraphRebuilder {
  readonly #storage: GraphRebuildStorage;
  readonly #dataRoot: string;
  readonly #identity: GraphBackendIdentity;
  readonly #options: z.infer<typeof RebuildOptionsSchema>;
  readonly #clock: () => Date;
  readonly #hostOptions: Omit<
    GraphProcessHostOptions,
    "dataRoot" | "expectedIdentity" | "generationId"
  >;

  constructor(options: {
    storage: GraphRebuildStorage;
    dataRoot: string;
    expectedIdentity: GraphBackendIdentity;
    workerId: string;
    leaseMs?: number;
    claimLimit?: number;
    clock?: () => Date;
    hostOptions?: Omit<
      GraphProcessHostOptions,
      "dataRoot" | "expectedIdentity" | "generationId"
    >;
  }) {
    this.#storage = options.storage;
    this.#dataRoot = options.dataRoot;
    this.#identity = options.expectedIdentity;
    this.#options = RebuildOptionsSchema.parse({
      worker_id: options.workerId,
      lease_ms: options.leaseMs ?? 10 * 60_000,
      claim_limit: options.claimLimit ?? 100,
    });
    this.#clock = options.clock ?? (() => new Date());
    this.#hostOptions = options.hostOptions ?? {};
  }

  async rebuild(options: {
    previousStore?: GraphStore;
  } = {}): Promise<GraphRebuildResult> {
    const rebuiltAt = this.#clock().toISOString();
    const source = normalizeGraphScopeSnapshots(
      (await this.#storage.listGraphProjectionSnapshots()).snapshots,
    );
    const globalLogicalDigest = graphGlobalLogicalDigest(source);
    const nextGeneration = generationId({
      rebuiltAt,
      globalLogicalDigest,
    });
    let target: GraphProcessHost | null = null;
    let published = false;
    let phase = "reset";
    try {
      if (source.length > 0) {
        await this.#storage.resetGraphProjectionScopes({
          backend: "ladybugdb",
          scopes: source.map((snapshot) => ({
            principal_id: snapshot.principal_id,
            scope: snapshot.scope,
          })),
          mode: "rebuilding",
          reset_at: rebuiltAt,
        });
      }
      phase = "open_target";
      target = await GraphProcessHost.open({
        dataRoot: this.#dataRoot,
        expectedIdentity: this.#identity,
        generationId: nextGeneration,
        ...this.#hostOptions,
      });
      phase = "write_target";
      for (const snapshot of source) {
        const written = await target.replaceScope(snapshot);
        if (canonicalJson(written) !== canonicalJson(snapshot)) {
          throw new Error("graph rebuild scope digest mismatch");
        }
      }
      phase = "verify_target";
      await this.#verifyStore(target, source, globalLogicalDigest);
      phase = "close_target";
      await target.close();
      phase = "reopen_target";
      target = await GraphProcessHost.open({
        dataRoot: this.#dataRoot,
        expectedIdentity: this.#identity,
        generationId: nextGeneration,
        ...this.#hostOptions,
      });
      phase = "verify_reopened_target";
      await this.#verifyStore(target, source, globalLogicalDigest);
      phase = "recheck_sqlite";
      const current = normalizeGraphScopeSnapshots(
        (await this.#storage.listGraphProjectionSnapshots()).snapshots,
      );
      if (
        !sameSnapshots(source, current) ||
        graphGlobalLogicalDigest(current) !== globalLogicalDigest
      ) {
        throw new Error("canonical graph rebuild frontier changed");
      }

      phase = "close_previous";
      await options.previousStore?.close();
      await target.close();
      target = null;
      phase = "publish_generation";
      const manifest = await publishGraphGeneration({
        dataRoot: this.#dataRoot,
        generationId: nextGeneration,
        globalLogicalDigest,
        publishedAt: this.#clock().toISOString(),
      });
      published = true;
      phase = "open_active_generation";
      const active = await GraphProcessHost.open({
        dataRoot: this.#dataRoot,
        expectedIdentity: this.#identity,
        ...this.#hostOptions,
      });
      try {
        phase = "verify_active_generation";
        await this.#verifyStore(active, source, globalLogicalDigest);
        phase = "publish_sqlite_checkpoints";
        const receiptIds = source.length === 0
          ? []
          : await this.#publishCheckpoints(active, source.length);
        return {
          generation_id: nextGeneration,
          global_logical_digest: globalLogicalDigest,
          scope_count: source.length,
          receipt_ids: receiptIds,
          manifest,
          store: active,
        };
      } catch (error) {
        await active.close();
        throw error;
      }
    } catch (error) {
      await target?.close().catch(() => undefined);
      await this.#storage.markGraphRestoreUnavailable({
        restored_at: this.#clock().toISOString(),
      }).catch(() => undefined);
      if (!published) {
        await quarantineGraphGeneration({
          dataRoot: this.#dataRoot,
          generationId: nextGeneration,
          reasonCode: "GRAPH_DIGEST_MISMATCH",
        }).catch(() => undefined);
      }
      throw new Error(`graph rebuild failed during ${phase}`, {
        cause: error,
      });
    }
  }

  async #verifyStore(
    store: GraphStore,
    expected: readonly GraphScopeSnapshot[],
    expectedGlobalDigest: string,
  ): Promise<void> {
    const actual: GraphScopeSnapshot[] = [];
    for (const snapshot of expected) {
      const readBack = await store.readScopeSnapshot({
        principal_id: snapshot.principal_id,
        scope: snapshot.scope,
      });
      if (readBack === null) {
        throw new Error("graph rebuild scope is missing");
      }
      actual.push(readBack);
    }
    if (
      !sameSnapshots(expected, actual) ||
      graphGlobalLogicalDigest(actual) !== expectedGlobalDigest
    ) {
      throw new Error("graph rebuild logical digest mismatch");
    }
  }

  async #publishCheckpoints(
    store: GraphStore,
    expectedScopes: number,
  ): Promise<string[]> {
    const projector = new ExactScopeGraphProjector({
      storage: this.#storage,
      store,
      workerId: this.#options.worker_id,
      leaseMs: this.#options.lease_ms,
      claimLimit: this.#options.claim_limit,
      maxJobsPerDrain: expectedScopes,
      clock: this.#clock,
    });
    const receipts: string[] = [];
    const visited = new Set<string>();
    while (visited.size < expectedScopes) {
      const jobs = await projector.claim(["full_rebuild"]);
      if (jobs.length === 0) {
        throw new Error("graph rebuild checkpoint jobs are incomplete");
      }
      for (const job of jobs) {
        if (visited.has(job.job_id)) {
          throw new Error("graph rebuild checkpoint job repeated");
        }
        visited.add(job.job_id);
        const result = await projector.project(
          job as GraphProjectionOutboxJob,
        );
        if (result.outcome !== "applied" || result.result.receipt === null) {
          throw new Error("graph rebuild checkpoint publication failed");
        }
        receipts.push(result.result.receipt.receipt_id);
      }
    }
    return receipts.sort();
  }
}

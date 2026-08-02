import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  CanonicalHashSchema,
  GraphBackendIdentitySchema,
  GraphQueryModeSchema,
  LanePolicySchema,
  RelationTypeSchema,
  ScopeSchema,
  VectorEmbeddingEpochSchema,
  canonicalSha256,
  type CanonicalHash,
  type OperationalStatus,
} from "@memo-graph/contracts";
import {
  ExactScopeGraphProjector,
  GraphProcessHost,
  GraphRecallRetriever,
} from "@memo-graph/graph-projection";
import {
  ConsolidationService,
  LayeredLaneRetrievers,
  MemoryRuntime,
} from "@memo-graph/memory-kernel";
import {
  blockedOperationalStatus,
  FileRecoveryHeadProvider,
  operationalStatusFromStorageHealth,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import {
  SemanticVectorRetriever,
  VectorScopeProjector,
} from "@memo-graph/vector-retrieval";
import { z } from "zod";

import { LocalManifestApprovalRegistry } from "./approval-registry.js";
import {
  BackgroundSupervisor,
  type BackgroundLane,
} from "./background-supervisor.js";
import { readPrivateOperatorFile } from "./trusted-file.js";
import { SharedGraphStoreManager } from "./shared-graph-store.js";

const DisabledGraphServerConfigSchema = z
  .object({ enabled: z.literal(false) })
  .strict();

const EnabledGraphServerConfigSchema = z
  .object({
    enabled: z.literal(true),
    expected_identity: GraphBackendIdentitySchema,
    generation_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u)
      .optional(),
    mode: GraphQueryModeSchema.default("typed_path"),
    relation_pattern: z.array(RelationTypeSchema).min(1).max(4),
    direction: z.literal("outbound").default("outbound"),
    startup_timeout_ms: z.number().int().min(1).max(60_000).default(2_000),
    request_timeout_ms: z.number().int().min(1).max(75).default(75),
  })
  .strict();

export const GraphServerConfigSchema = z
  .discriminatedUnion("enabled", [
    DisabledGraphServerConfigSchema,
    EnabledGraphServerConfigSchema,
  ])
  .default({ enabled: false });

const DisabledVectorServerConfigSchema = z
  .object({ enabled: z.literal(false) })
  .strict();

const EnabledVectorServerConfigSchema = z
  .object({
    enabled: z.literal(true),
    model_root: z.string().trim().min(1),
    expected_epoch: VectorEmbeddingEpochSchema,
    allow_evaluating: z.boolean().default(false),
  })
  .strict();

export const VectorServerConfigSchema = z
  .discriminatedUnion("enabled", [
    DisabledVectorServerConfigSchema,
    EnabledVectorServerConfigSchema,
  ])
  .default({ enabled: false });

const RecoveryHeadConfigSchema = z
  .discriminatedUnion("enabled", [
    z.object({ enabled: z.literal(false) }).strict(),
    z
      .object({
        enabled: z.literal(true),
        directory: z.string().trim().min(1),
        authority_key_id: z.string().trim().min(1).max(160),
        trust_root_version: z.number().int().positive(),
        private_key_path: z.string().trim().min(1),
        public_key_path: z.string().trim().min(1),
      })
      .strict(),
  ])
  .default({ enabled: false });

export const MemoryServerConfigSchema = z
  .object({
    data_root: z.string().trim().min(1),
    principal_id: z.string().trim().min(1).max(160),
    allowed_scopes: z.array(ScopeSchema).min(1),
    allowed_authorities: z
      .array(
        z.enum([
          "user_stated",
          "observed",
          "tool_result",
          "inferred",
          "derived",
          "imported",
        ]),
      )
      .min(1),
    destructive_tools_enabled: z.boolean().default(false),
    approval_manifest_path: z.string().trim().min(1).optional(),
    default_token_budget: z.number().int().positive().max(32_000).default(1_800),
    lane_policy: LanePolicySchema.default({
      allowed_lanes: ["recent_l1"],
      limits: {
        max_candidates_per_lane: 100,
        relation_max_depth: 2,
        relation_max_fanout: 20,
        max_concurrent_lanes: 2,
      },
    }),
    graph: GraphServerConfigSchema,
    vector: VectorServerConfigSchema,
    recovery_head: RecoveryHeadConfigSchema,
  })
  .strict();

export type MemoryServerConfig = z.infer<typeof MemoryServerConfigSchema>;
export type RuntimeOpenMode = "direct" | "managed";

export type RuntimeRootIdentity = {
  canonical_root_hash: CanonicalHash;
  device: string;
  inode: string;
};

export type OpenedMemoryRuntime = {
  mode: RuntimeOpenMode;
  config: z.output<typeof MemoryServerConfigSchema>;
  configIdentity: CanonicalHash;
  rootIdentity: RuntimeRootIdentity;
  storage: SqliteStorageClient;
  runtime: MemoryRuntime;
  supervisor: BackgroundSupervisor | null;
  close(): Promise<void>;
};

function resolveNoSymlinkTail(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error("recovery paths must be absolute");
  }
  const resolved = resolve(path);
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error("recovery path has no trusted ancestor");
    }
    cursor = parent;
  }
  const stat = lstatSync(cursor);
  if (stat.isSymbolicLink() || realpathSync(cursor) !== cursor) {
    throw new Error("recovery path contains a symbolic link");
  }
  return resolved;
}

function pathContains(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    (fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`) &&
      !isAbsolute(fromParent))
  );
}

function assertExternalToDataRoot(
  dataRootInput: string,
  externalPathInput: string,
): string {
  const dataRoot = resolveNoSymlinkTail(dataRootInput);
  const externalPath = resolveNoSymlinkTail(externalPathInput);
  if (
    pathContains(dataRoot, externalPath) ||
    pathContains(externalPath, dataRoot)
  ) {
    throw new Error("recovery authority must be external to the data root");
  }
  return externalPath;
}

function assertExternalRecoveryDirectory(
  dataRootInput: string,
  recoveryDirectoryInput: string,
): string {
  const recoveryDirectory = assertExternalToDataRoot(
    dataRootInput,
    recoveryDirectoryInput,
  );
  const stat = lstatSync(recoveryDirectory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(recoveryDirectory) !== recoveryDirectory
  ) {
    throw new Error("recovery head must be external to the data root");
  }
  return recoveryDirectory;
}

export function memoryRuntimeConfigIdentity(
  configInput: unknown,
): CanonicalHash {
  const config = MemoryServerConfigSchema.parse(configInput);
  return CanonicalHashSchema.parse(
    canonicalSha256({
      ...config,
      data_root: realpathSync(config.data_root),
    }),
  );
}

export function memoryRuntimeRootIdentity(dataRoot: string): RuntimeRootIdentity {
  const canonicalRoot = realpathSync(dataRoot);
  const stat = statSync(canonicalRoot, { bigint: true });
  return {
    canonical_root_hash: CanonicalHashSchema.parse(
      canonicalSha256({ canonical_root: canonicalRoot }),
    ),
    device: stat.dev.toString(10),
    inode: stat.ino.toString(10),
  };
}

export async function openMemoryRuntime(
  configInput: unknown,
  options: {
    mode?: RuntimeOpenMode;
    backgroundLanes?: BackgroundLane[];
  } = {},
): Promise<OpenedMemoryRuntime> {
  const mode = options.mode ?? "direct";
  const config = MemoryServerConfigSchema.parse(configInput);
  const recoveryHeadProvider = config.recovery_head.enabled
    ? (() => {
        const directory = assertExternalRecoveryDirectory(
          config.data_root,
          config.recovery_head.directory,
        );
        const privateKeyPath = assertExternalToDataRoot(
          config.data_root,
          config.recovery_head.private_key_path,
        );
        const publicKeyPath = assertExternalToDataRoot(
          config.data_root,
          config.recovery_head.public_key_path,
        );
        const privateKeyBytes = readPrivateOperatorFile(privateKeyPath);
        const publicKeyBytes = readPrivateOperatorFile(publicKeyPath);
        try {
          return new FileRecoveryHeadProvider({
            directory,
            authorityKeyId: config.recovery_head.authority_key_id,
            trustRootVersion: config.recovery_head.trust_root_version,
            privateKey: createPrivateKey(privateKeyBytes),
            publicKey: createPublicKey(publicKeyBytes),
          });
        } finally {
          privateKeyBytes.fill(0);
          publicKeyBytes.fill(0);
        }
      })()
    : undefined;
  const storage = await SqliteStorageClient.open({
    dataRoot: config.data_root,
    recoveryHeadProvider: recoveryHeadProvider ?? null,
  });
  let graphRetriever: GraphRecallRetriever | undefined;
  let graphStoreManager: SharedGraphStoreManager | null = null;
  let supervisor: BackgroundSupervisor | null = null;
  try {
    const rootIdentity = memoryRuntimeRootIdentity(config.data_root);
    let graphProjector: ExactScopeGraphProjector | null = null;
    if (config.graph.enabled) {
      const graphConfig = config.graph;
      const openGraphStore = () =>
          GraphProcessHost.open({
            dataRoot: config.data_root,
            expectedIdentity: graphConfig.expected_identity,
            ...(graphConfig.generation_id === undefined
              ? {}
              : { generationId: graphConfig.generation_id }),
            startupTimeoutMs: graphConfig.startup_timeout_ms,
            requestTimeoutMs: graphConfig.request_timeout_ms,
            ...(config.lane_policy.limits.graph_max_response_bytes === undefined
              ? {}
              : {
                  maxIpcBytes:
                    config.lane_policy.limits.graph_max_response_bytes,
                }),
          });
      if (mode === "managed") {
        graphStoreManager = new SharedGraphStoreManager(openGraphStore);
        const sharedStore = graphStoreManager.borrowedStore();
        graphProjector = new ExactScopeGraphProjector({
          storage,
          store: sharedStore,
          workerId: `runtime_graph_${randomUUID()}`,
          claimLimit: 5,
          maxJobsPerDrain: 10,
        });
        if (config.lane_policy.allowed_lanes.includes("relation_graph")) {
          graphRetriever = new GraphRecallRetriever({
            storage,
            store: sharedStore,
            policy: {
              mode: graphConfig.mode,
              relation_pattern: graphConfig.relation_pattern,
              direction: graphConfig.direction,
            },
          });
        }
      } else if (
        config.lane_policy.allowed_lanes.includes("relation_graph")
      ) {
        graphRetriever = new GraphRecallRetriever({
          storage,
          storeFactory: openGraphStore,
          policy: {
            mode: graphConfig.mode,
            relation_pattern: graphConfig.relation_pattern,
            direction: graphConfig.direction,
          },
        });
      }
    }
    const vectorRetriever =
      config.vector.enabled &&
      config.lane_policy.allowed_lanes.includes("semantic_vector")
        ? new SemanticVectorRetriever({
            storage,
            dataRoot: config.data_root,
            modelRoot: config.vector.model_root,
            epoch: config.vector.expected_epoch,
            allowEvaluating: config.vector.allow_evaluating,
          })
        : undefined;
    const vectorProjector =
      mode === "managed" && config.vector.enabled
        ? new VectorScopeProjector({
            storage,
            dataRoot: config.data_root,
            modelRoot: config.vector.model_root,
            epoch: config.vector.expected_epoch,
          })
        : null;
    const laneRetriever = new LayeredLaneRetrievers(storage, {
      ...(graphRetriever === undefined ? {} : { graphRetriever }),
      ...(vectorRetriever === undefined ? {} : { vectorRetriever }),
    });
    const approvalRegistry =
      config.approval_manifest_path === undefined
        ? undefined
        : new LocalManifestApprovalRegistry({
            manifestPath: config.approval_manifest_path,
          });
    const runtime = new MemoryRuntime({
      storage,
      ...(approvalRegistry === undefined
        ? {}
        : {
            approvalRegistry,
            learningAuthorityRegistry: approvalRegistry,
          }),
      policy: {
        principal: {
          principal_id: config.principal_id,
          allowed_scopes: config.allowed_scopes,
          allowed_authorities: config.allowed_authorities,
          destructive_tools_enabled: config.destructive_tools_enabled,
        },
        default_token_budget: config.default_token_budget,
        lane_policy: config.lane_policy,
      },
      laneRetriever,
    });
    if (mode === "managed") {
      const consolidation = new ConsolidationService({ storage });
      const workerId = `runtime_host_${randomUUID()}`;
      const lanes: BackgroundLane[] = [
        {
          name: "writer_lease",
          intervalMs: 10_000,
          runOnce: async () => {
            storage.maintainWriterLease();
            return { claimed: 0, completed: 0, failed: 0, terminal: 0 };
          },
        },
        {
          name: "fts",
          intervalMs: 500,
          runOnce: async () => {
            const result = await storage.drainFtsOutbox();
            return {
              claimed: result.processed + result.failed,
              completed: result.processed,
              failed: result.failed,
              retrying: result.retrying,
              terminal: result.terminal,
              failure_code:
                result.failed > 0 || result.retrying > 0 || result.terminal > 0
                  ? "FTS_UNAVAILABLE"
                  : null,
            };
          },
        },
        {
          name: "consolidation",
          intervalMs: 750,
          runOnce: async () => {
            const now = new Date();
            const result = await consolidation.drain({
              worker_id: workerId,
              claimed_at: now.toISOString(),
              lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
              limit: 10,
            });
            return {
              claimed: result.claimed,
              completed: result.processed,
              failed: result.failed,
              retrying: result.retrying,
              terminal: result.terminal,
              failure_code:
                result.failed > 0 ||
                result.retrying > 0 ||
                result.terminal > 0
                  ? "PROJECTION_RECONCILE_FAILED"
                  : null,
            };
          },
        },
        ...(graphProjector === null
          ? []
          : [{
              name: "graph_projection",
              intervalMs: 1_000,
              runOnce: async () => {
                const result = await graphProjector.drain();
                const status = await storage.graphProjectionStatus();
                return {
                  claimed: result.claimed,
                  completed: result.applied + result.stale,
                  failed: result.failed + result.abandoned,
                  retrying: status.outbox_retrying,
                  terminal: status.outbox_terminal,
                  failure_code:
                    result.failed + result.abandoned > 0 ||
                    status.outbox_retrying > 0 ||
                    status.outbox_terminal > 0
                      ? "GRAPH_PROJECTION_FAILED"
                      : null,
                };
              },
            } satisfies BackgroundLane]),
        ...(vectorProjector === null
          ? []
          : [{
              name: "vector_projection",
              intervalMs: 1_000,
              runOnce: async () => {
                const now = new Date();
                const result = await vectorProjector.drain({
                  worker_id: `runtime_vector_${workerId}`,
                  claimed_at: now.toISOString(),
                  lease_expires_at: new Date(
                    now.getTime() + 60_000,
                  ).toISOString(),
                  completed_at: now.toISOString(),
                  retry_at: new Date(now.getTime() + 1_000).toISOString(),
                  limit: 5,
                });
                const status = await storage.vectorProjectionStatus();
                return {
                  claimed: result.claimed,
                  completed: result.published + result.stale,
                  failed: result.failed,
                  retrying: status.outbox_retrying,
                  terminal: status.outbox_terminal,
                  failure_code:
                    result.failed > 0 ||
                    status.outbox_retrying > 0 ||
                    status.outbox_terminal > 0
                      ? "VECTOR_PROJECTION_FAILED"
                      : null,
                };
              },
            } satisfies BackgroundLane]),
        ...(options.backgroundLanes ?? []),
      ];
      supervisor = new BackgroundSupervisor({ lanes, maxConcurrency: 1 });
      supervisor.start();
    }
    let closed = false;
    return {
      mode,
      config,
      configIdentity: memoryRuntimeConfigIdentity(config),
      rootIdentity,
      storage,
      runtime,
      supervisor,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        if (supervisor !== null) {
          await supervisor.drain(5_000);
        }
        if (graphRetriever !== undefined) {
          await graphRetriever.close().catch(() => undefined);
        }
        await graphStoreManager?.close().catch(() => undefined);
        await storage.close();
      },
    };
  } catch (error) {
    if (supervisor !== null) {
      await supervisor.close().catch(() => undefined);
    }
    if (graphRetriever !== undefined) {
      await graphRetriever.close().catch(() => undefined);
    }
    await graphStoreManager?.close().catch(() => undefined);
    await storage.close().catch(() => undefined);
    throw error;
  }
}

export type MemoryRuntimePreflightResult =
  | { state: "opened"; opened: OpenedMemoryRuntime }
  | { state: "blocked"; status: OperationalStatus };

export async function preflightMemoryRuntime(
  configInput: unknown,
  options?: { observedAt?: string; mode?: RuntimeOpenMode },
): Promise<MemoryRuntimePreflightResult> {
  try {
    const opened = await openMemoryRuntime(configInput, {
      mode: options?.mode ?? "direct",
    });
    const status = operationalStatusFromStorageHealth(
      await opened.storage.health(),
      options?.observedAt === undefined
        ? undefined
        : { observedAt: options.observedAt },
    );
    if (status.readiness === "blocked") {
      await opened.close();
      return { state: "blocked", status };
    }
    return { state: "opened", opened };
  } catch (error) {
    return {
      state: "blocked",
      status: blockedOperationalStatus(error, {
        ...(options?.observedAt === undefined
          ? {}
          : { observedAt: options.observedAt }),
        invalidConfig: error instanceof z.ZodError,
      }),
    };
  }
}

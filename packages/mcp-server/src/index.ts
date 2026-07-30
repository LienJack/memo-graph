import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  GovernedResponseSchema,
  GraphBackendIdentitySchema,
  GraphQueryModeSchema,
  LanePolicySchema,
  LearningPauseInputSchema,
  LearningReleaseInputSchema,
  LearningResumeInputSchema,
  LearningRollbackInputSchema,
  MemoryContextCompileInputSchema,
  MemoryCorrectInputSchema,
  MemoryDeleteInputSchema,
  MemoryDemoteInputSchema,
  MemoryEpisodeCommitInputSchema,
  MemoryExplainInputSchema,
  MemoryGetInputSchema,
  MemoryFeedbackInputSchema,
  MemoryReceiptGetInputSchema,
  MemoryPinInputSchema,
  MemoryProposeInputSchema,
  MemoryRevokeInputSchema,
  MemorySearchInputSchema,
  MemoryUsageSetInputSchema,
  OperationalStatusSchema,
  RelationTypeSchema,
  ScopeSchema,
  VectorEmbeddingEpochSchema,
  canonicalJson,
  type OperationalStatus,
} from "@memo-graph/contracts";
import {
  GraphProcessHost,
  GraphRecallRetriever,
} from "@memo-graph/graph-projection";
import {
  LayeredLaneRetrievers,
  MemoryRuntime,
} from "@memo-graph/memory-kernel";
import {
  blockedOperationalStatus,
  FileRecoveryHeadProvider,
  operationalStatusFromStorageHealth,
  SqliteStorageClient,
  StorageClientHealthSchema,
} from "@memo-graph/storage-sqlite";
import {
  SemanticVectorRetriever,
} from "@memo-graph/vector-retrieval";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { LocalManifestApprovalRegistry } from "./mutations.js";
import { readPrivateOperatorFile } from "./trusted-file.js";

export const MEMORY_MCP_SERVER_VERSION = "0.1.0";

type OperationalStatusProvider = () =>
  | OperationalStatus
  | Promise<OperationalStatus>;

function registerOperationalHealthResource(
  server: McpServer,
  status: OperationalStatusProvider,
): void {
  server.registerResource(
    "runtime-health",
    "memory://runtime/health",
    {
      title: "Memory runtime health",
      description:
        "Content-free readiness and release qualification. Reading this resource does not add it to model context.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: canonicalJson(OperationalStatusSchema.parse(await status())),
        },
      ],
    }),
  );
}

export function createOperationalHealthMcpServer(options: {
  status: OperationalStatusProvider;
}): McpServer {
  const server = new McpServer(
    {
      name: "memo-graph-memory-preflight",
      version: MEMORY_MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      instructions:
        "The canonical runtime is blocked. Only content-free health is available; no memory tools are registered.",
    },
  );
  registerOperationalHealthResource(server, options.status);
  return server;
}

export const createBlockedMemoryMcpServer =
  createOperationalHealthMcpServer;

const DisabledGraphServerConfigSchema = z
  .object({
    enabled: z.literal(false),
  })
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
    startup_timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .default(2_000),
    request_timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(75)
      .default(75),
  })
  .strict();

export const GraphServerConfigSchema = z
  .discriminatedUnion("enabled", [
    DisabledGraphServerConfigSchema,
    EnabledGraphServerConfigSchema,
  ])
  .default({ enabled: false });

const DisabledVectorServerConfigSchema = z
  .object({
    enabled: z.literal(false),
  })
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
    default_token_budget: z
      .number()
      .int()
      .positive()
      .max(32_000)
      .default(1_800),
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
  if (
    !existsSync(recoveryDirectory) ||
    !lstatSync(recoveryDirectory).isDirectory() ||
    lstatSync(recoveryDirectory).isSymbolicLink() ||
    realpathSync(recoveryDirectory) !== recoveryDirectory
  ) {
    throw new Error("recovery head must be external to the data root");
  }
  return recoveryDirectory;
}

export const MEMORY_TOOL_METADATA = [
  {
    name: "memory_search",
    safety_class: "read_only",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_get",
    safety_class: "read_only",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_explain",
    safety_class: "read_only",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_receipt_get",
    safety_class: "read_only",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_context_compile",
    safety_class: "read_only",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_episode_commit",
    safety_class: "proposal",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_propose",
    safety_class: "proposal",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_feedback",
    safety_class: "proposal",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_correct",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_pin",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_demote",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_usage_set",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_revoke",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "learning_pause",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "learning_resume",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "learning_release",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "learning_rollback",
    safety_class: "important_mutation",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_delete",
    safety_class: "destructive",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;

export const MEMORY_RESOURCE_URIS = [
  "memory://runtime/health",
  "memory://runtime/storage-health",
  "memory://runtime/contracts",
  "memory://runtime/usage",
  "memory://runtime/learning",
] as const;

function toolResult(response: z.infer<typeof GovernedResponseSchema>) {
  return {
    content: [{ type: "text" as const, text: canonicalJson(response) }],
    structuredContent: response,
    isError: response.status === "FAILED",
  };
}

function annotations(name: (typeof MEMORY_TOOL_METADATA)[number]["name"]) {
  const metadata = MEMORY_TOOL_METADATA.find((entry) => entry.name === name);
  if (metadata === undefined) {
    throw new Error("tool metadata is incomplete");
  }
  return metadata.annotations;
}

export type MemoryMcpRuntime = Pick<
  MemoryRuntime,
  | "learningInspection"
  | "learningPause"
  | "learningRelease"
  | "learningResume"
  | "learningRollback"
  | "memoryContextCompile"
  | "memoryCorrect"
  | "memoryDelete"
  | "memoryDemote"
  | "memoryEpisodeCommit"
  | "memoryExplain"
  | "memoryFeedback"
  | "memoryGet"
  | "memoryPin"
  | "memoryPropose"
  | "memoryReceiptGet"
  | "memoryRevoke"
  | "memorySearch"
  | "memoryUsageSet"
>;

export function createMemoryMcpServer(options: {
  runtime: MemoryMcpRuntime;
  storage: SqliteStorageClient;
  operationalStatus?: OperationalStatusProvider;
}): McpServer {
  const server = new McpServer(
    {
      name: "memo-graph-memory-runtime",
      version: MEMORY_MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      instructions:
        "Memory is returned only by explicit tool calls. Resources are inspection endpoints and are not automatically added to model context. MCP cannot originate secret plaintext; it may only reference an existing encrypted evidence identity, and secret content remains excluded from recall and Context.",
    },
  );
  registerOperationalHealthResource(
    server,
    options.operationalStatus ??
      (async () =>
        operationalStatusFromStorageHealth(await options.storage.health())),
  );
  server.registerResource(
    "runtime-storage-health",
    "memory://runtime/storage-health",
    {
      title: "Memory storage health",
      description:
        "Read-only content-free storage frontiers and counts for local diagnostics.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: canonicalJson(
            StorageClientHealthSchema.parse(await options.storage.health()),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search governed memory",
      description:
        "Search canonical L1 revisions with exact-scope L0 evidence fallback.",
      inputSchema: MemorySearchInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_search"),
    },
    async (input) => toolResult(await options.runtime.memorySearch(input)),
  );
  server.registerTool(
    "memory_get",
    {
      title: "Get governed memory or evidence",
      description:
        "Read one canonical L1 memory or L0 evidence record in an exact authorized scope.",
      inputSchema: MemoryGetInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_get"),
    },
    async (input) => toolResult(await options.runtime.memoryGet(input)),
  );
  server.registerTool(
    "memory_explain",
    {
      title: "Explain governed memory or evidence",
      description:
        "Read governed eligibility, lineage, hashes, scope, and provenance.",
      inputSchema: MemoryExplainInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_explain"),
    },
    async (input) => toolResult(await options.runtime.memoryExplain(input)),
  );
  server.registerTool(
    "memory_receipt_get",
    {
      title: "Get a durable memory receipt",
      description:
        "Read one mutation or retrieval receipt by durable identifier.",
      inputSchema: MemoryReceiptGetInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_receipt_get"),
    },
    async (input) =>
      toolResult(await options.runtime.memoryReceiptGet(input)),
  );
  server.registerTool(
    "memory_context_compile",
    {
      title: "Compile frozen governed context",
      description:
        "Compile an exact-scope, hard-budget Context from operator-enabled memory lanes; request overrides may only narrow the configured policy.",
      inputSchema: MemoryContextCompileInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_context_compile"),
    },
    async (input) =>
      toolResult(await options.runtime.memoryContextCompile(input)),
  );
  server.registerTool(
    "memory_episode_commit",
    {
      title: "Commit one evidence episode proposal",
      description:
        "Durably append one sealed episode and its evidence using the proposal idempotency key.",
      inputSchema: MemoryEpisodeCommitInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_episode_commit"),
    },
    async (input) =>
      toolResult(await options.runtime.memoryEpisodeCommit(input)),
  );
  server.registerTool(
    "memory_propose",
    {
      title: "Propose governed memory",
      description:
        "Evaluate evidence-backed candidate memory and admit it under canonical governance.",
      inputSchema: MemoryProposeInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_propose"),
    },
    async (input) => toolResult(await options.runtime.memoryPropose(input)),
  );
  server.registerTool(
    "memory_feedback",
    {
      title: "Record governed learning feedback",
      description:
        "Record content-free outcome metadata without fabricating a trace, publishing a candidate, or changing a release pointer.",
      inputSchema: MemoryFeedbackInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_feedback"),
    },
    async (input) =>
      toolResult(await options.runtime.memoryFeedback(input)),
  );
  server.registerTool(
    "memory_correct",
    {
      title: "Correct governed memory",
      description:
        "Create an immutable successor revision using exact-revision compare-and-swap and trusted approval.",
      inputSchema: MemoryCorrectInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_correct"),
    },
    async (input) => toolResult(await options.runtime.memoryCorrect(input)),
  );
  server.registerTool(
    "memory_pin",
    {
      title: "Pin governed memory",
      description:
        "Change retention preference without changing authority or eligibility.",
      inputSchema: MemoryPinInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_pin"),
    },
    async (input) => toolResult(await options.runtime.memoryPin(input)),
  );
  server.registerTool(
    "memory_demote",
    {
      title: "Demote governed memory",
      description:
        "Move an active memory back to candidate state without deleting evidence.",
      inputSchema: MemoryDemoteInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_demote"),
    },
    async (input) => toolResult(await options.runtime.memoryDemote(input)),
  );
  server.registerTool(
    "memory_usage_set",
    {
      title: "Set governed memory Context usage",
      description:
        "Allow or block one memory in a global or exact Context scope.",
      inputSchema: MemoryUsageSetInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_usage_set"),
    },
    async (input) =>
      toolResult(await options.runtime.memoryUsageSet(input)),
  );
  server.registerTool(
    "memory_revoke",
    {
      title: "Revoke governed memory",
      description:
        "Immediately remove a memory from governed recall while preserving audit history.",
      inputSchema: MemoryRevokeInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_revoke"),
    },
    async (input) => toolResult(await options.runtime.memoryRevoke(input)),
  );
  server.registerTool(
    "learning_pause",
    {
      title: "Pause governed learning",
      description:
        "Advance the exact learning control frontier to paused while leaving ordinary memory service available.",
      inputSchema: LearningPauseInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("learning_pause"),
    },
    async (input) =>
      toolResult(await options.runtime.learningPause(input)),
  );
  server.registerTool(
    "learning_resume",
    {
      title: "Resume governed learning",
      description:
        "Resume the exact paused frontier, or explicitly abandon drifted in-flight learning work.",
      inputSchema: LearningResumeInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("learning_resume"),
    },
    async (input) =>
      toolResult(await options.runtime.learningResume(input)),
  );
  server.registerTool(
    "learning_release",
    {
      title: "Release an evaluated learning candidate",
      description:
        "Publish one exact post-canary candidate under trusted approval and pointer compare-and-swap.",
      inputSchema: LearningReleaseInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("learning_release"),
    },
    async (input) =>
      toolResult(await options.runtime.learningRelease(input)),
  );
  server.registerTool(
    "learning_rollback",
    {
      title: "Roll back a learning release",
      description:
        "Restore one exact prior release pointer under monitor evidence and trusted approval.",
      inputSchema: LearningRollbackInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("learning_rollback"),
    },
    async (input) =>
      toolResult(await options.runtime.learningRollback(input)),
  );
  server.registerTool(
    "memory_delete",
    {
      title: "Delete governed memory",
      description:
        "Commit a tombstone and begin the governed purge workflow when destructive tools are enabled.",
      inputSchema: MemoryDeleteInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_delete"),
    },
    async (input) => toolResult(await options.runtime.memoryDelete(input)),
  );

  server.registerResource(
    "runtime-contracts",
    "memory://runtime/contracts",
    {
      title: "Memory runtime tool contracts",
      description:
        "Static safety and annotation metadata. Reading this resource does not add it to model context.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: canonicalJson({
            schema_version: "1.0.0",
            tools: MEMORY_TOOL_METADATA,
          }),
        },
      ],
    }),
  );
  server.registerResource(
    "runtime-usage",
    "memory://runtime/usage",
    {
      title: "Memory runtime explicit usage",
      description:
        "Task-start compile and task-end commit guidance. Reading this resource does not add it to model context.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: canonicalJson({
            schema_version: "1.0.0",
            automatic_context_injection: false,
            task_start: "Call memory_context_compile explicitly.",
            task_end: "Call memory_episode_commit explicitly.",
            note:
              "MCP resources are inspection endpoints and are not automatically added to model context.",
          }),
        },
      ],
    }),
  );
  server.registerResource(
    "runtime-learning",
    "memory://runtime/learning",
    {
      title: "Governed learning runtime inspection",
      description:
        "Content-free learning control, candidate, release, pointer, receipt, and frontier metadata. Reading this resource does not add it to model context.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: canonicalJson(await options.runtime.learningInspection()),
        },
      ],
    }),
  );
  return server;
}

export async function openMemoryRuntime(configInput: unknown): Promise<{
  config: z.output<typeof MemoryServerConfigSchema>;
  storage: SqliteStorageClient;
  runtime: MemoryRuntime;
  close(): Promise<void>;
}> {
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
        const privateKeyBytes =
          readPrivateOperatorFile(privateKeyPath);
        const publicKeyBytes =
          readPrivateOperatorFile(publicKeyPath);
        try {
          return new FileRecoveryHeadProvider({
            directory,
            authorityKeyId:
              config.recovery_head.authority_key_id,
            trustRootVersion:
              config.recovery_head.trust_root_version,
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
  try {
    if (
      config.graph.enabled &&
      config.lane_policy.allowed_lanes.includes("relation_graph")
    ) {
      const graphConfig = config.graph;
      graphRetriever = new GraphRecallRetriever({
        storage,
        storeFactory: () =>
          GraphProcessHost.open({
            dataRoot: config.data_root,
            expectedIdentity: graphConfig.expected_identity,
            ...(graphConfig.generation_id === undefined
              ? {}
              : { generationId: graphConfig.generation_id }),
            startupTimeoutMs: graphConfig.startup_timeout_ms,
            requestTimeoutMs: graphConfig.request_timeout_ms,
            ...(config.lane_policy.limits.graph_max_response_bytes ===
              undefined
              ? {}
              : {
                  maxIpcBytes:
                    config.lane_policy.limits.graph_max_response_bytes,
                }),
          }),
        policy: {
          mode: graphConfig.mode,
          relation_pattern: graphConfig.relation_pattern,
          direction: graphConfig.direction,
        },
      });
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
    const laneRetriever = new LayeredLaneRetrievers(storage, {
      ...(graphRetriever === undefined
        ? {}
        : { graphRetriever }),
      ...(vectorRetriever === undefined
        ? {}
        : { vectorRetriever }),
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
    let closed = false;
    return {
      config,
      storage,
      runtime,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        if (graphRetriever !== undefined) {
          await graphRetriever.close().catch(() => undefined);
        }
        await storage.close();
      },
    };
  } catch (error) {
    if (graphRetriever !== undefined) {
      await graphRetriever.close().catch(() => undefined);
    }
    await storage.close().catch(() => undefined);
    throw error;
  }
}

export type MemoryRuntimePreflightResult =
  | {
      state: "opened";
      opened: Awaited<ReturnType<typeof openMemoryRuntime>>;
    }
  | {
      state: "blocked";
      status: OperationalStatus;
    };

export async function preflightMemoryRuntime(
  configInput: unknown,
  options?: { observedAt?: string },
): Promise<MemoryRuntimePreflightResult> {
  try {
    const opened = await openMemoryRuntime(configInput);
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
    return {
      state: "opened",
      opened,
    };
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

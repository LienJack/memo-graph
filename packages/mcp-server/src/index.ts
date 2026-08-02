import {
  GovernedResponseSchema,
  LearningPauseInputSchema,
  LearningReleaseInputSchema,
  LearningResumeInputSchema,
  LearningRollbackInputSchema,
  MemoryContextCompileInputSchema,
  MemoryCorrectInputSchema,
  MemoryDeleteInputSchema,
  MemoryDemoteInputSchema,
  MemoryEvidenceIngestInputSchema,
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
  canonicalJson,
  type OperationalStatus,
} from "@memo-graph/contracts";
import type { MemoryRuntime } from "@memo-graph/memory-kernel";
import {
  operationalStatusFromStorageHealth,
  StorageClientHealthSchema,
} from "@memo-graph/storage-sqlite";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

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

export {
  GraphServerConfigSchema,
  MemoryServerConfigSchema,
  VectorServerConfigSchema,
  openMemoryRuntime,
  preflightMemoryRuntime,
  type MemoryRuntimePreflightResult,
  type MemoryServerConfig,
} from "@memo-graph/runtime-host";
export {
  attachManagedMcpProxy,
  managedAttachBlockedStatus,
  type ManagedMcpProxyHandle,
} from "./ipc-proxy.js";
export { attachManagedMemoryMcpSession } from "./managed-session.js";

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
    name: "memory_evidence_ingest",
    safety_class: "proposal",
    annotations: {
      readOnlyHint: false,
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
  | "memoryEvidenceIngest"
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
    "memory_evidence_ingest",
    {
      title: "Ingest common text evidence",
      description:
        "Deterministically adapt conversation turns, tool results, or text files into one sealed L0 evidence episode without creating memory candidates.",
      inputSchema: MemoryEvidenceIngestInputSchema,
      outputSchema: GovernedResponseSchema,
      annotations: annotations("memory_evidence_ingest"),
    },
    async (input) =>
      toolResult(await options.runtime.memoryEvidenceIngest(input)),
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
            task_end:
              "Call memory_evidence_ingest for supported text sources, or memory_episode_commit for pre-sealed canonical evidence.",
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

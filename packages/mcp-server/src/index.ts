import {
  GovernedResponseSchema,
  LanePolicySchema,
  MemoryContextCompileInputSchema,
  MemoryCorrectInputSchema,
  MemoryDeleteInputSchema,
  MemoryDemoteInputSchema,
  MemoryEpisodeCommitInputSchema,
  MemoryExplainInputSchema,
  MemoryGetInputSchema,
  MemoryReceiptGetInputSchema,
  MemoryPinInputSchema,
  MemoryProposeInputSchema,
  MemoryRevokeInputSchema,
  MemorySearchInputSchema,
  MemoryUsageSetInputSchema,
  ScopeSchema,
  canonicalJson,
} from "@memo-graph/contracts";
import {
  MemoryRuntime,
} from "@memo-graph/memory-kernel";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { LocalManifestApprovalRegistry } from "./mutations.js";

export const MEMORY_MCP_SERVER_VERSION = "0.1.0";

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
  })
  .strict();

export type MemoryServerConfig = z.infer<typeof MemoryServerConfigSchema>;

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
  "memory://runtime/contracts",
  "memory://runtime/usage",
] as const;

function toolResult(response: z.infer<typeof GovernedResponseSchema>) {
  return {
    content: [{ type: "text" as const, text: canonicalJson(response) }],
    structuredContent: response,
  };
}

function annotations(name: (typeof MEMORY_TOOL_METADATA)[number]["name"]) {
  const metadata = MEMORY_TOOL_METADATA.find((entry) => entry.name === name);
  if (metadata === undefined) {
    throw new Error("tool metadata is incomplete");
  }
  return metadata.annotations;
}

export function createMemoryMcpServer(options: {
  runtime: MemoryRuntime;
  storage: SqliteStorageClient;
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
        "Memory is returned only by explicit tool calls. Resources are inspection endpoints and are not automatically added to model context.",
    },
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
    "runtime-health",
    "memory://runtime/health",
    {
      title: "Memory runtime health",
      description:
        "Read-only storage, schema, projection, and count metadata. Reading this resource does not add it to model context.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: canonicalJson(await options.storage.health()),
        },
      ],
    }),
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
  return server;
}

export async function openMemoryRuntime(configInput: unknown): Promise<{
  config: z.output<typeof MemoryServerConfigSchema>;
  storage: SqliteStorageClient;
  runtime: MemoryRuntime;
}> {
  const config = MemoryServerConfigSchema.parse(configInput);
  const storage = await SqliteStorageClient.open({
    dataRoot: config.data_root,
  });
  return {
    config,
    storage,
    runtime: new MemoryRuntime({
      storage,
      ...(config.approval_manifest_path === undefined
        ? {}
        : {
            approvalRegistry: new LocalManifestApprovalRegistry({
              manifestPath: config.approval_manifest_path,
            }),
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
    }),
  };
}

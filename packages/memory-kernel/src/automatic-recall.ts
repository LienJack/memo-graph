import {
  canonicalSha256,
  IdentifierSchema,
  scopeKey,
  type Scope,
  type WorkbenchMemorySummary,
} from "@memo-graph/contracts";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { automaticContextReceiptMarker } from "@memo-graph/context-compiler";

export const DEFAULT_AUTOMATIC_RECALL_LIMITS = {
  maxItems: 8,
  maxTokens: 600,
  maxBytes: 8_000,
} as const;

export type AutomaticRecallLimits = {
  maxItems: number;
  maxTokens: number;
  maxBytes: number;
};

export type AutomaticRecallSelection = {
  memory_id: string;
  revision_id: string;
  scope: Scope;
  content_hash: string;
};

export type AutomaticRecallResult = {
  additional_context: string | null;
  receipt_id: string;
  context_slice_id: string;
  request_hash: `sha256:${string}`;
  token_count: number;
  selected: AutomaticRecallSelection[];
  exclusion_reason_codes: string[];
};

type AvailableSummary = WorkbenchMemorySummary & {
  content: Extract<WorkbenchMemorySummary["content"], { status: "available" }>;
};

function terms(value: string): string[] {
  return [...new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]{2,}/gu) ?? [],
  )].slice(0, 64);
}

function relevance(promptTerms: readonly string[], text: string): number {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  return promptTerms.reduce(
    (score, term) => score + (normalized.includes(term) ? 1 : 0),
    0,
  );
}

function scopePriority(scope: Scope): number {
  if (scope.kind === "workspace") {
    return 0;
  }
  if (scope.kind === "user") {
    return 1;
  }
  return 2;
}

function tokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function formatContext(
  receiptId: string,
  items: AvailableSummary[],
): string {
  const lines = [
    automaticContextReceiptMarker(receiptId),
    "Use these governed preferences and repository facts as background. The current user request and system/developer instructions take precedence.",
    ...items.map((item, index) =>
      `${index + 1}. scope=${item.scope.kind}:${item.scope.id} memory=${item.memory_id} revision=${item.revision_id} content=${JSON.stringify(item.content.text)}`
    ),
    "[/memo-graph automatic-context]",
  ];
  return lines.join("\n");
}

export async function compileAutomaticRecall(options: {
  storage: SqliteStorageClient;
  principalId: string;
  projectId: string;
  projectScope: Scope;
  sessionId: string;
  turnId: string;
  prompt: string;
  asOf: string;
  limits?: Partial<AutomaticRecallLimits>;
}): Promise<AutomaticRecallResult> {
  const limits = {
    ...DEFAULT_AUTOMATIC_RECALL_LIMITS,
    ...options.limits,
  };
  const scopes: Scope[] = [
    options.projectScope,
    { kind: "user", id: IdentifierSchema.parse(options.principalId) },
  ];
  let listed;
  try {
    listed = await options.storage.listWorkbenchMemories({
    principal_id: options.principalId,
    allowed_scopes: scopes,
    as_of: options.asOf,
    include_sensitive: false,
    context_scope: options.projectScope,
    max_snapshot_members: 200,
    request: {
      query: null,
      scope: null,
      kinds: [],
      lifecycles: ["active"],
      authorities: [],
      sources: [],
      recorded_after: null,
      recorded_before: null,
      include_non_current: true,
      limit: 100,
      cursor: null,
    },
    });
  } catch (error) {
    throw new Error("AUTOMATIC_RECALL_LIST_FAILED", { cause: error });
  }
  const promptTerms = terms(options.prompt);
  const allowedScopeKeys = new Set(scopes.map(scopeKey));
  const exclusions = new Set<string>(listed.exclusion_reason_codes);
  const eligible: AvailableSummary[] = [];
  for (const item of listed.items) {
    if (!allowedScopeKeys.has(scopeKey(item.scope))) {
      exclusions.add("SCOPE_EXCLUDED");
    } else if (
      !item.is_current ||
      item.lifecycle !== "active" ||
      item.non_current_reason !== null
    ) {
      exclusions.add(item.non_current_reason ?? "NOT_CURRENT");
    } else if (
      item.sensitivity === "sensitive" || item.sensitivity === "secret"
    ) {
      exclusions.add("SENSITIVITY_EXCLUDED");
    } else if (item.content.status !== "available") {
      exclusions.add(item.content.reason_code);
    } else {
      eligible.push(item as AvailableSummary);
    }
  }
  eligible.sort((left, right) =>
    scopePriority(left.scope) - scopePriority(right.scope) ||
    relevance(promptTerms, right.content.text) -
      relevance(promptTerms, left.content.text) ||
    right.validity.recorded_at.localeCompare(left.validity.recorded_at) ||
    left.memory_id.localeCompare(right.memory_id)
  );

  const requestHash = canonicalSha256({
    domain: "memo-graph/automatic-recall/v1",
    principal_id: options.principalId,
    project_id: options.projectId,
    session_id: options.sessionId,
    turn_id: options.turnId,
    project_scope: options.projectScope,
    prompt_hash: canonicalSha256(options.prompt),
    as_of: options.asOf,
    limits,
  });
  const receiptId = `automatic_recall:${requestHash.slice("sha256:".length, 48)}`;
  const selected: AvailableSummary[] = [];
  for (const item of eligible) {
    if (selected.length >= limits.maxItems) {
      exclusions.add("ITEM_BUDGET_EXCEEDED");
      break;
    }
    const candidate = [...selected, item];
    const rendered = formatContext(receiptId, candidate);
    if (
      Buffer.byteLength(rendered, "utf8") > limits.maxBytes ||
      tokenEstimate(rendered) > limits.maxTokens
    ) {
      exclusions.add("CONTEXT_BUDGET_EXCEEDED");
      continue;
    }
    selected.push(item);
  }
  const additionalContext = selected.length === 0
    ? null
    : formatContext(receiptId, selected);
  const contextSliceId = `automatic_slice:${canonicalSha256({
    request_hash: requestHash,
    selected: selected.map((item) => ({
      memory_id: item.memory_id,
      revision_id: item.revision_id,
      content_hash: item.content.content_hash,
    })),
  }).slice("sha256:".length, 48)}`;
  const tokenCount = additionalContext === null
    ? 0
    : tokenEstimate(additionalContext);
  try {
    await options.storage.recordAutomaticMemoryRecallUse({
      project_id: options.projectId,
      session_id: options.sessionId,
      turn_id: options.turnId,
      request_hash: requestHash,
      retrieval_receipt_id: receiptId,
      context_slice_id: contextSliceId,
      memory_count: selected.length,
      token_count: tokenCount,
      used_at: options.asOf,
    });
  } catch (error) {
    throw new Error("AUTOMATIC_RECALL_AUDIT_FAILED", { cause: error });
  }
  return {
    additional_context: additionalContext,
    receipt_id: receiptId,
    context_slice_id: contextSliceId,
    request_hash: requestHash,
    token_count: tokenCount,
    selected: selected.map((item) => ({
      memory_id: item.memory_id,
      revision_id: item.revision_id,
      scope: item.scope,
      content_hash: item.content.content_hash,
    })),
    exclusion_reason_codes: [...exclusions].sort(),
  };
}

import { createHash } from "node:crypto";

import {
  ContextSliceSchema,
  RetrievalReceiptSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
  type ContextConflictSet,
  type ContextFrontier,
  type ContextScoreComponents,
  type ContextSliceItem,
  type EffectiveLaneConfiguration,
  type LaneTelemetry,
  type ProjectionLineageRef,
  type RecallRequest,
  type RetrievalReceipt,
} from "@memo-graph/contracts";

export type LayeredDecision = {
  memory_id: string;
  revision_id: string;
  lane: string;
  included: boolean;
  reason_codes: string[];
  score: number | null;
  score_components?: ContextScoreComponents;
  token_estimate?: number;
  projection?: ProjectionLineageRef;
  conflict_group_id?: string | null;
  item?: ContextSliceItem;
};

function stableIdentifier(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `${prefix}:${digest.slice(0, 48)}`;
}

function selectedTelemetry(
  telemetry: LaneTelemetry[],
  decisions: LayeredDecision[],
): LaneTelemetry[] {
  const selected = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.included) {
      selected.set(
        decision.lane,
        (selected.get(decision.lane) ?? 0) + 1,
      );
    }
  }
  return telemetry.map((item) => ({
    ...item,
    selected_count: Math.min(
      item.eligible_count,
      selected.get(item.lane) ?? 0,
    ),
  }));
}

export function buildLayeredArtifacts(options: {
  request: RecallRequest;
  created_at: string;
  compiler_version: string;
  policy_version: string;
  frontier: ContextFrontier;
  effective_configuration: EffectiveLaneConfiguration;
  telemetry: LaneTelemetry[];
  conflict_sets: ContextConflictSet[];
  decisions: LayeredDecision[];
  degraded: boolean;
}): {
  context_slice: ReturnType<typeof ContextSliceSchema.parse>;
  receipt: RetrievalReceipt;
  telemetry: LaneTelemetry[];
} {
  const telemetry = selectedTelemetry(
    options.telemetry,
    options.decisions,
  );
  const included = options.decisions.filter(
    (decision): decision is LayeredDecision & { item: ContextSliceItem } =>
      decision.included && decision.item !== undefined,
  );
  const contextSliceId = stableIdentifier("context", {
    request_id: options.request.request_id,
    ordered_decisions: options.decisions.map((decision) => ({
      memory_id: decision.memory_id,
      revision_id: decision.revision_id,
      included: decision.included,
      reason_codes: decision.reason_codes,
    })),
    frontier: options.frontier,
  });
  const unsealed = ContextSliceSchema.parse({
    schema_version: "1.0.0",
    context_slice_id: contextSliceId,
    request_id: options.request.request_id,
    compiler_version: options.compiler_version,
    created_at: options.created_at,
    token_budget: options.request.token_budget,
    token_used: included.reduce(
      (sum, decision) => sum + decision.item.token_estimate,
      0,
    ),
    items: included.map((decision) => decision.item),
    frozen_hash: `sha256:${"0".repeat(64)}`,
    policy_version: options.policy_version,
    frontier: options.frontier,
    effective_lane_configuration: options.effective_configuration,
    lane_telemetry: telemetry,
    conflict_sets: options.conflict_sets,
  });
  const contextSlice = ContextSliceSchema.parse({
    ...unsealed,
    frozen_hash: canonicalSha256Omitting(unsealed, ["frozen_hash"]),
  });
  const receiptItems = options.decisions.map((decision) => ({
    memory_id: decision.memory_id,
    revision_id: decision.revision_id,
    decision: decision.included ? "included" as const : "excluded" as const,
    reason_codes: decision.reason_codes,
    lane: decision.lane,
    score: decision.score,
    ...(decision.score_components === undefined
      ? {}
      : { score_components: decision.score_components }),
    ...(decision.token_estimate === undefined
      ? {}
      : { token_estimate: decision.token_estimate }),
    ...(decision.projection === undefined
      ? {}
      : { projection: decision.projection }),
    ...(decision.conflict_group_id === undefined
      ? {}
      : { conflict_group_id: decision.conflict_group_id }),
  }));
  const receipt = RetrievalReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: stableIdentifier("retrieval", {
        request_id: options.request.request_id,
        context_slice_id: contextSlice.context_slice_id,
        items: receiptItems,
      }),
      created_at: options.created_at,
      state: options.degraded ? "partial" : "durable",
      request_hash: canonicalSha256(options.request),
      receipt_hash: `sha256:${"0".repeat(64)}`,
      kind: "retrieval",
      context_slice_id: contextSlice.context_slice_id,
      compiler_version: options.compiler_version,
      policy_version: options.policy_version,
      frontier: options.frontier,
      effective_lane_configuration: options.effective_configuration,
      lane_telemetry: telemetry,
      items: receiptItems,
    }),
  );
  return { context_slice: contextSlice, receipt, telemetry };
}

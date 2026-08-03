import { z } from "zod";

import {
  canonicalJson,
  canonicalSha256,
} from "./canonical-json.js";
import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  LifecycleSchema,
  NonEmptyReasonSchema,
  ScopeSchema,
  TransformRefSchema,
  UtcTimestampSchema,
  ValidityWindowSchema,
  scopeKey,
} from "./common.js";
import {
  BoundedWorkTelemetrySchema,
  ProjectionFrontierSchema,
  ProjectionTypeSchema,
  RelationTypeSchema,
} from "./projections.js";

export const GraphBackendSchema = z.literal("ladybugdb");

export const GraphBackendIdentitySchema = z
  .object({
    schema_version: ContractVersionSchema,
    backend: GraphBackendSchema,
    package_name: z.literal("@ladybugdb/core"),
    package_version: z
      .string()
      .regex(/^(0|[1-9]\d*)\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/),
    storage_version: z.string().trim().min(1).max(120),
    platform: z.string().trim().min(1).max(80),
    architecture: z.string().trim().min(1).max(80),
    native_binary_hash: CanonicalHashSchema,
    dependency_lock_hash: CanonicalHashSchema,
  })
  .strict();

export const GraphProjectionAbstractionSchema = z.enum([
  "l1_memory",
  "l2_topic",
  "l2_scenario",
  "l2_relation",
  "l3_core",
]);

const GRAPH_PROJECTION_ABSTRACTION = {
  topic: "l2_topic",
  scenario: "l2_scenario",
  procedure: "l2_scenario",
  relation: "l2_relation",
  core: "l3_core",
} as const;

function addUniqueIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message });
  }
}

function addCanonicalOrderIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  if (
    values.some(
      (value, index) =>
        index > 0 && value < (values[index - 1] ?? ""),
    )
  ) {
    context.addIssue({ code: "custom", path, message });
  }
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const GraphNodeSchema = z
  .object({
    schema_version: ContractVersionSchema,
    graph_node_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    projection_revision_id: IdentifierSchema.nullable(),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    abstraction: GraphProjectionAbstractionSchema,
    projection_type: ProjectionTypeSchema.nullable(),
    lifecycle: LifecycleSchema,
    validity: ValidityWindowSchema,
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    projection_epoch: z.number().int().nonnegative(),
    content_hash: CanonicalHashSchema,
    payload_hash: CanonicalHashSchema,
    transform: TransformRefSchema,
    evidence_ids: z.array(IdentifierSchema).min(1).max(1_000),
    lineage_revision_ids: z.array(IdentifierSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.projection_type === null &&
      (value.projection_revision_id !== null ||
        value.abstraction !== "l1_memory")
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection_type"],
        message:
          "only canonical L1 nodes may omit projection type and revision",
      });
    }
    if (
      value.projection_type !== null &&
      (value.projection_revision_id === null ||
        GRAPH_PROJECTION_ABSTRACTION[value.projection_type] !==
          value.abstraction)
    ) {
      context.addIssue({
        code: "custom",
        path: ["abstraction"],
        message: "graph projection type, revision, and abstraction must agree",
      });
    }
    addUniqueIssue(
      value.evidence_ids,
      context,
      ["evidence_ids"],
      "graph node evidence identities must be unique",
    );
    addUniqueIssue(
      value.lineage_revision_ids,
      context,
      ["lineage_revision_ids"],
      "graph node lineage identities must be unique",
    );
    addCanonicalOrderIssue(
      value.evidence_ids,
      context,
      ["evidence_ids"],
      "graph node evidence identities must be canonical",
    );
    addCanonicalOrderIssue(
      value.lineage_revision_ids,
      context,
      ["lineage_revision_ids"],
      "graph node lineage identities must be canonical",
    );
  });

export const GraphEdgeSchema = z
  .object({
    schema_version: ContractVersionSchema,
    graph_edge_id: IdentifierSchema,
    relation_id: IdentifierSchema,
    relation_revision_id: IdentifierSchema,
    projection_revision_id: IdentifierSchema,
    source_revision_id: IdentifierSchema,
    target_revision_id: IdentifierSchema,
    relation_type: RelationTypeSchema,
    direction: z.enum(["directed", "undirected"]),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    validity: ValidityWindowSchema,
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    projection_epoch: z.number().int().nonnegative(),
    content_hash: CanonicalHashSchema,
    payload_hash: CanonicalHashSchema,
    transform: TransformRefSchema,
    evidence_ids: z.array(IdentifierSchema).min(1).max(1_000),
    lineage_revision_ids: z.array(IdentifierSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source_revision_id === value.target_revision_id) {
      context.addIssue({
        code: "custom",
        path: ["target_revision_id"],
        message: "graph relation endpoints must be distinct",
      });
    }
    addUniqueIssue(
      value.evidence_ids,
      context,
      ["evidence_ids"],
      "graph edge evidence identities must be unique",
    );
    addUniqueIssue(
      value.lineage_revision_ids,
      context,
      ["lineage_revision_ids"],
      "graph edge lineage identities must be unique",
    );
    addCanonicalOrderIssue(
      value.evidence_ids,
      context,
      ["evidence_ids"],
      "graph edge evidence identities must be canonical",
    );
    addCanonicalOrderIssue(
      value.lineage_revision_ids,
      context,
      ["lineage_revision_ids"],
      "graph edge lineage identities must be canonical",
    );
  });

const GraphScopeSnapshotInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    backend: GraphBackendSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    frontier: ProjectionFrontierSchema,
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  })
  .strict();

function snapshotPayload(value: {
  schema_version: z.infer<typeof ContractVersionSchema>;
  backend: z.infer<typeof GraphBackendSchema>;
  principal_id: z.infer<typeof IdentifierSchema>;
  scope: z.infer<typeof ScopeSchema>;
  frontier: z.infer<typeof ProjectionFrontierSchema>;
  nodes: z.infer<typeof GraphNodeSchema>[];
  edges: z.infer<typeof GraphEdgeSchema>[];
}) {
  return {
    schema_version: value.schema_version,
    backend: value.backend,
    principal_id: value.principal_id,
    scope: value.scope,
    frontier: value.frontier,
    nodes: value.nodes,
    edges: value.edges,
  };
}

function refineSnapshot(
  value: z.infer<typeof GraphScopeSnapshotInputSchema> & {
    logical_digest?: z.infer<typeof CanonicalHashSchema>;
  },
  context: z.RefinementCtx,
): void {
  const scope = scopeKey(value.scope);
  const nodeIds = value.nodes.map((node) => node.graph_node_id);
  const revisionIds = value.nodes.map((node) => node.revision_id);
  const edgeIds = value.edges.map((edge) => edge.graph_edge_id);
  const relationRevisionIds = value.edges.map(
    (edge) => edge.relation_revision_id,
  );

  addUniqueIssue(
    nodeIds,
    context,
    ["nodes"],
    "graph node identities must be unique",
  );
  addUniqueIssue(
    revisionIds,
    context,
    ["nodes"],
    "graph node revision identities must be unique",
  );
  addUniqueIssue(
    edgeIds,
    context,
    ["edges"],
    "graph edge identities must be unique",
  );
  addUniqueIssue(
    relationRevisionIds,
    context,
    ["edges"],
    "graph relation revision identities must be unique",
  );
  addCanonicalOrderIssue(
    value.nodes.map(
      (node) =>
        canonicalJson([
          node.abstraction,
          node.projection_revision_id ?? "",
          node.revision_id,
          node.graph_node_id,
        ]),
    ),
    context,
    ["nodes"],
    "graph nodes must use canonical order",
  );
  addCanonicalOrderIssue(
    value.edges.map(
      (edge) =>
        canonicalJson([
          edge.relation_type,
          edge.relation_revision_id,
          edge.graph_edge_id,
        ]),
    ),
    context,
    ["edges"],
    "graph edges must use canonical order",
  );

  const revisionSet = new Set(revisionIds);
  for (const [index, node] of value.nodes.entries()) {
    if (
      node.principal_id !== value.principal_id ||
      scopeKey(node.scope) !== scope
    ) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "scope"],
        message: "graph nodes must share the exact snapshot principal and scope",
      });
    }
    if (
      node.ledger_epoch !== value.frontier.ledger_epoch ||
      node.tombstone_epoch !== value.frontier.tombstone_epoch ||
      node.projection_epoch !== value.frontier.projection_epoch
    ) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "projection_epoch"],
        message: "graph node epochs must match the snapshot frontier",
      });
    }
    if (
      node.transform.name !== value.frontier.transform.name ||
      node.transform.version !== value.frontier.transform.version
    ) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "transform"],
        message: "graph node transform must match the snapshot frontier",
      });
    }
  }
  for (const [index, edge] of value.edges.entries()) {
    if (
      edge.principal_id !== value.principal_id ||
      scopeKey(edge.scope) !== scope
    ) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "scope"],
        message: "graph edges must share the exact snapshot principal and scope",
      });
    }
    if (
      edge.ledger_epoch !== value.frontier.ledger_epoch ||
      edge.tombstone_epoch !== value.frontier.tombstone_epoch ||
      edge.projection_epoch !== value.frontier.projection_epoch
    ) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "projection_epoch"],
        message: "graph edge epochs must match the snapshot frontier",
      });
    }
    if (
      edge.transform.name !== value.frontier.transform.name ||
      edge.transform.version !== value.frontier.transform.version
    ) {
      context.addIssue({
        code: "custom",
        path: ["edges", index, "transform"],
        message: "graph edge transform must match the snapshot frontier",
      });
    }
    if (
      !revisionSet.has(edge.source_revision_id) ||
      !revisionSet.has(edge.target_revision_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["edges", index],
        message: "graph edge endpoints must resolve inside the exact scope",
      });
    }
  }
  if (
    value.logical_digest !== undefined &&
    value.logical_digest !== canonicalSha256(snapshotPayload(value))
  ) {
    context.addIssue({
      code: "custom",
      path: ["logical_digest"],
      message: "graph logical digest must seal the canonical snapshot",
    });
  }
}

export const GraphScopeSnapshotSchema = GraphScopeSnapshotInputSchema.extend({
  logical_digest: CanonicalHashSchema,
}).superRefine(refineSnapshot);

export function buildGraphScopeSnapshot(
  input: unknown,
): z.infer<typeof GraphScopeSnapshotSchema> {
  const value = GraphScopeSnapshotInputSchema.parse(input);
  const nodes = value.nodes
    .map((node) => ({
      ...node,
      evidence_ids: [...node.evidence_ids].sort(),
      lineage_revision_ids: [...node.lineage_revision_ids].sort(),
    }))
    .sort(
      (left, right) =>
        compareCanonicalText(
          canonicalJson([
            left.abstraction,
            left.projection_revision_id ?? "",
            left.revision_id,
            left.graph_node_id,
          ]),
          canonicalJson([
            right.abstraction,
            right.projection_revision_id ?? "",
            right.revision_id,
            right.graph_node_id,
          ]),
        ),
    );
  const edges = value.edges
    .map((edge) => ({
      ...edge,
      evidence_ids: [...edge.evidence_ids].sort(),
      lineage_revision_ids: [...edge.lineage_revision_ids].sort(),
    }))
    .sort(
      (left, right) =>
        compareCanonicalText(
          canonicalJson([
            left.relation_type,
            left.relation_revision_id,
            left.graph_edge_id,
          ]),
          canonicalJson([
            right.relation_type,
            right.relation_revision_id,
            right.graph_edge_id,
          ]),
        ),
    );
  const canonical = snapshotPayload({ ...value, nodes, edges });
  return GraphScopeSnapshotSchema.parse({
    ...canonical,
    logical_digest: canonicalSha256(canonical),
  });
}

export const GraphQueryModeSchema = z.enum([
  "typed_path",
  "shortest_path",
]);

export const GraphQuerySchema = z
  .object({
    schema_version: ContractVersionSchema,
    query_id: IdentifierSchema,
    backend: GraphBackendSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    as_of: UtcTimestampSchema,
    frontier: ProjectionFrontierSchema,
    mode: GraphQueryModeSchema,
    start_revision_ids: z.array(IdentifierSchema).min(1).max(100),
    allowed_relation_revision_ids: z
      .array(IdentifierSchema)
      .min(1)
      .max(100_000),
    relation_pattern: z.array(RelationTypeSchema).min(1).max(4),
    max_depth: z.number().int().min(1).max(4),
    max_fanout: z.number().int().min(1).max(100),
    max_paths: z.number().int().min(1).max(1_000),
    max_results: z.number().int().min(1).max(1_000),
    max_relation_allowlist: z.number().int().min(1).max(100_000),
    parent_deadline_ms: z.number().int().min(1).max(60_000),
  })
  .strict()
  .superRefine((value, context) => {
    addUniqueIssue(
      value.start_revision_ids,
      context,
      ["start_revision_ids"],
      "graph query starts must be unique",
    );
    addUniqueIssue(
      value.allowed_relation_revision_ids,
      context,
      ["allowed_relation_revision_ids"],
      "graph relation allowlist identities must be unique",
    );
    if (value.relation_pattern.length > value.max_depth) {
      context.addIssue({
        code: "custom",
        path: ["relation_pattern"],
        message: "graph relation pattern cannot exceed maximum depth",
      });
    }
    if (
      value.allowed_relation_revision_ids.length >
      value.max_relation_allowlist
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowed_relation_revision_ids"],
        message: "graph relation allowlist exceeds its explicit bound",
      });
    }
    if (value.max_results > value.max_paths) {
      context.addIssue({
        code: "custom",
        path: ["max_results"],
        message: "graph result limit cannot exceed the path limit",
      });
    }
  });

const GraphPathEvidenceInputSchema = z
  .object({
    node_revision_ids: z.array(IdentifierSchema).min(2).max(5),
    relation_revision_ids: z.array(IdentifierSchema).min(1).max(4),
    relation_types: z.array(RelationTypeSchema).min(1).max(4),
    depth: z.number().int().min(1).max(4),
  })
  .strict();

function graphPathPayload(
  value: z.infer<typeof GraphPathEvidenceInputSchema>,
) {
  return {
    node_revision_ids: value.node_revision_ids,
    relation_revision_ids: value.relation_revision_ids,
    relation_types: value.relation_types,
    depth: value.depth,
  };
}

export const GraphPathEvidenceSchema =
  GraphPathEvidenceInputSchema.extend({
    path_hash: CanonicalHashSchema,
  }).superRefine((value, context) => {
    if (
      value.node_revision_ids.length !== value.depth + 1 ||
      value.relation_revision_ids.length !== value.depth ||
      value.relation_types.length !== value.depth
    ) {
      context.addIssue({
        code: "custom",
        path: ["depth"],
        message: "graph path nodes, relations, types, and depth must agree",
      });
    }
    addUniqueIssue(
      value.node_revision_ids,
      context,
      ["node_revision_ids"],
      "graph proof path nodes must be unique",
    );
    addUniqueIssue(
      value.relation_revision_ids,
      context,
      ["relation_revision_ids"],
      "graph proof path relations must be unique",
    );
    if (value.path_hash !== canonicalSha256(graphPathPayload(value))) {
      context.addIssue({
        code: "custom",
        path: ["path_hash"],
        message: "graph path hash must seal ordered path identity",
      });
    }
  });

export function buildGraphPathEvidence(
  input: unknown,
): z.infer<typeof GraphPathEvidenceSchema> {
  const value = GraphPathEvidenceInputSchema.parse(input);
  return GraphPathEvidenceSchema.parse({
    ...value,
    path_hash: canonicalSha256(graphPathPayload(value)),
  });
}

export const GraphProcessOutcomeSchema = z.enum([
  "completed",
  "disabled",
  "missing_dependency",
  "deadline_killed",
  "child_exited",
  "protocol_error",
  "circuit_open",
  "store_error",
]);

export const GraphQueryResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    query_id: IdentifierSchema,
    status: z.enum(["complete", "degraded", "unavailable"]),
    query_hash: CanonicalHashSchema,
    frontier: ProjectionFrontierSchema,
    paths: z.array(GraphPathEvidenceSchema).max(1_000),
    elapsed_ms: z.number().finite().nonnegative(),
    complete: z.boolean(),
    reason_codes: z.array(z.string().trim().min(1).max(200)),
    process_outcome: GraphProcessOutcomeSchema,
    bounded_work: z.array(BoundedWorkTelemetrySchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.complete !== (value.status === "complete")) {
      context.addIssue({
        code: "custom",
        path: ["complete"],
        message: "graph completion flag and status must agree",
      });
    }
    if (!value.complete && value.reason_codes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reason_codes"],
        message: "incomplete graph results require stable reason codes",
      });
    }
    if (value.status === "unavailable" && value.paths.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["paths"],
        message: "an unavailable graph cannot return paths",
      });
    }
    if (
      value.status === "complete" &&
      value.process_outcome !== "completed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["process_outcome"],
        message:
          "only a completed graph process may produce a complete result",
      });
    }
    if (
      value.bounded_work?.some((item) => !item.complete) === true &&
      value.complete
    ) {
      context.addIssue({
        code: "custom",
        path: ["bounded_work"],
        message:
          "incomplete bounded graph work cannot produce a complete result",
      });
    }
    const pathHashes = value.paths.map((path) => path.path_hash);
    addUniqueIssue(
      pathHashes,
      context,
      ["paths"],
      "graph result paths must be unique",
    );
  });

export const GraphFailureCodeSchema = z.enum([
  "GRAPH_DISABLED",
  "GRAPH_OPTIONAL_DEPENDENCY_MISSING",
  "GRAPH_IDENTITY_MISMATCH",
  "GRAPH_PROCESS_START_FAILED",
  "GRAPH_PROTOCOL_INVALID",
  "GRAPH_REQUEST_LIMIT_EXCEEDED",
  "GRAPH_DEADLINE_EXCEEDED",
  "GRAPH_CHILD_EXITED",
  "GRAPH_CIRCUIT_OPEN",
  "GRAPH_STORE_LOCKED",
  "GRAPH_STORE_CORRUPT",
  "GRAPH_SCOPE_STALE",
  "GRAPH_SCOPE_PENDING",
  "GRAPH_SCOPE_REBUILDING",
  "GRAPH_DIGEST_MISMATCH",
  "GRAPH_POSTVALIDATION_FAILED",
  "GRAPH_UNKNOWN_WORK",
]);

export const GraphProcessHealthSchema = z
  .object({
    schema_version: ContractVersionSchema,
    status: z.enum([
      "disabled",
      "starting",
      "ready",
      "quarantined",
      "circuit_open",
      "unavailable",
      "stopped",
    ]),
    backend_identity: GraphBackendIdentitySchema.nullable(),
    process_generation: z.number().int().nonnegative(),
    restart_count: z.number().int().nonnegative(),
    queue_depth: z.number().int().nonnegative(),
    active_requests: z.number().int().nonnegative(),
    database_path_hash: CanonicalHashSchema.nullable(),
    circuit_open_until: UtcTimestampSchema.nullable(),
    last_failure: GraphFailureCodeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "ready" &&
      (value.backend_identity === null || value.database_path_hash === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["backend_identity"],
        message: "ready graph health requires verified identity and path hash",
      });
    }
    if (
      value.status === "circuit_open" &&
      (value.circuit_open_until === null || value.last_failure === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["circuit_open_until"],
        message: "open graph circuit requires deadline and failure evidence",
      });
    }
  });

export const GraphScopeCheckpointSchema = z
  .object({
    schema_version: ContractVersionSchema,
    backend: GraphBackendSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    status: z.enum([
      "disabled",
      "pending",
      "rebuilding",
      "ready",
      "unavailable",
    ]),
    frontier: ProjectionFrontierSchema.nullable(),
    graph_projection_epoch: z.number().int().nonnegative(),
    logical_digest: CanonicalHashSchema.nullable(),
    backend_identity: GraphBackendIdentitySchema.nullable(),
    updated_at: UtcTimestampSchema,
    last_failure: GraphFailureCodeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "ready" &&
      (value.frontier === null ||
        value.logical_digest === null ||
        value.backend_identity === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "ready graph checkpoint requires frontier, digest, and identity",
      });
    }
    if (
      value.frontier !== null &&
      value.frontier.projection_epoch !== value.graph_projection_epoch
    ) {
      context.addIssue({
        code: "custom",
        path: ["graph_projection_epoch"],
        message: "graph checkpoint epoch must match its projection frontier",
      });
    }
    if (
      value.backend_identity !== null &&
      value.backend_identity.backend !== value.backend
    ) {
      context.addIssue({
        code: "custom",
        path: ["backend_identity", "backend"],
        message: "graph checkpoint backend identity must match",
      });
    }
  });

export const GraphDeliveryReceiptSchema = z
  .object({
    schema_version: ContractVersionSchema,
    receipt_id: IdentifierSchema,
    job_id: IdentifierSchema,
    operation: z.enum(["scope_replace", "full_rebuild"]),
    backend: GraphBackendSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    status: z.enum(["applied", "failed", "stale", "skipped"]),
    previous_frontier: ProjectionFrontierSchema.nullable(),
    resulting_frontier: ProjectionFrontierSchema.nullable(),
    logical_digest: CanonicalHashSchema.nullable(),
    backend_identity: GraphBackendIdentitySchema.nullable(),
    node_count: z.number().int().nonnegative(),
    edge_count: z.number().int().nonnegative(),
    duration_ms: z.number().finite().nonnegative(),
    completed_at: UtcTimestampSchema,
    failure_code: GraphFailureCodeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const applied = value.status === "applied";
    if (applied &&
        (value.resulting_frontier === null ||
          value.logical_digest === null ||
          value.backend_identity === null ||
          value.failure_code !== null)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "applied graph delivery requires result identity and no failure",
      });
    }
    if (
      !applied &&
      (value.resulting_frontier !== null ||
        value.logical_digest !== null ||
        value.backend_identity !== null ||
        value.failure_code === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure_code"],
        message:
          "non-applied graph delivery cannot publish result identity and requires a stable failure code",
      });
    }
  });

export const GraphStoreOperationSchema = z.enum([
  "health",
  "initialize",
  "replace_scope",
  "delete_scope",
  "read_scope_snapshot",
  "query_paths",
  "full_rebuild",
  "close",
]);

export const GraphDegradedReasonSchema = z
  .object({
    code: GraphFailureCodeSchema,
    message: NonEmptyReasonSchema,
    retryable: z.boolean(),
  })
  .strict();

export type GraphBackend = z.infer<typeof GraphBackendSchema>;
export type GraphBackendIdentity = z.infer<
  typeof GraphBackendIdentitySchema
>;
export type GraphDegradedReason = z.infer<
  typeof GraphDegradedReasonSchema
>;
export type GraphDeliveryReceipt = z.infer<
  typeof GraphDeliveryReceiptSchema
>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphFailureCode = z.infer<typeof GraphFailureCodeSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphPathEvidence = z.infer<typeof GraphPathEvidenceSchema>;
export type GraphProcessHealth = z.infer<typeof GraphProcessHealthSchema>;
export type GraphQuery = z.infer<typeof GraphQuerySchema>;
export type GraphQueryResult = z.infer<typeof GraphQueryResultSchema>;
export type GraphScopeCheckpoint = z.infer<
  typeof GraphScopeCheckpointSchema
>;
export type GraphScopeSnapshot = z.infer<typeof GraphScopeSnapshotSchema>;
export type GraphStoreOperation = z.infer<typeof GraphStoreOperationSchema>;

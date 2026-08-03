import {
  G4ACaseBodySchema,
  G4ACaseResultSchema,
  G4AProtocolIdentitySchema,
  GraphQueryResultSchema,
  GraphQuerySchema,
  GraphScopeSnapshotSchema,
  buildGraphScopeSnapshot,
  canonicalJson,
  canonicalSha256,
  type G4ACaseBody,
  type G4ACaseFamily,
  type G4ACaseResult,
  type G4AExpectedOutcomeSchema,
  type G4AProtocolIdentity,
  type GraphEdge,
  type GraphScopeSnapshot,
} from "@memo-graph/contracts";
import type { z } from "zod";

type G4AExpectedOutcome = z.infer<typeof G4AExpectedOutcomeSchema>;

type TopologyEdge = {
  relation_revision_id: string;
  source_revision_id: string;
  target_revision_id: string;
  relation_type: GraphEdge["relation_type"];
};

const FAMILY_TOPOLOGY = {
  typed_explanatory_path: [
    ["relation_supports_1", "revision_topic", "revision_dependency", "supports"],
    ["relation_depends_1", "revision_dependency", "revision_scenario", "depends_on"],
  ],
  temporal_conflict: [
    ["relation_conflict_1", "revision_fact_a", "revision_provenance", "contradicts"],
    ["relation_shared_provenance_1", "revision_provenance", "revision_fact_b", "supports"],
  ],
  scenario_migration: [
    ["relation_topic_1", "revision_conversation", "revision_topic", "belongs_to_topic"],
    ["relation_scenario_1", "revision_topic", "revision_scenario", "applies_to_scenario"],
    ["relation_other_scope_1", "revision_other_scope", "revision_scenario", "applies_to_scenario"],
  ],
  shortest_valid_proof: [
    ["relation_short_a1", "revision_start", "revision_mid_a", "supports"],
    ["relation_short_a2", "revision_mid_a", "revision_goal", "depends_on"],
    ["relation_short_b1", "revision_start", "revision_mid_b", "supports"],
    ["relation_short_b2", "revision_mid_b", "revision_goal", "depends_on"],
  ],
  cycle_fanout_pressure: [
    ["relation_cycle_ab", "revision_cycle_a", "revision_cycle_b", "supports"],
    ["relation_cycle_bc", "revision_cycle_b", "revision_cycle_c", "supports"],
    ["relation_cycle_ca", "revision_cycle_c", "revision_cycle_a", "supports"],
    ["relation_cycle_ad", "revision_cycle_a", "revision_cycle_d", "supports"],
  ],
  mid_path_correction: [
    ["relation_old_1", "revision_start", "revision_mid_old", "supports"],
    ["relation_old_2", "revision_mid_old", "revision_goal", "depends_on"],
    ["relation_new_1", "revision_start", "revision_mid_new", "supports"],
    ["relation_new_2", "revision_mid_new", "revision_goal", "depends_on"],
  ],
} as const satisfies Record<
  G4ACaseFamily,
  readonly (readonly [
    string,
    string,
    string,
    GraphEdge["relation_type"],
  ])[]
>;

const FAMILY_EVIDENCE = {
  typed_explanatory_path: {
    revision_topic: ["evidence_topic"],
    revision_scenario: ["evidence_scenario"],
  },
  temporal_conflict: {
    revision_fact_a: ["evidence_fact_a"],
    revision_provenance: ["evidence_shared"],
    revision_fact_b: ["evidence_fact_b"],
  },
  scenario_migration: {
    revision_conversation: ["evidence_conversation"],
    revision_scenario: ["evidence_scenario"],
  },
  shortest_valid_proof: {
    revision_start: ["evidence_start"],
    revision_goal: ["evidence_goal"],
  },
  cycle_fanout_pressure: {},
  mid_path_correction: {
    revision_start: ["evidence_start"],
    revision_mid_new: ["evidence_mid_new"],
    revision_goal: ["evidence_goal"],
  },
} as const satisfies Record<G4ACaseFamily, Record<string, readonly string[]>>;

function topology(caseBody: G4ACaseBody): TopologyEdge[] {
  const declaredRelations = new Set<string>(
    caseBody.input_relation_revision_ids as readonly string[],
  );
  const declaredRevisions = new Set<string>(
    caseBody.input_revision_ids as readonly string[],
  );
  const prohibited = new Set<string>(
    caseBody.prohibited_revision_ids as readonly string[],
  );
  const edges = FAMILY_TOPOLOGY[caseBody.family].map((entry) => ({
    relation_revision_id: entry[0],
    source_revision_id: entry[1],
    target_revision_id: entry[2],
    relation_type: entry[3],
  }));
  if (
    edges.some(
      (edge) =>
        !declaredRelations.has(edge.relation_revision_id) ||
        !declaredRevisions.has(edge.source_revision_id) ||
        !declaredRevisions.has(edge.target_revision_id),
    ) ||
    new Set(edges.map((edge) => edge.relation_revision_id)).size !==
      declaredRelations.size
  ) {
    throw new Error(`G4A ${caseBody.case_id} topology identity mismatch`);
  }
  return edges.filter(
    (edge) =>
      !prohibited.has(edge.source_revision_id) &&
      !prohibited.has(edge.target_revision_id),
  );
}

export function materializeG4ACaseSnapshot(
  input: unknown,
): GraphScopeSnapshot {
  const body = G4ACaseBodySchema.parse(input);
  const prohibited = new Set<string>(
    body.prohibited_revision_ids as readonly string[],
  );
  const topologyEdges = topology(body);
  const caseHash = canonicalSha256(body);
  const frontier = {
    schema_version: "1.0.0",
    ledger_epoch: 1,
    tombstone_epoch: body.prohibited_revision_ids.length,
    projection_epoch: 1,
    transform: {
      name: "g4a-frozen-topology-materializer",
      version: "1.0.0",
    },
    source_frontier_hash: canonicalSha256({
      case_hash: caseHash,
      revisions: body.input_revision_ids,
    }),
    projection_frontier_hash: canonicalSha256({
      case_hash: caseHash,
      relations: body.input_relation_revision_ids,
    }),
  } as const;
  const evidence = FAMILY_EVIDENCE[body.family] as Record<
    string,
    readonly string[]
  >;
  const fallbackEvidenceId =
    body.expected.evidence_ids[0] ??
    `evidence:${canonicalSha256({
      case_id: body.case_id,
      topology_only: true,
    }).slice("sha256:".length, 55)}`;
  const nodes = body.input_revision_ids
    .filter((revisionId) => !prohibited.has(revisionId))
    .map((revisionId) => ({
      schema_version: "1.0.0" as const,
      graph_node_id: `g4a-node:${canonicalSha256({
        case_id: body.case_id,
        revision_id: revisionId,
      }).slice("sha256:".length, 54)}`,
      revision_id: revisionId,
      projection_revision_id: null,
      principal_id: body.principal_id,
      scope: body.scope,
      abstraction: "l1_memory" as const,
      projection_type: null,
      lifecycle: "active" as const,
      validity: {
        valid_from: "2026-07-28T00:00:00.000Z",
        valid_to: null,
        recorded_at: "2026-07-28T00:00:00.000Z",
      },
      ledger_epoch: frontier.ledger_epoch,
      tombstone_epoch: frontier.tombstone_epoch,
      projection_epoch: frontier.projection_epoch,
      content_hash: canonicalSha256({
        case_id: body.case_id,
        revision_id: revisionId,
        envelope: "content-free",
      }),
      payload_hash: canonicalSha256({
        case_id: body.case_id,
        revision_id: revisionId,
        topology_only: true,
      }),
      transform: frontier.transform,
      evidence_ids: [
        ...(evidence[revisionId] ?? [fallbackEvidenceId]),
      ].sort(),
      lineage_revision_ids: [revisionId],
    }));
  const edges = topologyEdges.map((edge) => ({
    schema_version: "1.0.0" as const,
    graph_edge_id: `g4a-edge:${canonicalSha256({
      case_id: body.case_id,
      relation_revision_id: edge.relation_revision_id,
    }).slice("sha256:".length, 54)}`,
    relation_id: `relation:${edge.relation_revision_id}`,
    relation_revision_id: edge.relation_revision_id,
    projection_revision_id: edge.relation_revision_id,
    source_revision_id: edge.source_revision_id,
    target_revision_id: edge.target_revision_id,
    relation_type: edge.relation_type,
    direction: "directed" as const,
    principal_id: body.principal_id,
    scope: body.scope,
    validity: {
      valid_from: "2026-07-28T00:00:00.000Z",
      valid_to: null,
      recorded_at: "2026-07-28T00:00:00.000Z",
    },
    ledger_epoch: frontier.ledger_epoch,
    tombstone_epoch: frontier.tombstone_epoch,
    projection_epoch: frontier.projection_epoch,
    content_hash: canonicalSha256({
      case_id: body.case_id,
      relation_revision_id: edge.relation_revision_id,
      envelope: "content-free",
    }),
    payload_hash: canonicalSha256(edge),
    transform: frontier.transform,
    evidence_ids: [fallbackEvidenceId],
    lineage_revision_ids: [
      edge.source_revision_id,
      edge.target_revision_id,
    ].sort(),
  }));
  return buildGraphScopeSnapshot({
    schema_version: "1.0.0",
    backend: "ladybugdb",
    principal_id: body.principal_id,
    scope: body.scope,
    frontier,
    nodes,
    edges,
  });
}

export function g4aQueryForCase(options: {
  body: unknown;
  snapshot: unknown;
}) {
  const body = G4ACaseBodySchema.parse(options.body);
  const snapshot = GraphScopeSnapshotSchema.parse(options.snapshot);
  if (
    canonicalJson(snapshot) !==
      canonicalJson(materializeG4ACaseSnapshot(body))
  ) {
    throw new Error("G4A snapshot does not match frozen case materialization");
  }
  return GraphQuerySchema.parse({
    schema_version: "1.0.0",
    query_id: `g4a-query:${canonicalSha256({
      case_id: body.case_id,
      query: body.query,
      frontier: snapshot.frontier,
    }).slice("sha256:".length, 55)}`,
    backend: "ladybugdb",
    principal_id: body.principal_id,
    scope: body.scope,
    as_of: body.as_of,
    frontier: snapshot.frontier,
    mode: body.query.mode,
    start_revision_ids: body.query.start_revision_ids,
    allowed_relation_revision_ids: snapshot.edges
      .map((edge) => edge.relation_revision_id)
      .sort(),
    relation_pattern: body.query.relation_pattern,
    max_depth: body.query.max_depth,
    max_fanout: body.query.max_fanout,
    max_paths: body.query.max_paths,
    max_results: body.query.max_results,
    max_relation_allowlist: body.query.max_relation_allowlist,
    parent_deadline_ms: body.query.parent_deadline_ms,
  });
}

export function outcomeFromGraphResult(options: {
  body: unknown;
  snapshot: unknown;
  result: unknown;
}): G4AExpectedOutcome {
  const body = G4ACaseBodySchema.parse(options.body);
  const snapshot = GraphScopeSnapshotSchema.parse(options.snapshot);
  const result = GraphQueryResultSchema.parse(options.result);
  const nodeEvidence = new Map(
    snapshot.nodes.map((node) => [
      node.revision_id,
      node.evidence_ids,
    ]),
  );
  const revisionIds = [
    ...new Set(
      result.paths.flatMap((path) => path.node_revision_ids),
    ),
  ].sort();
  const evidenceIds = [
    ...new Set(
      revisionIds.flatMap(
        (revisionId) => nodeEvidence.get(revisionId) ?? [],
      ),
    ),
  ].sort();
  const reasonCodes = [...new Set(result.reason_codes)].sort();
  if (
    body.family === "shortest_valid_proof" &&
    result.complete &&
    result.paths.length === 1
  ) {
    reasonCodes.push("TIE_BREAK_PATH_HASH");
  }
  if (
    body.family === "mid_path_correction" &&
    body.prohibited_revision_ids.every(
      (revisionId) => !revisionIds.includes(revisionId),
    )
  ) {
    reasonCodes.push("CORRECTED_PREDECESSOR_EXCLUDED");
  }
  return {
    status: result.complete ? "complete" : "degraded",
    revision_ids: revisionIds,
    ordered_paths: result.paths,
    evidence_ids: evidenceIds,
    complete: result.complete,
    abstain: result.paths.length === 0,
    reason_codes: [...new Set(reasonCodes)].sort(),
  };
}

export function acceptedG3RStructuralOutcome(): G4AExpectedOutcome {
  return {
    status: "degraded",
    revision_ids: [],
    ordered_paths: [],
    evidence_ids: [],
    complete: false,
    abstain: true,
    reason_codes: ["STRUCTURAL_PROOF_PROTOCOL_UNAVAILABLE"],
  };
}

export type G4AStructuralScore = {
  exact_revision_set: boolean;
  ordered_proof_paths: boolean;
  exact_evidence: boolean;
  completeness: boolean;
  abstention: boolean;
  reason_codes: boolean;
  passed: boolean;
};

export function scoreG4AOutcome(
  expectedInput: unknown,
  actualInput: unknown,
): G4AStructuralScore {
  const expected = G4ACaseBodySchema.shape.expected.parse(expectedInput);
  const actual = G4ACaseBodySchema.shape.expected.parse(actualInput);
  const score = {
    exact_revision_set:
      canonicalJson([...actual.revision_ids].sort()) ===
      canonicalJson([...expected.revision_ids].sort()),
    ordered_proof_paths:
      canonicalJson(actual.ordered_paths) ===
      canonicalJson(expected.ordered_paths),
    exact_evidence:
      canonicalJson([...actual.evidence_ids].sort()) ===
      canonicalJson([...expected.evidence_ids].sort()),
    completeness:
      actual.status === expected.status &&
      actual.complete === expected.complete,
    abstention: actual.abstain === expected.abstain,
    reason_codes:
      canonicalJson([...actual.reason_codes].sort()) ===
      canonicalJson([...expected.reason_codes].sort()),
  };
  return {
    ...score,
    passed: Object.values(score).every(Boolean),
  };
}

export function sealG4ACaseResult(options: {
  identity: G4AProtocolIdentity;
  actual: G4AExpectedOutcome;
  expected: G4AExpectedOutcome;
  strictGain: boolean;
  governanceViolations?: string[];
}): G4ACaseResult {
  const identity = G4AProtocolIdentitySchema.parse(options.identity);
  const score = scoreG4AOutcome(options.expected, options.actual);
  const withoutHash = {
    identity,
    status:
      (options.governanceViolations?.length ?? 0) > 0
        ? "invalid"
        : score.passed
          ? "passed"
          : options.actual.complete
            ? "failed"
            : "degraded",
    actual: options.actual,
    strict_gain: options.strictGain,
    governance_violations: options.governanceViolations ?? [],
  } as const;
  return G4ACaseResultSchema.parse({
    ...withoutHash,
    result_hash: canonicalSha256(withoutHash),
  });
}

export function assertComparableG4AIdentities(
  identities: readonly G4AProtocolIdentity[],
): void {
  if (identities.length !== 3) {
    throw new Error("G4A comparison requires exactly three arms");
  }
  const parsed = identities.map((identity) =>
    G4AProtocolIdentitySchema.parse(identity)
  );
  const [accepted, disabled, enabled] = parsed;
  if (
    accepted === undefined ||
    disabled === undefined ||
    enabled === undefined ||
    accepted.arm !== "accepted_g3r" ||
    disabled.arm !== "m4a_graph_disabled_reference" ||
    enabled.arm !== "m4a_graph_enabled"
  ) {
    throw new Error("G4A arm order or identity is invalid");
  }
  const common = (identity: G4AProtocolIdentity) => ({
    case_id: identity.case_id,
    partition: identity.partition,
    manifest_hash: identity.manifest_hash,
    case_hash: identity.case_hash,
    query_hash: identity.query_hash,
    policy_hash: identity.policy_hash,
    frontier_hash: identity.frontier_hash,
    thresholds_hash: identity.thresholds_hash,
  });
  if (
    canonicalJson(common(accepted)) !== canonicalJson(common(disabled)) ||
    canonicalJson(common(disabled)) !== canonicalJson(common(enabled)) ||
    disabled.candidate_commit !== enabled.candidate_commit ||
    disabled.dependency_lock_hash !== enabled.dependency_lock_hash
  ) {
    throw new Error("G4A comparison identity drift");
  }
}

export function materializeG4AExpectedProfile(input: {
  active_l1_memories: number;
  l2_l3_projections: number;
  relations: number;
  scope_count?: number;
}): GraphScopeSnapshot[] {
  const scopeCount = input.scope_count ?? 100;
  for (const [name, value] of Object.entries({
    active_l1_memories: input.active_l1_memories,
    l2_l3_projections: input.l2_l3_projections,
    relations: input.relations,
    scope_count: scopeCount,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`G4A Expected ${name} must be a positive integer`);
    }
  }
  if (
    input.active_l1_memories < scopeCount ||
    input.l2_l3_projections < scopeCount ||
    input.relations < scopeCount
  ) {
    throw new Error("G4A Expected profile cannot leave an empty scope");
  }

  const share = (total: number, index: number): number =>
    Math.floor(total / scopeCount) +
    (index < total % scopeCount ? 1 : 0);
  const snapshots = [];
  for (let scopeIndex = 0; scopeIndex < scopeCount; scopeIndex += 1) {
    const scope = {
      kind: "workspace" as const,
      id: `g4a_expected_${String(scopeIndex).padStart(3, "0")}`,
    };
    const l1Count = share(input.active_l1_memories, scopeIndex);
    const projectionCount = share(
      input.l2_l3_projections,
      scopeIndex,
    );
    const relationCount = share(input.relations, scopeIndex);
    const transform = {
      name: "g4a-expected-profile",
      version: "1.0.0",
    };
    const frontier = {
      schema_version: "1.0.0",
      ledger_epoch: 1,
      tombstone_epoch: 0,
      projection_epoch: 1,
      transform,
      source_frontier_hash: canonicalSha256({
        scope,
        l1_count: l1Count,
      }),
      projection_frontier_hash: canonicalSha256({
        scope,
        projection_count: projectionCount,
        relation_count: relationCount,
      }),
    } as const;
    const revisionIds = Array.from(
      { length: l1Count },
      (_, index) =>
        `revision_expected_${scopeIndex}_${index}`,
    );
    const nodes = [
      ...revisionIds.map((revisionId) => ({
        schema_version: "1.0.0" as const,
        graph_node_id: `g4a-node:${canonicalSha256({
          scope,
          revision_id: revisionId,
        }).slice("sha256:".length, 54)}`,
        revision_id: revisionId,
        projection_revision_id: null,
        principal_id: "user_local",
        scope,
        abstraction: "l1_memory" as const,
        projection_type: null,
        lifecycle: "active" as const,
        validity: {
          valid_from: "2026-07-29T00:00:00.000Z",
          valid_to: null,
          recorded_at: "2026-07-29T00:00:00.000Z",
        },
        ledger_epoch: 1,
        tombstone_epoch: 0,
        projection_epoch: 1,
        content_hash: canonicalSha256({
          revision_id: revisionId,
          content_free: true,
        }),
        payload_hash: canonicalSha256({
          revision_id: revisionId,
          envelope_only: true,
        }),
        transform,
        evidence_ids: [`evidence_expected_${scopeIndex}_${revisionId}`],
        lineage_revision_ids: [revisionId],
      })),
      ...Array.from({ length: projectionCount }, (_, index) => {
        const revisionId =
          `projection_revision_expected_${scopeIndex}_${index}`;
        const sourceRevision =
          revisionIds[index % revisionIds.length] as string;
        return {
          schema_version: "1.0.0" as const,
          graph_node_id: `g4a-node:${canonicalSha256({
            scope,
            revision_id: revisionId,
          }).slice("sha256:".length, 54)}`,
          revision_id: revisionId,
          projection_revision_id: revisionId,
          principal_id: "user_local",
          scope,
          abstraction: "l2_topic" as const,
          projection_type: "topic" as const,
          lifecycle: "active" as const,
          validity: {
            valid_from: "2026-07-29T00:00:00.000Z",
            valid_to: null,
            recorded_at: "2026-07-29T00:00:00.000Z",
          },
          ledger_epoch: 1,
          tombstone_epoch: 0,
          projection_epoch: 1,
          content_hash: canonicalSha256({
            revision_id: revisionId,
            content_free: true,
          }),
          payload_hash: canonicalSha256({
            revision_id: revisionId,
            envelope_only: true,
          }),
          transform,
          evidence_ids: [
            `evidence_expected_${scopeIndex}_${sourceRevision}`,
          ],
          lineage_revision_ids: [sourceRevision],
        };
      }),
    ];
    const edges = Array.from({ length: relationCount }, (_, index) => {
      const sourceRevision =
        revisionIds[index % revisionIds.length] as string;
      const targetRevision =
        revisionIds[(index * 17 + 1) % revisionIds.length] as string;
      const relationRevisionId =
        `relation_revision_expected_${scopeIndex}_${index}`;
      return {
        schema_version: "1.0.0" as const,
        graph_edge_id: `g4a-edge:${canonicalSha256({
          scope,
          relation_revision_id: relationRevisionId,
        }).slice("sha256:".length, 54)}`,
        relation_id: `relation_expected_${scopeIndex}_${index}`,
        relation_revision_id: relationRevisionId,
        projection_revision_id: relationRevisionId,
        source_revision_id: sourceRevision,
        target_revision_id: targetRevision,
        relation_type: "supports" as const,
        direction: "directed" as const,
        principal_id: "user_local",
        scope,
        validity: {
          valid_from: "2026-07-29T00:00:00.000Z",
          valid_to: null,
          recorded_at: "2026-07-29T00:00:00.000Z",
        },
        ledger_epoch: 1,
        tombstone_epoch: 0,
        projection_epoch: 1,
        content_hash: canonicalSha256({
          relation_revision_id: relationRevisionId,
          content_free: true,
        }),
        payload_hash: canonicalSha256({
          source_revision_id: sourceRevision,
          target_revision_id: targetRevision,
          relation_type: "supports",
        }),
        transform,
        evidence_ids: [
          `evidence_expected_${scopeIndex}_${sourceRevision}`,
        ],
        lineage_revision_ids: [
          sourceRevision,
          targetRevision,
        ].sort(),
      };
    });
    snapshots.push(buildGraphScopeSnapshot({
      schema_version: "1.0.0",
      backend: "ladybugdb",
      principal_id: "user_local",
      scope,
      frontier,
      nodes,
      edges,
    }));
  }
  return snapshots;
}

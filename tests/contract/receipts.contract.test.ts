import { describe, expect, it } from "vitest";

import {
  CanaryReceiptSchema,
  CandidateTransitionReceiptSchema,
  LearningControlReceiptSchema,
  LearningStopReceiptSchema,
  MonitorReceiptSchema,
  MutationReceiptSchema,
  PurgeReceiptSchema,
  ReceiptSchema,
  RetrievalReceiptItemSchema,
  RetrievalReceiptSchema,
  buildContextFrontierV2,
  buildGraphPathEvidence,
  canonicalSha256Omitting,
  receiptHashIsValid,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import { HASH_A, HASH_B, NOW } from "../helpers/examples.js";

describe("receipt contracts", () => {
  it("seals mutation receipts with deterministic canonical hashes", () => {
    const receipt = MutationReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: "receipt_mutation_1",
        created_at: NOW,
        state: "durable",
        request_hash: HASH_A,
        kind: "mutation",
        idempotency_key: "mutation-request-001",
        affected_memory_ids: ["memory_pref"],
        affected_revision_ids: ["revision_pref_1"],
        resulting_epoch: 1,
        projection_jobs: ["job_1"],
        warnings: [],
      }),
    );

    expect(receiptHashIsValid(receipt)).toBe(true);
    expect(receipt.receipt_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("requires receipt identity, state, and hashes for every result kind", () => {
    expect(
      ReceiptSchema.safeParse({
        kind: "mutation",
        schema_version: "1.0.0",
        created_at: NOW,
        state: "durable",
      }).success,
    ).toBe(false);
  });

  it("seals privacy-minimal learning stop and transition receipts", () => {
    const feedbackInput = {
      schema_version: "1.0.0",
      feedback_id: "feedback_task_1",
      task_id: "task_1",
      context_slice_id: "context_1",
      outcome: "failed",
      evidence_ids: ["evidence_1"],
      error_codes: ["NO_RELEVANT_MEMORY"],
      gap_codes: ["RETRIEVAL_POLICY_TOO_BROAD"],
      observed_at: NOW,
      feedback_hash: HASH_A,
    } as const;
    const feedback = {
      ...feedbackInput,
      feedback_hash: canonicalSha256Omitting(feedbackInput, [
        "feedback_hash",
      ]),
    };
    const stop = LearningStopReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: "receipt_learning_stop_1",
        created_at: NOW,
        state: "durable",
        request_hash: HASH_A,
        kind: "learning_stop",
        principal_id: "user_local",
        trace_id: "trace_1",
        candidate_id: null,
        control_epoch: 0,
        reason_code: "TRACE_INCOMPLETE",
        feedback,
      }),
    );
    const transition = CandidateTransitionReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: "receipt_transition_1",
        created_at: NOW,
        state: "durable",
        request_hash: HASH_A,
        kind: "learning_transition",
        candidate_id: "candidate_1",
        transition_id: "transition_1",
        sequence: 1,
        from_state: "proposed",
        to_state: "quarantined",
        authority_id: null,
        evidence_receipt_ids: ["receipt_learning_stop_1"],
        control_epoch: 0,
      }),
    );
    expect(receiptHashIsValid(stop)).toBe(true);
    expect(receiptHashIsValid(transition)).toBe(true);
    expect(stop.feedback).toMatchObject({
      task_id: "task_1",
      context_slice_id: "context_1",
      outcome: "failed",
      evidence_ids: ["evidence_1"],
      error_codes: ["NO_RELEVANT_MEMORY"],
      gap_codes: ["RETRIEVAL_POLICY_TOO_BROAD"],
    });
    expect(
      LearningStopReceiptSchema.safeParse({
        ...stop,
        feedback: {
          ...stop.feedback,
          evidence_ids: ["evidence_1", "evidence_1"],
        },
      }).success,
    ).toBe(false);
  });

  it("binds canary, monitor, and learning-control receipts to exact releases", () => {
    const canary = CanaryReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: "receipt_canary_1",
        created_at: NOW,
        state: "durable",
        request_hash: HASH_A,
        kind: "learning_canary",
        candidate_id: "candidate_1",
        authorization_id: "canary_authorization_1",
        authorization_hash: HASH_B,
        evaluation_receipt_id: "receipt_eval_1",
        canary_manifest_hash: HASH_A,
        exposures: 3,
        passed: true,
        failure_codes: [],
        control_epoch: 0,
      }),
    );
    const monitor = MonitorReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: "receipt_monitor_1",
        created_at: NOW,
        state: "durable",
        request_hash: HASH_A,
        kind: "learning_monitor",
        release_id: "release_1",
        pointer_revision: 1,
        canary_receipt_id: canary.receipt_id,
        monitor_contract_hash: HASH_B,
        replayed_case_ids: ["canary_case_1", "canary_case_2", "canary_case_3"],
        passed: true,
        failure_codes: [],
        rollback_required: false,
      }),
    );
    const control = LearningControlReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: "receipt_control_1",
        created_at: NOW,
        state: "durable",
        request_hash: HASH_A,
        kind: "learning_control",
        principal_id: "user_local",
        action: "pause",
        previous_epoch: 0,
        resulting_epoch: 1,
        previous_frontier_hash: HASH_A,
        frontier_hash: HASH_B,
        runtime_identity_hash: HASH_A,
        configuration_hash: HASH_B,
        corpus_hash: HASH_A,
        reason_code: "USER_REQUESTED",
      }),
    );
    expect(receiptHashIsValid(monitor)).toBe(true);
    expect(receiptHashIsValid(control)).toBe(true);
    expect(
      MonitorReceiptSchema.safeParse({
        ...monitor,
        canary_receipt_id: undefined,
      }).success,
    ).toBe(false);
  });

  it("seals layered retrieval receipts with effective lane and frontier evidence", () => {
    const receipt = RetrievalReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: "receipt_layered_1",
        created_at: NOW,
        state: "durable",
        request_hash: HASH_A,
        kind: "retrieval",
        context_slice_id: "context_layered_1",
        compiler_version: "2.0.0",
        policy_version: "2.0.0",
        frontier: {
          schema_version: "1.0.0",
          ledger_epoch: 10,
          tombstone_epoch: 2,
          projection_epoch: 4,
          source_frontier_hash: HASH_A,
          projection_frontier_hash: HASH_B,
          transform_versions: [
            {
              name: "deterministic-g3-projection",
              version: "1.0.0",
            },
          ],
        },
        effective_lane_configuration: {
          policy_hash: HASH_A,
          requested_lanes: ["topic"],
          enabled_lanes: ["topic"],
          limits: {
            max_candidates_per_lane: 50,
            relation_max_depth: 2,
            relation_max_fanout: 10,
            max_concurrent_lanes: 1,
          },
          reason_codes: [],
        },
        lane_telemetry: [
          {
            lane: "topic",
            status: "eligible",
            duration_ms: 1,
            candidate_count: 1,
            eligible_count: 1,
            selected_count: 1,
            exclusion_counts: {},
            reason_codes: [],
          },
        ],
        items: [
          {
            memory_id: "projection_topic",
            revision_id: "projection_revision_topic_1",
            decision: "included",
            reason_codes: ["TOPIC_UTILITY"],
            lane: "topic",
            score: 1,
            score_components: {
              relevance: 1,
              authority: 0,
              freshness: 1,
              evidence_diversity: 1,
              conflict_cost: 0,
              token_utility: 1,
              lane_contribution: 1,
            },
            token_estimate: 24,
            projection: {
              projection_id: "projection_topic",
              projection_revision_id: "projection_revision_topic_1",
              source_revision_ids: [
                "revision_source_a",
                "revision_source_b",
              ],
              source_content_hashes: [HASH_A, HASH_B],
              transform: {
                name: "deterministic-g3-projection",
                version: "1.0.0",
              },
              frontier: {
                schema_version: "1.0.0",
                ledger_epoch: 10,
                tombstone_epoch: 2,
                projection_epoch: 4,
                transform: {
                  name: "deterministic-g3-projection",
                  version: "1.0.0",
                },
                source_frontier_hash: HASH_A,
                projection_frontier_hash: HASH_B,
              },
            },
            conflict_group_id: null,
          },
        ],
      }),
    );

    expect(receiptHashIsValid(receipt)).toBe(true);
    expect(receipt.lane_telemetry?.[0]?.selected_count).toBe(1);
  });

  it("binds retrieval receipts to the effective active learning release", () => {
    const receipt = {
      schema_version: "1.0.0",
      receipt_id: "receipt_learning_release_1",
      created_at: NOW,
      state: "durable",
      request_hash: HASH_A,
      kind: "retrieval",
      context_slice_id: "context_learning_release_1",
      compiler_version: "1.0.0",
      policy_version: "1.0.0",
      effective_lane_configuration: {
        policy_hash: HASH_A,
        active_learning_release_id: "release_1",
        active_learning_release_hash: HASH_B,
        requested_lanes: ["recent_l1"],
        enabled_lanes: ["recent_l1"],
        limits: {
          max_candidates_per_lane: 10,
          max_concurrent_lanes: 1,
          relation_max_depth: 2,
          relation_max_fanout: 10,
        },
        reason_codes: [],
      },
      active_learning_release_id: "release_1",
      active_learning_release_hash: HASH_B,
      items: [],
    } as const;

    expect(
      RetrievalReceiptSchema.safeParse(sealReceipt(receipt)).success,
    ).toBe(true);
    expect(
      RetrievalReceiptSchema.safeParse(
        sealReceipt({
          ...receipt,
          active_learning_release_hash: HASH_A,
        }),
      ).success,
    ).toBe(false);
    expect(
      RetrievalReceiptSchema.safeParse(
        sealReceipt(
          (({
            active_learning_release_id: _releaseId,
            active_learning_release_hash: _releaseHash,
            ...withoutReleaseIdentity
          }) => withoutReleaseIdentity)(receipt),
        ),
      ).success,
    ).toBe(false);
  });

  it("seals canonical V2 scoped frontier and bounded-work evidence", () => {
    const frontier = buildContextFrontierV2({
      ledger_epoch: 10,
      tombstone_epoch: 2,
      scope_frontiers: [
        {
          scope: { kind: "workspace", id: "workspace_local" },
          projection_epoch: 7,
          source_frontier_hash: HASH_A,
          projection_frontier_hash: HASH_B,
          transform_versions: [
            {
              name: "deterministic-g3-projection",
              version: "1.0.0",
            },
          ],
        },
      ],
    });
    const receipt = RetrievalReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.1.0",
        receipt_id: "receipt_layered_v2_1",
        created_at: NOW,
        state: "partial",
        request_hash: HASH_A,
        kind: "retrieval",
        context_slice_id: "context_layered_v2_1",
        compiler_version: "1.1.0",
        policy_version: "1.0.0",
        frontier,
        effective_lane_configuration: {
          policy_hash: HASH_A,
          requested_lanes: ["topic"],
          enabled_lanes: ["topic"],
          limits: {
            max_candidates_per_lane: 20,
            relation_max_depth: 2,
            relation_max_fanout: 10,
            max_concurrent_lanes: 1,
            max_projection_scan_per_lane: 100,
            max_source_revisions_per_batch: 1_000,
            relation_max_starts: 50,
          },
          reason_codes: [],
        },
        lane_telemetry: [
          {
            lane: "topic",
            status: "degraded",
            duration_ms: 1,
            candidate_count: 1,
            eligible_count: 1,
            selected_count: 1,
            exclusion_counts: {},
            reason_codes: ["PROJECTION_SCAN_LIMIT"],
            bounded_work: [
              {
                boundary: "projection_scan",
                configured_limit: 100,
                observed_count: 101,
                retained_count: 100,
                truncated_count: 1,
                complete: false,
                reason_code: "PROJECTION_SCAN_LIMIT",
              },
            ],
          },
        ],
        items: [],
      }),
    );

    expect(receiptHashIsValid(receipt)).toBe(true);
    expect(receipt.frontier).toEqual(frontier);
    expect(receipt.lane_telemetry?.[0]?.bounded_work?.[0]).toMatchObject({
      boundary: "projection_scan",
      truncated_count: 1,
      complete: false,
    });
  });

  it("requires ordered graph proof metadata only on relation_graph items", () => {
    const graphPath = buildGraphPathEvidence({
      node_revision_ids: ["revision_start", "revision_goal"],
      relation_revision_ids: ["relation_revision_1"],
      relation_types: ["supports"],
      depth: 1,
    });
    const item = {
      memory_id: "projection_relation_1",
      revision_id: "projection_relation_revision_1",
      decision: "included",
      reason_codes: ["GRAPH_PATH_UTILITY"],
      lane: "relation_graph",
      score: 1,
      score_components: {
        relevance: 1,
        authority: 0,
        freshness: 1,
        evidence_diversity: 1,
        conflict_cost: 0,
        token_utility: 1,
        lane_contribution: 1,
      },
      token_estimate: 16,
      projection: {
        projection_id: "projection_relation_1",
        projection_revision_id: "projection_relation_revision_1",
        source_revision_ids: ["revision_source_1"],
        source_content_hashes: [HASH_A],
        transform: {
          name: "deterministic-g3-projection",
          version: "1.0.0",
        },
        frontier: {
          schema_version: "1.0.0",
          ledger_epoch: 10,
          tombstone_epoch: 2,
          projection_epoch: 4,
          transform: {
            name: "deterministic-g3-projection",
            version: "1.0.0",
          },
          source_frontier_hash: HASH_A,
          projection_frontier_hash: HASH_B,
        },
      },
      graph_path: graphPath,
      conflict_group_id: null,
    } as const;

    expect(RetrievalReceiptItemSchema.safeParse(item).success).toBe(true);
    expect(
      RetrievalReceiptItemSchema.safeParse({
        ...item,
        graph_path: undefined,
      }).success,
    ).toBe(false);
    expect(
      RetrievalReceiptItemSchema.safeParse({
        ...item,
        lane: "relation_sqlite",
      }).success,
    ).toBe(false);
  });

  it("requires vector evidence only on semantic_vector receipt items", () => {
    const item = {
      memory_id: "memory_vector_1",
      revision_id: "revision_vector_1",
      decision: "included",
      reason_codes: ["SEMANTIC_VECTOR_REVALIDATED"],
      lane: "semantic_vector",
      score: 0.875,
      token_estimate: 16,
      vector: {
        schema_version: "1.0.0",
        embedding_epoch_id: HASH_A,
        generation_id: "generation_1",
        source_frontier_hash: HASH_B,
        distance: 0.125,
        rank: 1,
        canonical_revalidated: true,
      },
    } as const;
    expect(RetrievalReceiptItemSchema.safeParse(item).success).toBe(true);
    expect(
      RetrievalReceiptItemSchema.safeParse({
        ...item,
        vector: undefined,
      }).success,
    ).toBe(false);
    expect(
      RetrievalReceiptItemSchema.safeParse({
        ...item,
        lane: "recent_l1",
      }).success,
    ).toBe(false);
  });

  it("cannot complete a purge while residual content remains", () => {
    expect(
      PurgeReceiptSchema.safeParse(
        sealReceipt({
          schema_version: "1.0.0",
          receipt_id: "receipt_purge_1",
          created_at: NOW,
          state: "purged",
          request_hash: HASH_A,
          kind: "purge",
          purge_job_id: "purge_job_1",
          target_memory_ids: ["memory_pref"],
          tombstone_epoch: 2,
          stores_checked: ["sqlite", "fts", "blobs"],
          residual_hashes: [HASH_A],
          completed: true,
        }),
      ).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  MutationReceiptSchema,
  PurgeReceiptSchema,
  ReceiptSchema,
  RetrievalReceiptItemSchema,
  RetrievalReceiptSchema,
  buildContextFrontierV2,
  buildGraphPathEvidence,
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

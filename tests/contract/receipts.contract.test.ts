import { describe, expect, it } from "vitest";

import {
  MutationReceiptSchema,
  PurgeReceiptSchema,
  ReceiptSchema,
  RetrievalReceiptSchema,
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

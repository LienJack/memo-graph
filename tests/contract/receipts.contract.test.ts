import { describe, expect, it } from "vitest";

import {
  MutationReceiptSchema,
  PurgeReceiptSchema,
  ReceiptSchema,
  receiptHashIsValid,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import { HASH_A, NOW } from "../helpers/examples.js";

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

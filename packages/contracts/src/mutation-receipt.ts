import { z } from "zod";

import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  UtcTimestampSchema,
} from "./common.js";

export const ReceiptStateSchema = z.enum([
  "durable",
  "projection_pending",
  "projected",
  "partial",
  "failed",
  "rolled_back",
  "purged",
]);

export const MutationReceiptSchema = z
  .object({
    schema_version: ContractVersionSchema,
    receipt_id: IdentifierSchema,
    created_at: UtcTimestampSchema,
    state: ReceiptStateSchema,
    request_hash: CanonicalHashSchema,
    receipt_hash: CanonicalHashSchema,
    kind: z.literal("mutation"),
    idempotency_key: z.string().trim().min(8).max(200),
    affected_memory_ids: z.array(IdentifierSchema),
    affected_revision_ids: z.array(IdentifierSchema),
    resulting_epoch: z.number().int().nonnegative(),
    projection_jobs: z.array(IdentifierSchema),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

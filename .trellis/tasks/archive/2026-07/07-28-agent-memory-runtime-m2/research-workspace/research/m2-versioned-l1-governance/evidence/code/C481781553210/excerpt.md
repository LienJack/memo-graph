# packages/contracts/src/receipts.ts:53

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `MutationReceiptSchema_PurgeReceiptSchema`
- Why: MutationReceipt 和 PurgeReceipt 已定义投影工作、tombstone epoch、store inventory 与 residual debt

````typescript
    53  export const MutationReceiptSchema = z
    54    .object({
    55      ...ReceiptBaseShape,
    56      kind: z.literal("mutation"),
    57      idempotency_key: z.string().trim().min(8).max(200),
    58      affected_memory_ids: z.array(IdentifierSchema),
    59      affected_revision_ids: z.array(IdentifierSchema),
    60      resulting_epoch: z.number().int().nonnegative(),
    61      projection_jobs: z.array(IdentifierSchema),
    62      warnings: z.array(z.string().trim().min(1)),
    63    })
    64    .strict();
    65  
    66  export const EvalReceiptSchema = z
    67    .object({
    68      ...ReceiptBaseShape,
    69      kind: z.literal("evaluation"),
    70      candidate_id: IdentifierSchema,
    71      evaluation_version: ContractVersionSchema,
    72      fixture_manifest_hash: CanonicalHashSchema,
    73      baseline_release_id: IdentifierSchema.nullable(),
    74      passed: z.boolean(),
    75      failed_case_ids: z.array(IdentifierSchema),
    76      quarantined_case_ids: z.array(IdentifierSchema),
    77    })
    78    .strict();
    79  
    80  export const ReleaseReceiptSchema = z
    81    .object({
    82      ...ReceiptBaseShape,
    83      kind: z.literal("release"),
    84      release_id: IdentifierSchema,
    85      candidate_id: IdentifierSchema,
    86      previous_release_id: IdentifierSchema.nullable(),
    87      evaluation_receipt_id: IdentifierSchema,
    88      canary_receipt_id: IdentifierSchema,
    89      authorized_by: IdentifierSchema,
    90      retrieval_configuration_hash: CanonicalHashSchema,
    91    })
    92    .strict();
    93  
    94  export const RollbackReceiptSchema = z
    95    .object({
    96      ...ReceiptBaseShape,
    97      kind: z.literal("rollback"),
    98      release_id: IdentifierSchema,
    99      restored_release_id: IdentifierSchema.nullable(),
   100      restored_configuration_hash: CanonicalHashSchema,
   101      reason: NonEmptyReasonSchema,
   102    })
   103    .strict();
   104  
   105  export const PurgeReceiptSchema = z
   106    .object({
   107      ...ReceiptBaseShape,
   108      kind: z.literal("purge"),
   109      purge_job_id: IdentifierSchema,
   110      target_memory_ids: z.array(IdentifierSchema).min(1),
   111      tombstone_epoch: z.number().int().nonnegative(),
   112      stores_checked: z.array(z.string().trim().min(1)).min(1),
   113      residual_hashes: z.array(CanonicalHashSchema),
   114      completed: z.boolean(),
   115    })
   116    .strict()
   117    .superRefine((value, context) => {
   118      if (value.completed && value.residual_hashes.length > 0) {
   119        context.addIssue({
   120          code: "custom",
   121          path: ["residual_hashes"],
   122          message: "a completed purge cannot report residual content hashes",
   123        });
   124      }
   125    });
````

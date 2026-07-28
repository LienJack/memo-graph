# packages/contracts/src/mcp.ts:19

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `MEMORY_TOOL_SAFETY_CLASS`
- Why: 工具安全分级、幂等键、expected revision 与 dry-run 是 M2 mutation envelope 基线

````typescript
    19  export const ToolSafetyClassSchema = z.enum([
    20    "read_only",
    21    "proposal",
    22    "important_mutation",
    23    "destructive",
    24  ]);
    25  
    26  export const MemoryToolNameSchema = z.enum([
    27    "memory_search",
    28    "memory_get",
    29    "memory_explain",
    30    "memory_context_compile",
    31    "memory_receipt_get",
    32    "memory_episode_commit",
    33    "memory_propose",
    34    "memory_feedback",
    35    "memory_correct",
    36    "memory_pin",
    37    "memory_demote",
    38    "memory_usage_set",
    39    "memory_revoke",
    40    "memory_delete",
    41    "learning_pause",
    42    "learning_resume",
    43    "learning_release",
    44    "learning_rollback",
    45  ]);
    46  
    47  export type MemoryToolName = z.infer<typeof MemoryToolNameSchema>;
    48  export type ToolSafetyClass = z.infer<typeof ToolSafetyClassSchema>;
    49  
    50  export const MEMORY_TOOL_SAFETY_CLASS = {
    51    memory_search: "read_only",
    52    memory_get: "read_only",
    53    memory_explain: "read_only",
    54    memory_context_compile: "read_only",
    55    memory_receipt_get: "read_only",
    56    memory_episode_commit: "proposal",
    57    memory_propose: "proposal",
    58    memory_feedback: "proposal",
    59    memory_correct: "important_mutation",
    60    memory_pin: "important_mutation",
    61    memory_demote: "important_mutation",
    62    memory_usage_set: "important_mutation",
    63    memory_revoke: "important_mutation",
    64    learning_pause: "important_mutation",
    65    learning_resume: "important_mutation",
    66    learning_release: "important_mutation",
    67    learning_rollback: "important_mutation",
    68    memory_delete: "destructive",
    69  } as const satisfies Record<MemoryToolName, ToolSafetyClass>;
    70  
    71  const RequestEnvelopeBaseSchema = z
    72    .object({
    73      schema_version: ContractVersionSchema,
    74      request_id: IdentifierSchema,
    75      tool: MemoryToolNameSchema,
    76      actor_claim: ActorClaimSchema,
    77      scopes: z.array(ScopeSchema).min(1),
    78      purpose: z.string().trim().min(1).max(500),
    79      reason: NonEmptyReasonSchema,
    80      requested_at: UtcTimestampSchema,
    81    })
    82    .strict();
    83  
    84  export const ReadRequestEnvelopeSchema = RequestEnvelopeBaseSchema.safeExtend({
    85    safety_class: z.literal("read_only"),
    86  }).superRefine((value, context) => {
    87    const expectedClass = MEMORY_TOOL_SAFETY_CLASS[value.tool];
    88    if (expectedClass !== value.safety_class) {
    89      context.addIssue({
    90        code: "custom",
    91        path: ["safety_class"],
    92        message: `${value.tool} requires safety class ${expectedClass}`,
    93      });
    94    }
    95  });
    96  
    97  export const ProposalRequestEnvelopeSchema = RequestEnvelopeBaseSchema.safeExtend({
    98    safety_class: z.literal("proposal"),
    99    idempotency_key: z.string().trim().min(8).max(200),
   100  }).superRefine((value, context) => {
   101    const expectedClass = MEMORY_TOOL_SAFETY_CLASS[value.tool];
   102    if (expectedClass !== value.safety_class) {
   103      context.addIssue({
   104        code: "custom",
   105        path: ["safety_class"],
   106        message: `${value.tool} requires safety class ${expectedClass}`,
   107      });
   108    }
   109  });
   110  
   111  export const MutationRequestEnvelopeSchema = RequestEnvelopeBaseSchema.safeExtend({
   112    safety_class: z.enum(["important_mutation", "destructive"]),
   113    idempotency_key: z.string().trim().min(8).max(200),
   114    expected_revision_id: IdentifierSchema.nullable(),
   115    dry_run: z.boolean().default(false),
   116  }).superRefine((value, context) => {
   117    const expectedClass = MEMORY_TOOL_SAFETY_CLASS[value.tool];
   118    if (expectedClass !== value.safety_class) {
   119      context.addIssue({
   120        code: "custom",
   121        path: ["safety_class"],
   122        message: `${value.tool} requires safety class ${expectedClass}`,
   123      });
   124    }
   125  });
````

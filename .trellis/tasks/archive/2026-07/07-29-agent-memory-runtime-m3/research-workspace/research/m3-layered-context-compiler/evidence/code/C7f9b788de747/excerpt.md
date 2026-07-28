# packages/context-compiler/src/index.ts:21

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `ContextCandidateSchema and CompileContextInputSchema`
- Why: The current compiler accepts only L0/L1 candidates, validates request scope, and already exposes typed exclusions/degraded lanes; M3 must extend rather than bypass this boundary.

````typescript
    21  const L0ContextCandidateSchema = z
    22    .object({
    23      abstraction: z.literal("l0_evidence").default("l0_evidence"),
    24      evidence: EvidenceRecordSchema,
    25      rank: z.number().finite(),
    26      lane: z.string().trim().min(1).max(120),
    27    })
    28    .strict();
    29
    30  const L1ContextCandidateSchema = z
    31    .object({
    32      abstraction: z.literal("l1_memory"),
    33      memory: GovernedSearchItemSchema.extend({
    34        abstraction: z.literal("l1_memory"),
    35      }),
    36      rank: z.number().finite(),
    37      lane: z.string().trim().min(1).max(120),
    38    })
    39    .strict();
    40
    41  export const ContextCandidateSchema = z.union([
    42    L0ContextCandidateSchema,
    43    L1ContextCandidateSchema,
    44  ]);
    45
    46  export const ContextExclusionSchema = z
    47    .object({
    48      memory_id: z.string().trim().min(1),
    49      revision_id: z.string().trim().min(1),
    50      reason_code: z.string().trim().min(1),
    51      lane: z.string().trim().min(1).max(120),
    52      score: z.number().finite().nullable(),
    53    })
    54    .strict();
    55
    56  export const CompileContextInputSchema = z
    57    .object({
    58      request: RecallRequestSchema,
    59      candidates: z.array(ContextCandidateSchema),
    60      exclusions: z.array(ContextExclusionSchema).default([]),
    61      created_at: z.iso.datetime({ offset: true }),
    62      degraded_lanes: z.array(z.string().trim().min(1).max(120)).default([]),
    63    })
    64    .strict()
    65    .superRefine((value, context) => {
    66      const allowedScopes = new Set(value.request.scopes.map(scopeKey));
    67      value.candidates.forEach((candidate, index) => {
    68        const scope =
    69          candidate.abstraction === "l0_evidence"
    70            ? candidate.evidence.scope
    71            : candidate.memory.scope;
    72        if (!allowedScopes.has(scopeKey(scope))) {
    73          context.addIssue({
    74            code: "custom",
    75            path: [
    76              "candidates",
    77              index,
    78              candidate.abstraction === "l0_evidence" ? "evidence" : "memory",
    79              "scope",
    80            ],
    81            message: "candidate scope is outside the recall request",
    82          });
    83        }
    84      });
    85    });
    86
    87  export const CompileContextResultSchema = z
    88    .object({
    89      status: z.enum(["OK", "NO_MATCH", "POLICY_EXCLUDED", "DEGRADED"]),
    90      context_slice: ContextSliceSchema.nullable(),
    91      receipt: RetrievalReceiptSchema,
    92      excluded_count: z.number().int().nonnegative(),
    93      reason_codes: z.array(z.string().trim().min(1)),
    94      warnings: z.array(z.string().trim().min(1)),
    95    })
    96    .strict();
    97
    98  export type CompileContextInput = z.input<typeof CompileContextInputSchema>;
    99  export type CompileContextResult = z.infer<typeof CompileContextResultSchema>;
   100  export type ContextCandidate = z.infer<typeof ContextCandidateSchema>;
   101  export type ContextExclusion = z.infer<typeof ContextExclusionSchema>;
````

# packages/contracts/src/memory.ts:70

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `MemoryObjectSchema_MemoryRevisionSchema_AdmissionDecisionSchema`
- Why: 当前合同已冻结 L1 生命周期、不可变 successor、lineage 与准入决策边界

````typescript
    70  export const MemoryObjectSchema = z
    71    .object({
    72      schema_version: ContractVersionSchema,
    73      memory_id: IdentifierSchema,
    74      kind: MemoryKindSchema,
    75      scope: ScopeSchema,
    76      lifecycle: LifecycleSchema,
    77      current_revision_id: IdentifierSchema.nullable(),
    78      pinned: z.boolean(),
    79      context_eligible: z.boolean(),
    80      created_at: UtcTimestampSchema,
    81      updated_at: UtcTimestampSchema,
    82    })
    83    .strict()
    84    .superRefine((value, context) => {
    85      if (value.lifecycle === "purged" && value.current_revision_id !== null) {
    86        context.addIssue({
    87          code: "custom",
    88          path: ["current_revision_id"],
    89          message: "purged memory cannot reference a current revision",
    90        });
    91      }
    92      if (
    93        ["revoked", "quarantined", "purged"].includes(value.lifecycle) &&
    94        value.context_eligible
    95      ) {
    96        context.addIssue({
    97          code: "custom",
    98          path: ["context_eligible"],
    99          message: `${value.lifecycle} memory cannot enter context`,
   100        });
   101      }
   102    });
   103  
   104  export const MemoryRevisionSchema = z
   105    .object({
   106      schema_version: ContractVersionSchema,
   107      revision_id: IdentifierSchema,
   108      memory_id: IdentifierSchema,
   109      revision: z.number().int().positive(),
   110      abstraction: AbstractionLevelSchema,
   111      lifecycle: LifecycleSchema,
   112      kind: MemoryKindSchema,
   113      scope: ScopeSchema,
   114      authority: AuthoritySchema,
   115      sensitivity: SensitivitySchema,
   116      validity: ValidityWindowSchema,
   117      inferred: z.boolean(),
   118      content: ContentRefSchema.nullable(),
   119      content_hash: CanonicalHashSchema,
   120      evidence_ids: z.array(IdentifierSchema),
   121      derived_from_revision_ids: z.array(IdentifierSchema),
   122      supersedes_revision_id: IdentifierSchema.nullable(),
   123      transform: TransformRefSchema,
   124    })
   125    .strict()
   126    .superRefine((value, context) => {
   127      if (value.abstraction === "l0_evidence") {
   128        context.addIssue({
   129          code: "custom",
   130          path: ["abstraction"],
   131          message: "MemoryRevision starts at L1; L0 uses EvidenceRecord",
   132        });
   133      }
   134      if (value.lifecycle === "purged" && value.content !== null) {
   135        context.addIssue({
   136          code: "custom",
   137          path: ["content"],
   138          message: "purged revisions cannot retain plaintext or blob references",
   139        });
   140      }
   141      if (value.lifecycle !== "purged" && value.content === null) {
   142        context.addIssue({
   143          code: "custom",
   144          path: ["content"],
   145          message: "non-purged revisions require governed content",
   146        });
   147      }
   148      if (value.revision === 1 && value.supersedes_revision_id !== null) {
   149        context.addIssue({
   150          code: "custom",
   151          path: ["supersedes_revision_id"],
   152          message: "the first revision cannot supersede another revision",
   153        });
   154      }
   155      if (value.revision > 1 && value.supersedes_revision_id === null) {
   156        context.addIssue({
   157          code: "custom",
   158          path: ["supersedes_revision_id"],
   159          message: "later revisions must identify the revision they supersede",
   160        });
   161      }
   162      if (
   163        ["l2_topic", "l2_scenario", "l2_relation", "l3_core"].includes(
   164          value.abstraction,
   165        ) &&
   166        value.derived_from_revision_ids.length === 0
   167      ) {
   168        context.addIssue({
   169          code: "custom",
   170          path: ["derived_from_revision_ids"],
   171          message: "L2/L3 projections require lower-level lineage",
   172        });
   173      }
   174      if (value.authority === "derived" && value.evidence_ids.length === 0) {
   175        context.addIssue({
   176          code: "custom",
   177          path: ["evidence_ids"],
   178          message: "derived claims require live evidence lineage",
   179        });
   180      }
   181    });
   182  
   183  export const AdmissionDecisionSchema = z
   184    .object({
   185      schema_version: ContractVersionSchema,
   186      decision_id: IdentifierSchema,
   187      memory_id: IdentifierSchema,
   188      revision_id: IdentifierSchema,
   189      decision: z.enum([
   190        "activate",
   191        "candidate_only",
   192        "quarantine",
   193        "reject",
   194      ]),
   195      decided_by: ActorClaimSchema,
   196      decided_at: UtcTimestampSchema,
   197      reason: NonEmptyReasonSchema,
   198      conflict_group_id: IdentifierSchema.nullable(),
   199      requires_user_confirmation: z.boolean(),
   200    })
   201    .strict()
   202    .superRefine((value, context) => {
   203      if (
   204        value.requires_user_confirmation &&
   205        value.decision === "activate" &&
   206        value.decided_by.authority !== "user_stated"
   207      ) {
   208        context.addIssue({
   209          code: "custom",
   210          path: ["decided_by", "authority"],
   211          message: "user confirmation is required before activation",
   212        });
   213      }
   214    });
````

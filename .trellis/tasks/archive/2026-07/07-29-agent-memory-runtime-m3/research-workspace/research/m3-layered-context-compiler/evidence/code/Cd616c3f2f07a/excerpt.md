# packages/contracts/src/memory.ts:123

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `MemoryRevisionSchema`
- Why: Contracts already reserve L2/L3 abstraction levels and require lower-revision/evidence lineage, while current active authority rules remain explicit.

````typescript
   123  export const MemoryRevisionSchema = z
   124    .object({
   125      schema_version: ContractVersionSchema,
   126      revision_id: IdentifierSchema,
   127      memory_id: IdentifierSchema,
   128      revision: z.number().int().positive(),
   129      abstraction: AbstractionLevelSchema,
   130      lifecycle: LifecycleSchema,
   131      kind: MemoryKindSchema,
   132      scope: ScopeSchema,
   133      authority: AuthoritySchema,
   134      sensitivity: SensitivitySchema,
   135      validity: ValidityWindowSchema,
   136      inferred: z.boolean(),
   137      content: ContentRefSchema.nullable(),
   138      content_hash: CanonicalHashSchema,
   139      evidence_ids: z.array(IdentifierSchema),
   140      derived_from_revision_ids: z.array(IdentifierSchema),
   141      supersedes_revision_id: IdentifierSchema.nullable(),
   142      transform: TransformRefSchema,
   143    })
   144    .strict()
   145    .superRefine((value, context) => {
   146      if (value.abstraction === "l0_evidence") {
   147        context.addIssue({
   148          code: "custom",
   149          path: ["abstraction"],
   150          message: "MemoryRevision starts at L1; L0 uses EvidenceRecord",
   151        });
   152      }
   153      if (value.lifecycle === "purged" && value.content !== null) {
   154        context.addIssue({
   155          code: "custom",
   156          path: ["content"],
   157          message: "purged revisions cannot retain plaintext or blob references",
   158        });
   159      }
   160      if (value.lifecycle !== "purged" && value.content === null) {
   161        context.addIssue({
   162          code: "custom",
   163          path: ["content"],
   164          message: "non-purged revisions require governed content",
   165        });
   166      }
   167      if (value.revision === 1 && value.supersedes_revision_id !== null) {
   168        context.addIssue({
   169          code: "custom",
   170          path: ["supersedes_revision_id"],
   171          message: "the first revision cannot supersede another revision",
   172        });
   173      }
   174      if (value.revision > 1 && value.supersedes_revision_id === null) {
   175        context.addIssue({
   176          code: "custom",
   177          path: ["supersedes_revision_id"],
   178          message: "later revisions must identify the revision they supersede",
   179        });
   180      }
   181      if (
   182        ["l2_topic", "l2_scenario", "l2_relation", "l3_core"].includes(
   183          value.abstraction,
   184        ) &&
   185        value.derived_from_revision_ids.length === 0
   186      ) {
   187        context.addIssue({
   188          code: "custom",
   189          path: ["derived_from_revision_ids"],
   190          message: "L2/L3 projections require lower-level lineage",
   191        });
   192      }
   193      if (value.authority === "derived" && value.evidence_ids.length === 0) {
   194        context.addIssue({
   195          code: "custom",
   196          path: ["evidence_ids"],
   197          message: "derived claims require live evidence lineage",
   198        });
   199      }
   200      if (
   201        value.abstraction === "l1_memory" &&
   202        value.lifecycle === "active" &&
   203        value.evidence_ids.length === 0
   204      ) {
   205        context.addIssue({
   206          code: "custom",
   207          path: ["evidence_ids"],
   208          message: "active L1 revisions require live evidence lineage",
   209        });
   210      }
   211    });
````

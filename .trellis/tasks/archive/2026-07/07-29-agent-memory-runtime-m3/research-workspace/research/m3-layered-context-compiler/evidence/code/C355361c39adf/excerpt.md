# packages/contracts/src/memory.ts:466

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `RelationRevisionSchema`
- Why: A relation revision contract exists with version, endpoints, lifecycle, scope, authority, validity, evidence, lower-revision lineage, and transform, but has no storage implementation yet.

````typescript
   466  export const RelationRevisionSchema = z
   467    .object({
   468      schema_version: ContractVersionSchema,
   469      relation_revision_id: IdentifierSchema,
   470      relation_id: IdentifierSchema,
   471      revision: z.number().int().positive(),
   472      source_memory_id: IdentifierSchema,
   473      target_memory_id: IdentifierSchema,
   474      relation_type: z.string().trim().min(1).max(120),
   475      lifecycle: LifecycleSchema,
   476      scope: ScopeSchema,
   477      authority: AuthoritySchema,
   478      validity: ValidityWindowSchema,
   479      evidence_ids: z.array(IdentifierSchema).min(1),
   480      derived_from_revision_ids: z.array(IdentifierSchema).min(1),
   481      transform: TransformRefSchema,
   482    })
   483    .strict()
   484    .superRefine((value, context) => {
   485      if (value.source_memory_id === value.target_memory_id) {
   486        context.addIssue({
   487          code: "custom",
   488          path: ["target_memory_id"],
   489          message: "self-relations require an explicit intermediate projection",
   490        });
   491      }
   492    });
   493
   494  export const MemoryArtifactSchema = z.union([
   495    EvidenceRecordSchema,
   496    EpisodeSchema,
   497    MemoryObjectSchema,
   498    MemoryRevisionSchema,
   499    AdmissionDecisionSchema,
   500    MemoryCandidateSchema,
   501    MemoryConflictGroupSchema,
   502    MemoryStatusEventSchema,
   503    MemoryPinEventSchema,
   504    MemoryUsageRuleSchema,
   505    RelationRevisionSchema,
   506  ]);
````

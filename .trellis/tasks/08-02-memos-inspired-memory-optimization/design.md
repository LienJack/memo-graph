# Technical design

## 1. Decision summary

This task adopts one MemOS idea: a reader/adapter boundary that normalizes
heterogeneous explicit inputs before they enter the memory system. It does not
adopt MemOS memory categories, direct graph persistence, Dream mutations,
general hooks, or in-place update semantics.

The work has two serial implementation units inside one task because the final
G6 qualification must bind their combined source tree:

1. repair the G6 proof model and Runbook executor;
2. add a deterministic, L0-only EvidenceAdapter;
3. freeze the combined candidate and emit one fresh versioned G6 evidence
   bundle.

The historical G6 `NO-GO` remains the installed/current release boundary.
Fresh evidence may establish eligibility, but this task does not sign or
install a production-enabling control.

## 2. Authority invariants

The following invariants are unconditional:

1. SQLite owns canonical evidence, episodes, governed identities, revisions,
   lifecycle, scope, tombstone, release pointers, outbox, and receipts.
2. The EvidenceAdapter is a pure normalization boundary. It has no database,
   projection, approval, correction, or publication authority.
3. `fast_l0` may construct only `EvidenceRecord`, `Episode`, and empty blob
   input. Future fine extraction is a separate task and may emit only an
   unadmitted `MemoryCandidate` proposal.
4. Every effect still passes principal authorization, storage validation,
   idempotency, one serialized SQLite transaction, outbox creation, and durable
   receipt sealing.
5. Graph, vector, Context, FTS, reports, and G6 evidence cannot decide truth.
6. A passing evidence verifier is not an installed release control.

## 3. End-to-end data flow

```text
MCP memory_evidence_ingest
  -> MemoryEvidenceIngestInputSchema (strict boundary decode)
  -> principal/scope/authority authorization
  -> EvidenceAdapter.adaptFastL0 (pure deterministic transform)
     -> Episode + ordered EvidenceRecord[] + blobs=[]
  -> shared canonical episode-commit helper
  -> storage worker / BEGIN IMMEDIATE
     -> evidence + episode + idempotency + outbox + receipt
  -> content-free GovernedResponse
```

There is no edge from the adapter to `memory_propose`, admission,
`memory_correct`, Learning Lab publication, or any L2/L3 builder.

## 4. G6 rerun architecture

### 4.1 Immutable legacy boundary

The existing top-level `docs/evaluations/g6-*` reports, release control,
decision, and handoff are historical U7/U8 artifacts. The implementation will
record their hashes before work and assert they are unchanged at the final
gate. Updating G6 scripts in a new candidate does not rewrite the historical
reports; their source identity remains recoverable from their recorded commit.

### 4.2 Versioned evidence layout

New evidence is written below:

```text
docs/evaluations/g6-runs/<candidate-commit>/
  code-review.md
  fault-report.json
  reproducibility-manifest.json
  resource-report.json
  runbook-report.json
  security-report.json
  supply-chain-report.json
  verification-report.json
  handoff.md
```

`<candidate-commit>` is the full clean implementation commit, not a caller
label. A strict layout contract derives the exact path set from that commit and
rejects absolute paths, traversal, aliases, extra artifacts, a mismatched
candidate, or an output root outside `docs/evaluations/g6-runs/`.

Runners accept an explicit run context instead of relying on the legacy global
path constants. Report source bindings name the new layout/fixture version and
the exact runner source. The verifier reads only the selected run directory;
it never glob-mixes the legacy bundle or another candidate's bundle.

### 4.3 Candidate and evidence sequence

The final source candidate must be clean and committed before evidence capture.
Evidence generation is the only allowed dirtiness, scoped to that candidate's
new run directory. Any source, fixture, lock, migration, native helper, test,
or review fix creates a new candidate commit and a new run directory. An
abandoned run is never rewritten into a passing run.

## 5. Direct fault and acceptance evidence

### 5.1 Proof contract

The v2 fault fixture replaces aggregate `fault_groups[].proof` claims with
single-obligation cases:

```ts
type G6DirectProof = {
  proof_id: Identifier;
  obligation: `fault:${string}` | `acceptance:${string}:${"success" | "failure"}`;
  test_file: `tests/${string}`;
  test_name: string;
  oracle: string;
};
```

The fixture still groups fault points for documentation, but executable proof
ownership is one-to-one. Validation requires:

- exact coverage of all 43 fault obligations and all 16 acceptance Oracles;
- one obligation per process invocation;
- unique `proof_id`, obligation, and `(test_file, test_name)` selector;
- a test selector that identifies a named fault/Oracle case rather than an
  aggregate suite;
- pass/fail/blocked derived only from that invocation.

The existing `deriveProofStates` aggregate-blocking behavior remains a safety
invariant and gains regression tests. The runner does not gain a bypass that
marks a multi-obligation command as direct.

### 5.2 Test refactoring

Existing recovery logic is reused. Aggregate tests are decomposed or
parameterized into uniquely named `G6 fault:<fault_point>` and
`G6 acceptance:<AE>:<success|failure>` cases. Shared setup may be extracted,
but each selected case must inject or observe exactly its declared seam and
assert the old-or-new state, receipt/frontier agreement, restart/idempotency,
no-resurrection, and typed-readiness properties relevant to that seam.

This is evidence refactoring, not weakening: a fault claim cannot pass merely
because a broader happy-path test passed.

## 6. Direct typed Runbook execution

### 6.1 Shared output ownership

Every JSON output used by a frozen operator automation receives one strict
runtime schema owned by `@memo-graph/contracts`. Existing schemas such as
`OperationalStatusSchema`, `EncryptionKeyInventorySchema`, and
`OperationalPurgeVerificationSchema` are reused. Local structural return types
for backup inspection, restore dry-run, key-rotation dry-run, projection
rebuild dry-run, learning rollback verification, G6 verification, and
content-free operator execution are promoted to shared schemas instead of
being duplicated in the runner.

The operator CLI parses command results through the same schemas before
rendering. The G6 runner imports the built contracts and parses captured JSON
through the command's declared schema. This makes `typed_result_verified` an
observed fact rather than a constant.

### 6.2 Automation harness

A content-free Runbook fixture builder creates a private temporary root and the
minimum real artifacts needed by each step: initialized SQLite data, private
operator config, backup/restore aliases, confirmation grant, purge audit roots,
and a synthetic pending G6 report for the `g6 verify` command. The synthetic
report is fixture-bound and is not confused with final qualification evidence.

For each frozen step the runner:

1. resolves placeholders to concrete private values;
2. parses the concrete argv with the actual CLI grammar;
3. spawns the built operator CLI entry point as a child process;
4. compares the process exit code with the schema-derived expected operator
   exit class (`0`, operator-action-required, or other declared class);
5. parses stdout as JSON and then through the owning strict schema;
6. checks command-specific invariants and forbidden-marker absence;
7. records only command identity, exit class, hashes, booleans, counts, and
   source bindings.

Raw stdout/stderr, configuration bodies, temporary paths, grants, key material,
and user content are never serialized into the report. A timeout is `blocked`;
an unexpected exit, malformed JSON, schema mismatch, or invariant mismatch is
`fail`.

## 7. EvidenceAdapter contracts

### 7.1 Public request

`memory_evidence_ingest` is added to `MemoryToolNameSchema` with safety class
`proposal`. Its strict input contains:

- the existing `ProposalRequestEnvelope`;
- one exact authorized `scope`;
- an `outcome`;
- 1 through a bounded maximum number of ordered source items;
- each item's `occurred_at`, non-secret sensitivity, and discriminated body.

Supported item variants are:

```ts
conversation_turn { speaker: "user" | "assistant"; text: string }
tool_result       { tool_name: Identifier; text: string }
text_file         { source_name: string; media_type: "text/plain" | "text/markdown"; text: string }
```

`text_file` is a provenance label plus caller-supplied body. The server never
opens a path from the request. Per-item and aggregate UTF-8 byte limits are
enforced before transformation.

### 7.2 Deterministic mapping

The adapter preserves input order. For each item it builds inline
`ContentRef`, hashes that canonical value, maps provenance/authority, and
derives an evidence identifier from a domain-separated canonical hash of the
request idempotency identity, item index, variant metadata, timestamp, scope,
and content hash. The episode identifier is similarly domain-separated. Full
hashes are retained in the identifier so collision handling does not rely on a
truncated digest.

The episode:

- starts at the earliest item timestamp and ends at the latest;
- lists evidence IDs in sequence order;
- has no artifact hashes in this inline-only slice;
- carries the caller's explicit outcome;
- seals all fields with the existing canonical hash helper.

The adapter output is parsed again through an `EvidenceAdaptationSchema` before
it reaches storage. This catches implementation drift at the package boundary.

### 7.3 Provenance and authority map

| Input | Evidence source | Authority | Publication consequence |
| --- | --- | --- | --- |
| user conversation turn | `conversation_turn` | `user_stated` | L0 only |
| assistant conversation turn | `conversation_turn` | `observed` | L0 only |
| tool result | `tool_result` | `tool_result` | L0 only |
| text file body | `import` | `imported` | L0 only |

The evidence actor uses the configured principal ID plus the mapped authority.
If that authority is not in the principal's allowlist, authorization fails
before persistence. The adapter cannot inherit a stronger envelope authority
for a weaker source.

### 7.4 Commit integration

`MemoryRuntime` extracts the current episode-commit body into one private shared
helper. Both `memoryEpisodeCommit` and `memoryEvidenceIngest` use that helper
after their own strict request decode and authorization. The helper receives
canonical artifacts, calls `storage.commitEpisode`, drains the existing FTS
outbox as today, and returns the same durable mutation receipt.

The adapter response adds only content-free adaptation metadata such as mode,
episode ID, evidence IDs, item count, and receipt. Existing direct commit output
and behavior remain unchanged.

## 8. Error, replay, and failure behavior

| Condition | Result |
| --- | --- |
| Unknown variant/field, empty text, invalid time, or size overflow | `INVALID_INPUT`, zero write |
| Scope outside envelope/principal | `PERMISSION_DENIED`, zero write |
| Mapped authority outside principal policy | `PERMISSION_DENIED`, zero write |
| Secret sensitivity/plaintext | `ENCRYPTION_REQUIRED` or strict input rejection, zero write |
| Same idempotency key and canonical artifacts | original durable receipt |
| Same key with changed body/metadata/order | `CONFLICT`, zero new effect |
| FTS drain unavailable after canonical commit | preserve canonical receipt and existing typed degradation/recovery semantics |
| Adapter implementation produces invalid canonical artifacts | `INTERNAL_FAILURE`, no storage call |

Errors and diagnostics name only stable codes, request/receipt IDs, counts, and
bounded metadata. They never include source text or a private path.

## 9. Package and file boundaries

Expected source ownership:

- `packages/contracts`: tool name/safety mapping, ingest item/request schema,
  adaptation result schema, and shared operator output schemas;
- `packages/evidence-adapter`: pure deterministic `fast_l0` transformation;
- `packages/memory-kernel`: authorization and shared canonical commit helper;
- `packages/mcp-server`: registration and description only;
- `apps/operator-cli`: schema-backed rendering and executable Runbook path;
- `fixtures/g6` and `scripts`: v2 direct proof/run context/runner/verifier;
- `tests`: contract, fault-specific recovery, CLI subprocess, MCP integration,
  governance, restart, and security regressions;
- `docs`: explicit ingestion loop plus the new versioned evidence bundle.

No migration is expected for EvidenceAdapter because it reuses the existing
episode/evidence ledger. A migration is allowed only if implementation proves a
persisted contract cannot be represented by existing canonical tables; that
would require returning to planning.

## 10. Compatibility and rollout

- Direct `memory_episode_commit` callers are unaffected.
- Existing data roots require no backfill.
- The new tool is additive and disabled in practice when its mapped authorities
  are not configured.
- Graph/vector and automatic learning publication remain disabled.
- The adapter can be reverted by removing the additive tool/package without
  rewriting canonical evidence already committed through the standard path.
- G6 evidence generation is append-only by candidate directory. Reverting the
  harness does not alter historical bundles.

## 11. Alternatives rejected

- **Use MemOS types as L0-L3 layers:** rejected because storage category and
  epistemic abstraction are different dimensions.
- **Adapter directly calls `memory_propose`:** rejected because capture and
  admission must remain separate and reviewable.
- **LLM extraction in the first slice:** rejected because it adds model,
  nondeterminism, privacy, and evaluation boundaries before basic ingestion is
  qualified.
- **Mark aggregate tests as direct:** rejected because it destroys the G6
  evidence invariant.
- **Rewrite top-level U7 reports:** rejected because the recorded decision makes
  them immutable.
- **Sign G6 GO in this task:** rejected because enabling secret admission is a
  separate release-authority decision, not implied by ingestion optimization.

## 12. Main risks

- Fault-specific proof refactoring may reveal real untested crash seams rather
  than mere report-model gaps. Those remain blocking until a real test passes.
- Direct destructive Runbook fixtures are complex; they must use temporary,
  explicit targets and never a user data root.
- Adding a tool changes exhaustive safety maps, MCP discovery snapshots, and
  final runtime identity. All consumers and evidence bindings must be updated
  together.
- A final source fix after evidence capture invalidates that run. The plan
  treats regeneration under a new candidate directory as expected recovery,
  not as in-place repair.

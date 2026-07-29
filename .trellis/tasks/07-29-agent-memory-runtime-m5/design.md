# Agent Memory Runtime M5 — Technical Design

## 1. Objective

M5 adds a local governed Learning Lab over the accepted vector-free Memory
Runtime. It turns sealed task evidence into immutable inactive candidates,
evaluates them against absence and the current release, and permits
publication only through exact authority, a bounded synthetic canary, an
atomic release pointer, monitoring, and exact rollback.

The design has two complete terminal outcomes:

- **G5 GO:** one tested candidate passes all offline, authority, canary,
  publication, rollback, recovery, and full-regression hard gates.
- **G5 NO-GO:** trace collection and candidate-only evaluation remain
  available, the accepted runtime/base pointer remains active, and the first
  failed hard rule is preserved as reproducible evidence.

Neither outcome is a production-readiness claim.

## 2. Authority and traceability

1. Product Contract R16-R20, F4, AE6, and AE7 are the only product
   requirements implemented by M5.
2. `docs/brainstorms/2026-07-29-m5-learning-lab-requirements.md` owns the
   scoped product interpretation.
3. `prd.md` owns Trellis acceptance.
4. `research/research-handoff.md` and `research/claim-map.md` own the external
   Claim/Evidence transfer.
5. This document owns component, persistence, state, evaluation, authority,
   release, pause, and rollback boundaries.
6. `implement.md` owns U-ID order, test-first checklists, focused verification,
   hard stops, rollback points, and per-unit commits.
7. `docs/plans/2026-07-29-005-feat-governed-learning-lab-plan.md` is the
   unified ce-plan implementation view.
8. G5 machine reports and the evidence verifier own the tested outcome.

## 3. Accepted baseline and immutable inputs

| Input | Accepted value |
| --- | --- |
| Context Compiler | G3R GO at `6224f782c86712488d416d8101ef7c9fa477c0ae` |
| Structural retrieval | G4A NO-GO at `36421f5cd75007a1421d3e0594e7881dd4b864b2`; SQLite relations retained |
| Semantic retrieval | G4B NO-GO at `3eec7119b1e441d76523d0a57c328d4d811a4af3`; vector lane disabled |
| Retrieval topology | FTS5, recency, layered projections, SQLite relations |
| Canonical authority | SQLite through the dedicated storage worker |
| Runtime | Node 24 LTS, pnpm exact lock, TypeScript strict ESM |
| Learning arms | `no_candidate`, `current`, `candidate` |
| Partitions | calibration, sealed holdout, distinct-family transfer |
| Publication | inactive by default; exact release authority and pointer CAS |
| Canary | three independently sealed local cases, hidden until approval; not production traffic |

Every evaluation, canary, release, rollback, monitor, and G5 decision binds
these inputs. A graph/vector/config/source/lock/schema/corpus/scorer/threshold
change creates another evaluation identity.

## 4. Component boundaries

### 4.1 Contracts

`@memo-graph/contracts` owns:

- LearningTrace, ordered step references, redaction descriptors, and seals;
- candidate type, capability, risk, base, release slot, target/payload,
  expected improvement, protected invariants, and rollback identity;
- candidate transition and legal state vocabulary;
- common evaluation identity, partitions, arms, results, contamination, and
  evaluation receipts;
- canary manifest/run/result/receipt;
- release version, active pointer, monitor, rollback, and control frontier;
- learning MCP inputs, approval binding extension, receipts, replay, and G5
  evidence envelopes.

Contracts contain no SQLite, MCP SDK, model, graph, vector, or package-specific
implementation type.

### 4.2 SQLite storage

`@memo-graph/storage-sqlite` owns:

- trace, evidence-reference, candidate, and candidate-evidence rows;
- partition/run/result/receipt rows;
- append-only transition sequences;
- canary runs/results/receipts;
- immutable release versions and one guarded active pointer per release slot;
- per-principal learning control status/epoch/frontier;
- idempotency, exact approval consumption, monitor, rollback, and access
  receipts;
- transaction composition with canonical memory and projection effects;
- target invalidation on canonical revoke/tombstone/purge;
- health and restore frontiers.

The storage worker is the only SQLite owner. Learning Lab never imports
`better-sqlite3`.

### 4.3 Learning Lab

`@memo-graph/learning-lab` owns:

- trace completeness/privacy qualification;
- smallest-candidate selection;
- partition loading and oracle visibility;
- three-arm orchestration and metric separation;
- state-transition requests;
- authority/canary qualification;
- release/rollback orchestration through the storage port;
- G5 logical evaluation helpers.

It does not decide canonical memory eligibility, parse transport requests, or
move active pointers outside storage.

### 4.4 Memory kernel

`@memo-graph/memory-kernel` owns:

- actor/scope authorization before learning/runtime operations;
- exact active retrieval-policy release resolution;
- narrow-only intersection with the operator policy;
- one resolved policy/release identity for a recall request's entire exact
  canonically sorted scope set;
- current/new request behavior and frozen old-request replay;
- canonical memory/procedure release adapter behavior reused by storage;
- typed fallback/degradation when a learned release cannot resolve safely.

The pure Context Compiler still receives only canonically materialized
candidates and an effective configuration.

### 4.5 MCP

`@memo-graph/mcp-server` owns:

- strict `memory_feedback`, `learning_pause`, `learning_resume`,
  `learning_release`, and `learning_rollback` registration;
- request claims, safety metadata, approval-manifest acquisition, and
  time-of-effect confirmation;
- content-free learning inspection resources;
- mapping known domain/storage failures to stable governed responses.

MCP never writes SQLite directly and never treats a resource as automatic
model Context.

## 5. Learning trace

### 5.1 Required identity

A valid trace binds:

- trace/episode/task-spec identities;
- principal and non-empty exact scope set;
- frozen ContextSlice ID/hash/frontier;
- ordered trajectory step ID, ordinal, kind, content/evidence reference or
  redaction descriptor, and step hash;
- outcome plus explicit feedback, typed error, and gap observations;
- active release-set hash and accepted retrieval configuration hash;
- runtime, compiler, model/provider, tool, and dependency identities used by
  the task;
- token, latency, and side-effect measurements;
- capture time, policy/control epoch, and trace seal.

### 5.2 Privacy-minimal retention

Learning tables store structure, governed IDs, hashes, classifications, and
redaction reasons. Raw feedback, tool bodies, Context content, memory text, and
artifact bytes stay in their existing governed evidence/blob stores.

If a step cannot be retained:

- its ordinal remains;
- the content reference is null;
- the original content hash remains when permitted;
- a stable redaction/omission reason is present;
- the trace seal covers the redaction decision.

The trace cannot be used to bypass ordinary evidence access control.

### 5.3 Stop before candidate

The recorder persists a typed stop receipt and creates no candidate when:

- required provenance, Context, configuration, failure, or outcome identity is
  absent;
- learning is paused at the checked control epoch;
- evidence is foreign-scope, purged, or inaccessible;
- sensitive raw retention is unnecessary or unauthorized;
- feedback authority is ambiguous;
- the gap is anecdotal-only under the frozen candidate policy.

## 6. Candidate model

### 6.1 Immutability

A candidate version is immutable and binds:

- candidate ID/type/capability/hash;
- exact principal and release slot;
- ordered trace/evidence IDs;
- base release set and active base release;
- typed target/payload and payload hash;
- expected improvement and protected invariant IDs;
- confidence, impact, sensitivity, authority class, and confirmation
  requirement;
- evaluation contract/corpus/threshold hashes;
- exact rollback target;
- proposed time/reason and proposer identity.

Status is not updated on the candidate row. State is derived from an
append-only transition sequence.

### 6.2 Release capabilities

| Candidate type | M5 capability | Publication target |
| --- | --- | --- |
| memory | release-capable | Existing canonical memory candidate/revision |
| procedure | release-capable | Existing canonical procedural memory candidate/revision |
| retrieval_policy | release-capable | Strict lane/limit overlay |
| prompt | evaluation-only | None |
| core_projection | evaluation-only | None |
| scenario_pattern | evaluation-only | None |
| Skill/code/model update | unsupported | Rejected at boundary |

Memory/procedure records contain only canonical target identity and hashes.
They never copy content into the learning ledger.

### 6.3 Smallest-change ordering

The deterministic qualification order is:

1. canonical memory correction/addition;
2. canonical procedural memory;
3. exact-scope-set retrieval-policy narrowing;
4. evaluation-only broader candidate;
5. typed unsupported stop.

A candidate cannot widen its scope, target type, or policy after seeing
holdout/transfer results.

## 7. Release slot and active pointer

### 7.1 Slot identity

A release slot is the canonical hash of:

- principal ID;
- candidate type;
- canonically sorted exact scope set;
- target key.

For retrieval policy, target key identifies the policy channel. For
memory/procedure it identifies the canonical logical memory target.

### 7.2 Version/pointer separation

`learning_release_versions` is immutable. A release version records:

- release ID and slot;
- candidate and prior release IDs;
- evaluation, authority, canary, monitor, and configuration identities;
- action `release` or `rollback`;
- activation time;
- release seal.

`learning_release_pointers` contains only the current release ID plus a
monotonic pointer revision. It is guarded by expected revision and target.

### 7.3 Base state

No pointer means the accepted operator/runtime base. There is no implicit
“latest candidate.” A missing, stale, invalid, or unresolvable active target
fails closed to the last named safe/base state with a typed receipt.

The learned retrieval-policy payload cannot encode or replace ACL,
sensitivity, mandatory-exclusion, lifecycle, conflict, tombstone, or other
safety rules. Those remain hard runtime filters, so falling back to the
operator/runtime base cannot widen authorization.

## 8. Three-arm evaluation

### 8.1 Frozen common identity

Before execution, the runner freezes:

- candidate/base/current release identities;
- source commit/tree, lock, migrations, schema, Node/pnpm/SQLite/platform;
- G3R/G4A/G4B decisions and retrieval topology;
- corpus, case IDs/bodies, partition seals, scorer, thresholds, seed;
- task inputs, ContextSlices, readers/tools, budgets, and environment.

Only arm application differs.

### 8.2 Arm behavior

- `no_candidate`: operator configuration, no learned release.
- `current`: operator configuration plus the exact frozen active release.
- `candidate`: operator configuration plus the exact inactive candidate.

All arms start from isolated equivalent storage/runtime state. Proposal,
evaluation, and canary cannot alter the normal active pointer.

### 8.3 Partition isolation

- Calibration inputs and expected outcomes may be used for bounded
  candidate-specific iteration before the candidate is re-frozen.
- Holdout inputs are runnable only by the sealed scorer after the candidate
  and evaluation identity are frozen.
- Transfer cases come from a distinct scenario/scope family and use the same
  sealed scorer boundary.
- Visibility, access, mutation, and contamination events are durable. Leakage
  invalidates the run.

### 8.4 Metrics

Per case/arm/partition:

- passed required task units;
- typed error/failure codes;
- negative-transfer units;
- included/excluded IDs and reason codes;
- Context token budget/used/pollution;
- latency and resource observations;
- side effects;
- scope/privacy/authority/lifecycle/conflict/tombstone/rollback violations;
- result and common-identity hashes.

Aggregate metrics never replace per-case hard rules.

## 9. Frozen G5 thresholds

G5 GO requires:

1. every case has exactly three complete arms with identical common identity;
2. candidate gains at least one required task unit over `current` in every
   partition;
3. candidate gains at least one required task unit over `no_candidate` in
   every partition;
4. candidate loses no required task unit passed by `current`;
5. critical regression count is zero;
6. scope/privacy/authority/lifecycle/conflict/tombstone/rollback violations are
   zero;
7. Context pollution increase and token overflow are zero;
8. evaluation/canary side effects on normal runtime are zero;
9. Context compile p95 is at most 400 ms and within the larger of 20% or 25 ms
   above `current`;
10. the bounded canary runs exactly one exposure for each of three independent
    cases, remains invisible before approval, completes inside ten minutes,
    and passes every hard rule;
11. rollback restores the exact prior pointer and new-request behavior/config
    hash.

Missing evidence is false. A failed rule is not averaged away.

## 10. Candidate state machine

Legal forward path:

```text
proposed
  -> quarantined
  -> evaluating
  -> approved_for_canary
  -> canary
  -> released
  -> rolled_back
```

`rejected` is terminal from pre-release states when evidence, evaluation,
capability, authority, or canary is insufficient. `rolled_back` is terminal
after a canary/release effect needs reversal.

The `approved_for_canary -> canary` transition consumes only the canary
authorization. The `canary -> released` transition is legal only after the
terminal canary receipt exists and a distinct post-canary release approval
binds that receipt and the expected pointer.

Each transition binds:

- expected prior sequence/state/hash;
- candidate/release slot/control epoch;
- actor, applicable canary authorization or post-canary approval, and reason
  code;
- evidence/evaluation/canary/release receipt;
- idempotency key and transition seal.

One exhaustive reducer owns legal transitions. Consumers do not reimplement
state checks.

## 11. Canary authorization and release authority

### 11.1 Canary authorization

Canary authorization is issued before the canary and cannot move an active
release pointer. Its trusted grant binds:

- approval ID, principal, canary tool, safety class, and canonically sorted
  exact scope set;
- candidate, release slot, base release, and evaluation receipt IDs/hashes;
- sealed canary manifest ID/hash, case hashes, exposure limit, deadline, and
  control epoch;
- canonical request hash plus issued and expiry times.

The grant deliberately does not bind a canary receipt because that receipt
does not exist yet. It is consumed atomically when the bounded canary starts,
and the terminal canary receipt records the consumed authorization.

### 11.2 Post-canary release and rollback approval

After a successful canary, a separate trusted approval binds:

- approval ID, principal, release or rollback tool, safety class, and
  canonically sorted exact scope set;
- candidate, release slot, base release, and expected pointer revision;
- evaluation and terminal canary receipt IDs/hashes;
- exact prior/target release for rollback;
- canonical request hash, effect manifest hash, and control epoch;
- issued and expiry times.

High-impact, low-confidence, sensitive, long-term preference, and every
effect-bearing release/rollback operation require this operator-controlled,
single-use approval. The proposer, evaluator, and canary runner cannot
synthesize it.

Processing order for an effect:

1. compute/replay idempotency result;
2. authorize actor/scope claims;
3. verify the exact post-canary approval and effect manifest snapshot;
4. re-read expected state/pointer/control/target;
5. confirm the manifest is unchanged at the effect boundary;
6. commit effect, approval consumption, transition, idempotency, and receipt
   together.

## 12. Canary

The M5 canary is a frozen local post-approval evaluation, not traffic
splitting. Its three cases and oracles are sealed before candidate
implementation but inaccessible until `approved_for_canary`. Its manifest
binds:

- candidate/current stable;
- case IDs and case hashes;
- maximum exposures;
- start/deadline;
- promote metrics;
- abort metrics;
- environment/config/runtime identity;
- control epoch.

Success requires exactly one exposure per case, completion inside ten minutes,
and every hard invariant to pass. Early case/oracle access, timeout, pause,
identity drift, critical regression, missing stable comparator, or exposure
overflow aborts/freezes the canary. Canary never moves the normal active
pointer.

## 13. Release adapters

### 13.1 Retrieval policy

The candidate payload may:

- remove allowed lanes;
- request a subset of lanes;
- lower configured work limits.

It may not:

- add lanes;
- raise limits;
- enable `relation_graph` or `semantic_vector`;
- encode or change ACL, sensitivity, mandatory-exclusion, hard-filter,
  authority, lifecycle, conflict, tombstone, or token rules;
- apply to a non-exact scope set.

The kernel resolves one release before per-scope recall, intersects it with the
operator policy, and seals the release/config hash into telemetry/receipts.

### 13.2 Memory/procedure

The release candidate references an existing canonical candidate/revision and
evidence. A storage-private adapter creates an active append-only governed
successor, status/admission events, FTS/projection effects, release version,
pointer, approval consumption, and receipt in one transaction.

It does not update an immutable revision or duplicate content. Rollback creates
an append-only behavior-equivalent successor when needed and restores the
exact prior learning release pointer.

## 14. Pause/resume frontier

Per principal:

- status: active or paused;
- monotonic control epoch;
- reason code and actor;
- changed time;
- frontier hash over candidate/evaluation/canary/release identities;
- runtime/config/corpus identity.

Pause:

- blocks new candidate qualification and evaluation/canary/publication starts;
- permits an already running evaluation to persist a terminal receipt;
- prevents that result from authorizing or publishing;
- freezes/aborts a canary according to its manifest;
- leaves ordinary governed read/write paths untouched.

Resume requires expected epoch/frontier and unchanged identity. Drift requires
reevaluation or explicit abandonment.

Pause, resume, release, and rollback carry the observed control epoch and
serialize through SQLite. If pause commits first, a concurrent release sees a
stale epoch and fails without effect. If release commits first, pause records
that released frontier and emits `RELEASE_COMPLETED_BEFORE_PAUSE`; the
operator may then invoke the ordinary authorized rollback path.

## 15. Monitoring, rollback, and no-resurrection

Each release freezes monitor metrics and abort thresholds. Monitoring replays
each independent canary input exactly once through the active pointer. This is
evidence that the active pointer was consumed and remained inside the sealed
drift bounds; it is not a new utility evaluation and cannot mutate candidate
or release state.

A monitor mismatch or threshold breach appends a receipt, blocks G5 `GO`, and
requests rollback through the same governed path. It cannot move the pointer
directly. G5 remains blocked until an exact authorized rollback receipt proves
the safe pointer was restored.

Rollback validates:

- exact current release/pointer revision;
- exact named prior release;
- fresh candidate/target canonical eligibility;
- current control epoch;
- exact rollback authority;
- configuration and dependency identity.

One transaction writes:

- immutable rollback release version;
- restored active pointer;
- candidate transition;
- any governed successor/projection effects;
- approval consumption;
- idempotency and rollback receipt.

If the prior target is revoked, tombstoned, purged, cross-scope, or invalid,
rollback fails closed and preserves the safer current/base state. It never
resurrects content to satisfy pointer history.

Old ContextSlices remain immutable. New request IDs use the restored pointer;
an old request ID replays its original Context as historical evidence.

## 16. Failure and recovery matrix

| Failure | Required behavior |
| --- | --- |
| Incomplete trace | Stop receipt; no candidate |
| Learning paused | Stop/freeze receipt; core runtime continues |
| Unsupported/broad candidate | Reject or evaluation-only; no release path |
| Partition leakage | Invalidate run and approval reuse |
| Missing arm/common drift | Invalidate run |
| No gain/negative transfer | Reject candidate |
| Critical regression | Reject/rollback regardless of aggregate gain |
| Missing/stale authority | No effect; typed approval failure |
| Early/wrong canary authorization | No canary start; no pointer effect |
| Circular or precomputed canary receipt binding | Reject authorization as invalid |
| Concurrent transition/pointer | One winner; typed conflict |
| Pause wins release race | Release fails on stale control epoch |
| Release wins pause race | Pause records release frontier and rollback remains explicit |
| Crash in release transaction | Entire old or entire new state |
| Canary timeout/pause/breach | Abort/freeze; no normal pointer movement |
| Monitor mismatch/breach | Receipt plus G5 block until authorized rollback |
| Active learned policy invalid | Typed degradation to safe/base behavior |
| Purged rollback target | Refuse rollback; no resurrection |
| Artifact/hash mismatch | Evidence verifier fails; G5 cannot GO |

## 17. Security and privacy

- Parse `unknown` at each public boundary through owning strict schemas.
- Exact principal/scope-set identity is part of every trace, candidate, run,
  grant, release, pointer, receipt, and lookup.
- Never log raw task, feedback, tool, memory, evidence, Context, or candidate
  body content.
- Learning inspection exposes IDs, hashes, versions, state, counts, durations,
  and stable reason codes only.
- Candidate policy cannot grant new lane or eligibility.
- Holdout/transfer expected results are inaccessible to proposal/calibration
  code.
- Approval registry paths/content never appear in errors.
- Purge invalidates referenced targets and scans learning storage for content
  residuals.

## 18. Backward compatibility

- Optional learning metadata is absent on old G3R/G4A/G4B artifacts and does
  not change their hashes.
- Existing memory tools, safety classes, approval grants, idempotency behavior,
  and frozen request replay remain unchanged.
- With no active learning release, runtime output/configuration equals the
  accepted vector-free baseline.
- Graph/vector remain disabled/default-off under both G5 outcomes.
- Migration 0014 is additive except for deliberate CHECK/trigger rebuilds
  needed to add learning receipt/purge kinds; upgrade tests prove old rows and
  hashes survive.

## 19. G5 evidence envelope

The reproducibility manifest binds:

- tested source commit/tree and evidence commit;
- lockfile and migration hashes;
- Node/pnpm/SQLite/platform identity;
- G3R, G4A, and G4B accepted decision artifacts/hashes;
- accepted vector-free retrieval configuration;
- contracts, compiler, learning, scorer, and release schema versions;
- corpus, partitions, cases, thresholds, seeds;
- trace/candidate/evaluation/canary/release/monitor/rollback receipt chains;
- focused/full test, lint, typecheck, build, review, and security results;
- active/base release and rollback target;
- limitations and synthetic-evidence boundary.

The verifier recomputes all referenced hashes and conjunctive hard rules.
Narrative cannot override machine failure.

## 20. Rollout and fallback

1. U1-U7 land behind candidate-only behavior and no active learned release.
2. U8 runs only from a clean committed implementation tree.
3. G5 GO may activate only the exact tested release; learning remains
   pausable and rollbackable.
4. G5 NO-GO keeps the accepted base pointer and candidate-only mechanics.
5. M6 receives release/control frontiers for backup/restore and operational
   hardening.

The universal fallback is the accepted SQLite/FTS5/recency/layered/
SQLite-relations runtime with learning publication disabled.

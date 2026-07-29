# G4B Full-Diff Code Review

## Review identity

- Review base: `9287dea`
- Accepted vector-free G3R baseline:
  `6224f782c86712488d416d8101ef7c9fa477c0ae`
- Frozen candidate:
  `3eec7119b1e441d76523d0a57c328d4d811a4af3`
- Scope: M4B U1–U7 implementation plus U8 review fixes
- Result: **PASS for decision use**
- Unresolved P0: `0`
- Unresolved P1: `0`
- Adoption implication: none; review closure makes the evidence usable for a
  decision but cannot turn a failed utility or resource gate into GO.

SQLite remains the sole memory authority. The local vector index is an
optional, default-off, exact-scope derived projection. The reviewed candidate
is safe to retain as a rejected experiment and vector-free fallback, not safe
to enable as the default runtime.

## Review method

The complete diff from the M4A closure through the frozen candidate was
reviewed sequentially in the main thread against the G4B Product Contract,
Trellis PRD/design/checklist, frozen semantic-gap fixture, accepted G3R
baseline, and U2/U6/U7 evidence.

The review covered contracts, migration, SQLite repository and worker
protocol, optional dependency boundary, local model verification, path
security, child protocol and lifecycle, vector index, projector/rebuilder,
governed recall, Context Compiler/receipts, MCP composition, tests, replay and
resource runners, verifier, ADR, scorecard, and runbook.

The following lenses were applied:

1. correctness and adversarial failure construction;
2. architecture and one-way authority;
3. security, privacy, and native-process containment;
4. data integrity and migration safety;
5. reliability, idempotency, and recovery;
6. performance and bounded work;
7. contract/API compatibility;
8. testing and acceptance-criteria coverage;
9. project/Trellis standards and maintainability;
10. agent-native parity for operator controls and diagnostics.

## Resolved P1 findings

| Finding | Failure scenario | Resolution and Oracle |
| --- | --- | --- |
| Epoch dependency identity drift | U2 qualified one lock while MCP composition later changed the workspace lock, so reports and the active epoch could name different implementations | Rebuilt the immutable epoch from the final lock and made the verifier require report, manifest, current lock, and epoch equality |
| Missing active generation appeared empty | A published SQLite checkpoint whose active directory had disappeared could return a clean vector `NO_MATCH` and recreate an empty read path | Require a real contained active directory and return typed `VECTOR_INDEX_MISSING`; regression proves no active path is recreated |
| Parent deadline covered only the child query | Model-process startup could consume about one second even when the lane budget was 50 ms | Apply one absolute deadline across checkpoint-to-open, startup, and query; pass only the remaining budget to the child |
| Cleanup could extend a timed-out request | A slow child close could make a correctly timed-out query block beyond the parent budget | Start bounded cleanup in the background; regression holds close open while recall returns with typed timeout |
| Epoch A→B→A stranded a scope | Reusing a historical terminal job ID left the scope `pending` without a claimable rebuild job | Seal occurrence identity into job IDs; an A→B→A recovery Oracle requires three complete publications |
| Lost apply acknowledgement deleted committed data | SQLite could commit `published` and lose the worker response; the projector then deleted the new active generation as if apply had failed | Reconcile the canonical checkpoint before cleanup and preserve an identity/digest-matched committed generation |

Every finding has a deterministic regression or verifier assertion and was
committed before the final candidate freeze.

## Correctness

- Model, dependency, epoch, generation, scope, query, response, frontier,
  content hash, rank, and receipt identities are runtime decoded and sealed.
- Only a `published` exact-scope checkpoint with matching desired/active
  epoch and generation may be queried.
- Every vector hit is revalidated against current SQLite scope, principal,
  lifecycle, validity, sensitivity, content hash, and Context eligibility.
- Ineligible hits use opaque exclusion identities where canonical identity
  disclosure would be inappropriate.
- Empty complete results alone become clean `NO_MATCH`; missing, stale,
  malformed, timed-out, or partially rejected work is degraded.
- Parent deadline, late runtime open, late query result, missing index, epoch
  cycle, stale lease, concurrent canonical change, and apply-ACK ambiguity
  have executable failure Oracles.
- Vector-disabled behavior preserves the accepted vector-free result.

No unresolved correctness P0/P1 remains.

## Architecture

- Dependency direction is contracts/storage to memory-kernel ports, with
  optional vector composition at MCP; the kernel does not import the vector
  package.
- SQLite owns canonical memory, governance, embedding-epoch registration,
  delivery checkpoints, outbox jobs, and append-only receipts.
- `sqlite-vec` files contain only derived exact-scope records and can be
  deleted and rebuilt from SQLite.
- Model inference and the native index execute behind a versioned child
  protocol; neither becomes a second memory authority.
- Graph and vector adoption remain independent gates.

No package cycle or authority inversion was found.

## Security and privacy

- Runtime model download is disabled. The operator-supplied local snapshot
  must contain exactly four qualified files with fixed sizes and SHA-256
  identities.
- Public contracts expose neither arbitrary SQL nor caller-selected index
  paths.
- Data, model, scope, generation, home, and temporary paths are canonicalized,
  hashed where exposed, contained, and checked against final symlinks.
- IPC uses a closed operation union, bounded request/response bytes, runtime
  identity, request identity, process generation, deadlines, admission
  limits, and typed failures.
- Sensitive and secret memories never enter the vector projection; semantic
  recall always postvalidates with `include_sensitive=false`.
- Diagnostics, telemetry, receipts, and query hashes do not contain raw
  memory or model content.
- Purge, revoke, correction, demotion, Context blocking, temporal expiry, and
  restore tests prove prohibited content cannot be selected from stale vector
  state.

The child is an availability/crash boundary for trusted native dependencies,
not an OS sandbox or same-UID malicious-code boundary. That limitation is
explicit and is not presented as solved.

## Data integrity

- Migration `0013` is additive and strict. Configuration/scope/outbox/receipt
  writes require a transaction guard; epochs and receipts are append-only.
- Ledger and tombstone frontiers are monotonic. Publication requires exact
  lease, job, epoch, generation, frontier, receipt, and logical-digest
  agreement.
- A canonical change retires unfinished prior work before moving the scope to
  a fresh desired generation.
- Quarantine is read back and compared before atomic rename; canonical source
  and checkpoint state are re-read before SQLite publication.
- Failed, interrupted, stale, corrupt, missing, restored, purged, and
  epoch-migrated projections remain inactive until a clean rebuild publishes.
- A committed SQLite publication is reconciled after ambiguous acknowledgement
  loss, preventing a `published` checkpoint from pointing at deleted data.
- Epoch cycling creates fresh work even when the desired physical generation
  matches a historical one.

No unresolved migration or persistent-state P0/P1 remains.

## Reliability and performance

- Startup, query, IPC, response, shutdown, restart, cooldown, missing model,
  missing index, index corruption, process exit, timeout, and fallback paths
  are typed and tested.
- Work is bounded by exact scope, source count, embedding batch, input length,
  top-k, response bytes, IPC bytes, concurrent requests, restart window, and
  one parent wall-clock deadline.
- Full resource evidence materializes 25,000 records across 100 independent
  native indexes and measures full rebuild plus epoch migration.
- The qualified child is opened per semantic request. Cold model startup
  cannot satisfy the frozen 50–75 ms parent budget, so governed recall and
  Context outcome gates fail even though direct warm query latency is viable.
- Background close protects the caller deadline while the process host retains
  bounded termination behavior.

Performance review supports `NO-GO`; it does not support enabling or
amortizing a persistent child without a new design and evaluation.

## Contracts and compatibility

- Vector contracts and receipt evidence are additive and versioned.
- `semantic_vector` requires both explicit lane policy/request selection and
  an enabled MCP vector configuration.
- Default MCP configuration and SQLite projection configuration remain
  disabled; opening the ordinary runtime does not load the model or start a
  vector child.
- Native inference and index dependencies are optional and dynamically loaded
  only inside the child.
- A frozen `--no-optional` installation builds and opens a vector-disabled
  SQLite/MCP runtime.
- Accepted G3R evidence remains bound to its own commit and lock.

No breaking default behavior or mandatory native dependency was found.

## Testing and standards

- Focused governance/recovery review suite: 3 files, 15 passed.
- Earlier U6 governance/recovery gate and U7 frozen replay/resource gate are
  retained as immutable stage evidence.
- Final full-suite, artifact-verifier, build, lint, typecheck, audit,
  no-optional startup, Trellis validation, and diff-check results are bound in
  `g4b-verification-report.json`.
- Implementation follows project TypeScript/SQLite-worker patterns, uses
  Trellis task artifacts, and commits each completed logical unit.

All M4B acceptance criteria have executable evidence or an explicit supported
`NO-GO` outcome.

## Accepted lower-severity boundaries

- The only qualified platform is Darwin arm64 with Node `v24.18.0`; other
  platforms are unqualified.
- Model verification hashes 135 MB on each child startup and the current
  per-request process lifecycle is intentionally expensive.
- Background close can briefly overlap a completed caller with bounded child
  teardown.
- The process boundary does not defend against malicious trusted packages,
  same-UID filesystem races, or host-level compromise.
- The frozen candidate fails utility and resource adoption rules.

These boundaries do not leave a P0/P1 implementation defect. They require the
candidate to remain default-off and are decisive inputs to the U9 `NO-GO`.

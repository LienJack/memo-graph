# G4A Full-Diff Code Review

## Review identity

- Review base: `957ac34`
- Frozen candidate:
  `36421f5cd75007a1421d3e0594e7881dd4b864b2`
- Scope: M4A U1–U7 implementation plus U8 review fixes
- Result: **PASS for decision use**
- Unresolved P0: `0`
- Unresolved P1: `0`
- Adoption implication: none; the review establishes safety and evidence
  integrity, not graph value or production readiness.

The reviewed change preserves SQLite as the sole authority. LadybugDB is an
optional, default-off, rebuildable projection. A successful code review does
not override the independently failing structural and resource gates.

## Review method

The full diff was reviewed against the M4A Product Contract, design,
implementation checklist, Trellis specs, and the accepted G3R baseline.
Review covered contracts, migration, storage worker/repository, process host,
native adapter, projector/rebuilder, graph recall, compiler/receipts, MCP
composition, tests, benchmark runners, evidence verifier, and operational
runbook.

The following lenses were applied:

1. correctness and adversarial failure construction;
2. architecture and one-way authority;
3. security and native-process containment;
4. data integrity and migration safety;
5. reliability and recovery;
6. performance and bounded work;
7. contract/API compatibility;
8. testing and acceptance-criteria coverage;
9. project/Trellis standards and maintainability;
10. agent-native parity for user controls and diagnostics.

## Resolved P1 findings

| Finding | Failure scenario | Resolution |
| --- | --- | --- |
| Parent deadline omitted replacement readiness | A request could exceed its 75 ms parent budget while awaiting a replacement child | Bound readiness and request work to one end-to-end deadline |
| Parent admission was unbounded | Concurrent callers could accumulate unbounded pending work before IPC | Add a validated concurrent-request ceiling and typed rejection |
| Rebuild publication race | An older same-frontier scope job could publish `ready` during a full rebuild | Guard publication by rebuild status, digest/frontier and lease generation |
| Native query timeout leaked into later writes | A short query timeout could cause subsequent schema/write operations to fail spuriously | Reset the native timeout before every write/read lifecycle operation |
| Production timeout configuration exceeded the contract | MCP configuration could permit graph work beyond 75 ms | Cap production graph request and lane policy timeouts at 75 ms |
| SQL digest constraints admitted malformed hashes | Direct SQL could store non-canonical digest text | Enforce exact lowercase `sha256:` constraints in migration tables |
| Old process exit could replace a healthy generation | A delayed prior-generation exit event could trigger a second restart and orphan the new child | Make startup waiters and restart scheduling generation-scoped |
| Restore retained stale queue debt | Restored `pending/failed` jobs could retry against invalidated checkpoints up to 32 times | Atomically mark all unfinished pre-restore graph jobs `stale` |
| Historical G3R verifier compared the wrong lock | M4A's optional dependency changed the current lock and falsely invalidated the frozen G3R candidate | Read the lock from the accepted G3R commit; leave current-lock validation to G4A |

Every finding received a deterministic regression or verifier check and a
separate commit before the final candidate freeze.

## Correctness

- Graph query, response, path, frontier, digest, epoch and identity inputs are
  runtime decoded.
- Parent timeout, late response, duplicate response, malformed response,
  process exit and prior-generation exit cannot satisfy another request.
- Exact-scope checkpoints must be `ready`, identity-matched and frontier-
  matched before graph work can contribute.
- Every graph path is postvalidated against the current canonical SQLite
  snapshot, node/edge identities, validity, lifecycle, lineage and evidence.
- Incomplete work is reported as degraded and cannot become a clean
  `NO_MATCH`.
- Graph-disabled behavior retains accepted SQLite/G3R semantics.

No unresolved correctness P0/P1 remains.

## Architecture

- Dependency direction is
  `contracts/storage -> memory kernel ports -> optional graph composition at
  MCP`; the memory kernel does not depend on the graph package.
- SQLite owns canonical memory, projections, governance state, graph delivery
  checkpoints and outbox receipts.
- Graph files and active-generation manifests are derived artifacts and can be
  deleted and deterministically rebuilt.
- Graph and vector adoption remain independent gates.

No package cycle or second authority was found.

## Security and privacy

- IPC uses a closed versioned operation union, bounded message bytes and
  request/generation matching.
- Raw Cypher, caller-selected graph paths and caller-provided database paths
  are absent from public contracts.
- Graph paths are confined beneath the canonical data root; final symlinks and
  path escapes are rejected.
- The child receives a minimal environment and emits content-free diagnostics.
- Package version, storage version, platform, architecture, lock and native
  binary hashes are matched before use.
- Restart admission, request admission, wall-clock deadlines and OS process
  termination bound native failure.
- Purge/content-residual tests confirm derived artifacts and diagnostics do not
  retain prohibited memory content.

The process is explicitly an availability/crash boundary, not an OS sandbox.
Same-UID malicious-native defense remains outside M4A and is not claimed.

## Data integrity

- Migration `0012` is additive, strict and guarded by transactional triggers.
- Scope state is monotonic; receipts are append-only; leases require exact
  worker/token/expiry identity.
- Scope replacement is transactional and read-back digest verified.
- Checkpoint publication validates current scope status, frontier, digest,
  backend identity and snapshot counts.
- Corrections, demotion, context blocking, revoke, delete and purge mark graph
  state pending before replacement.
- Rebuild uses a fresh generation, verifies every scope before and after
  reopen, rechecks SQLite, atomically publishes the manifest and only then
  publishes checkpoints.
- Restore clears graph readiness and retires all unfinished pre-restore jobs.

Crash-window, stale lease, same-frontier race, delete/rebuild and stale backup
tests are present and green.

## Reliability and performance

- Startup, shutdown, query kill, write kill, orphan prevention, bounded
  restart, circuit opening, lock/corruption fallback and SQLite continuity are
  executable tests.
- Parent query deadline is 75 ms; measured fallback p95 is 76.77 ms and
  replacement maximum is 184.72 ms.
- Work is bounded by starts, depth, fanout, allowlist, paths/results, response
  bytes, concurrent requests and IPC bytes.
- Queue debt is zero in the resource report.
- The benchmark is honest about its limit: the Expected logical profile is
  materialized, but the Expected native rebuild was not run after the
  structural gate failed.
- Idle child RSS is 159,186,944 bytes, above the frozen 134,217,728-byte
  threshold.

Performance review therefore supports the G4A `NO-GO`; it does not support
adoption.

## Contracts and compatibility

- Graph fields are additive and versioned.
- `relation_graph` requires explicit operator policy and request opt-in.
- The default remains `recent_l1`; opening an MCP runtime does not start a
  graph child.
- `@ladybugdb/core@0.18.3` is optional and dynamically imported only by the
  child.
- A frozen `--no-optional` install builds and starts SQLite-only MCP with graph
  disabled.
- Existing accepted G3R evidence verifies against its own frozen commit and
  lock.

No breaking default behavior or mandatory native dependency was found.

## Testing and standards

- Full repository: 60 files, 318 passed, 1 environment-gated skip.
- Graph focused: 11 files, 37 passed.
- Accepted G3R focused: 8 files, 70 passed, 1 environment-gated skip.
- Migration/storage focused: 3 files, 18 passed.
- Build, lint, typecheck, frozen installs, production dependency audit,
  Trellis context validation, JSON/JSONL parsing, Markdown fences and
  `git diff --check` pass.
- Implementation uses TypeScript, the dedicated SQLite worker, typed
  diagnostics, Trellis task artifacts and one commit per completed logical
  unit.

All M4A acceptance criteria and hard-stop scenarios have executable evidence
or an explicit honest `NO-GO` gate result.

## Accepted lower-severity boundaries

- A store-factory startup failure is cached for the runtime lifetime to avoid
  process-start storms; recovery requires reopening the runtime. This is
  deliberate default-off availability behavior, not data loss.
- Process isolation does not defend against malicious trusted native code or
  same-UID filesystem races.
- The cycle/fanout transfer case remains a structural regression.
- Expected native rebuild evidence is missing and idle RSS exceeds threshold.

These boundaries do not leave a P0/P1 implementation defect. The latter two
are decisive adoption-gate failures and are carried into the U9 decision.

# G5 Governed Learning Full-Diff Code Review

## Review identity

- Review base: `de1fdda`
- Original U7 implementation: `946d2a8`
- Required review-fix candidate: `02bb7a1824e710b0736ee6e35c02b7d7e8925abc`
- Candidate tree: `6ba5d29b3f51fb63d604a39c984e3ffc2f69b74b`
- Scope: M5 U7 MCP/runtime integration plus U7R fixes
- Result: **PASS for G5 evidence use**
- Unresolved P0: `0`
- Unresolved P1: `0`
- Production-readiness implication: none

The review result permits G5 evidence capture for the exact candidate. It does
not authorize a learning release, make graph or vector retrieval eligible, or
claim M6 operational readiness.

## Review method

The committed U7 diff was reviewed against the Product Contract, M5
PRD/design/implementation checklist, SQLite authority model, protected
three-arm evaluation, canary and release contracts, MCP transport behavior,
and ordinary-runtime continuity requirement. The following lenses were
applied:

1. correctness and adversarial failure construction;
2. security, privacy, and authorization;
3. API and MCP transport compatibility;
4. storage integrity and principal-local concurrency;
5. reliability, replay, crash, and race behavior;
6. performance and bounded work;
7. testing and acceptance-criteria coverage;
8. project and Trellis standards;
9. maintainability and TypeScript boundaries;
10. agent-native action preparation.

The first pass found ten P1 scenarios. U7R froze failing regressions before
changing behavior, implemented the fixes, and reran focused plus full
repository gates.

## Resolved P1 findings

| Finding | Failure scenario | Resolution and Oracle |
| --- | --- | --- |
| Feedback receipt omitted the observation | The durable stop receipt retained only a request hash and reason, so task, Context, outcome, evidence, error, and gap metadata could not be replayed | Added a strict, hash-bound, privacy-minimal feedback observation and restart readback test; raw content remains absent |
| Feedback lookup work was unbounded | Evidence count multiplied by scope count could grow without a request ceiling | Bound each list and the evidence/scope product to 100; a foreign exact-scope evidence case proves zero learning write |
| Partial scope could pause a principal | A subset request changed principal-wide learning control state | Require the complete configured canonical scope set in request and approval |
| Caller supplied runtime identities | Pause/resume accepted runtime, configuration, and corpus hashes without deriving them from live state | Derive and expose content-free action-frontier identities from runtime, migration, policy, and storage state |
| Global epoch blocked another principal | Comparing one principal to the global maximum control epoch prevented independent epoch-one transitions | Use principal-local control epoch with aggregate-frontier CAS; two principals independently pause at epoch one |
| Resume ignored learning-state drift | Candidate, evaluation, canary, release, pointer, monitor, or invalidation changes while paused could be resumed as if nothing changed | Persist a principal-scoped learning-state frontier; exact resume rejects drift unless the approved request abandons in-flight work |
| Release/pause ordering was ambiguous | A release could win before pause or collide during pause persistence without a stable outcome | Bind the observed release revision, allow one release-first serialization, retry one storage conflict, and emit `RELEASE_COMPLETED_BEFORE_PAUSE` only for that path |
| Paused state blocked safety rollback | The same paused guard rejected both new release and exact rollback | Block publication while paused and allow only an authorized rollback at the current control epoch |
| MCP failures were transport-successful | A governed `FAILED` response lacked MCP `isError`, so clients could treat it as a normal tool result | Map only governed `FAILED` to `isError: true`; in-memory MCP coverage exercises all five learning tools and the learning resource |
| MCP control preparation was incomplete | An MCP-only client could inspect state but not construct exact authoritative pause/resume inputs | Expose expected control/release revisions, aggregate frontier, authoritative identities, learning-state hash, and required scopes |

## Correctness and integrity

- Feedback observations, controls, canaries, evaluations, releases, monitors,
  rollbacks, and receipts are runtime decoded and hash-bound.
- Safe evaluation executes `no_candidate`, `current`, and `candidate` under
  one common identity for each frozen case.
- D5 rules are conjunctive; a negative-transfer candidate is rejected with no
  pointer movement.
- Release consumes a distinct post-canary authority after the terminal canary
  receipt exists. Canary authorization cannot substitute for release approval.
- Release, monitor, pause, rollback, resume, and idempotent replay preserve one
  serialized pointer/control history.
- Replaying a prior release result after rollback cannot resurrect the active
  pointer.

No unresolved correctness or persistent-state P0/P1 remains.

## Security and privacy

- Request actor and scope fields remain claims checked against the configured
  principal.
- Important mutations bind exact principal, tool, safety class, complete
  scope set, request hash, control epoch, pointer revision, and authority.
- Feedback and diagnostic artifacts contain identifiers, codes, counts, and
  hashes, not raw memory, Context, evidence, purpose, or reason text.
- Canary fixtures remain unavailable before `approved_for_canary`.
- Graph and vector decisions remain independent `NO-GO` inputs; neither lane
  is enabled by learning.

No unresolved authorization, cross-scope, or content-disclosure P0/P1 remains.

## Reliability, performance, and testing

- Replay precedes mutable authority reads for committed effects.
- Pause/resume uses authoritative snapshots and storage CAS; release-first and
  pause-first outcomes are deterministic.
- Ordinary governed memory search remains available while learning is paused.
- Focused U7R verification passed 41 contract/integration/recovery tests after
  the final frontier change.
- The final repository regression passed 96 files with 473 tests passed and 6
  designed skips, excluding only the separately documented archived G4B
  active-path verifier defect.
- ESLint, TypeScript no-emit, runtime build, Trellis context validation,
  dependency audit, and diff checks passed.

## Accepted lower-severity debt

- Extract learning-control orchestration from the growing `MemoryRuntime`
  module without changing the governed boundary.
- Validate feedback `context_slice_id` provenance instead of accepting only
  its privacy-minimal identifier.
- Replace bounded evidence-by-scope lookups with a batched repository query if
  G5 resource evidence shows material cost.
- Narrow the conservative global corpus identity to principal/exact-scope
  state if false-positive drift becomes operationally significant.
- Extend action preparation from pause/resume to complete release/rollback
  readiness and remove remaining handwritten internal execution payload
  duplication.

These items are not P0/P1 safety defects and do not invalidate G5 evidence.
They remain explicit inputs to M6 planning and any later API refinement.

# G2 Versioned L1 Governance Gate Decision

- Decision: **GO**
- Date: 2026-07-28
- Tested implementation commit:
  `31959fc841ddc95f7570e5e0f2028a1e6b00243e`
- Evidence-only commit: this document and related documentation
- Parent roadmap: `07-28-agent-memory-runtime`
- Milestone task: `07-28-agent-memory-runtime-m2`
- G1 lineage: **GO**

## Decision boundary

**GO to M3 L2/L3 projections and the governed Context Compiler.**

This decision approves only the M2 versioned L1 governance boundary. It does
not approve graph, vector, learning release, remote transport, or production
operations. No executable code or frozen fixture changed after the tested
implementation commit; this evidence-only commit records the observed result.

## Frozen runtime, schema, and corpus

| Field | Value |
| --- | --- |
| Node.js used for gate and benchmark commands | 24.18.0 |
| pnpm | 10.33.2 |
| Platform | Darwin arm64, macOS 15.5 |
| Official MCP server/client | 2.0.0 / 2.0.0 |
| `better-sqlite3` | 13.0.1 |
| SQLite | 3.53.3 |
| TypeScript / Vitest / Zod | 6.0.3 / 4.1.10 / 4.4.3 |
| Schema frontier | `0007` |
| Dependency lock SHA-256 | `e4d3347083d9b0147fc7ce581671196f3cc4883a5ef7663d179a3d44074dd695` |
| Replay manifest SHA-256 | `8827b6fd6f1db6df8643faa46cdd5ce1008c10cca092fada555e3896cd7804e3` |
| G2 loop fixture SHA-256 | `cd8d0801c80118693f0f419113299f3a69231fef578e5e4543d1a2c09c0a3724` |
| G2 replay fixture SHA-256 | `07c7506bed9e4c0e7dd4cfb0148b0311b79606865f8c26b9bd1ba419c697be9f` |

Immutable migration hashes:

| Migration | SHA-256 |
| --- | --- |
| `0001` | `707146d45e5f6d5e4c31740a85cd7eb81c43ec379bd39b2600cde533515e8e11` |
| `0002` | `b70b77de89023929151ba1440d1a8971b7179bde9a5c40f529db6c99a74166f8` |
| `0003` | `ed6d7538ee160a75bfdde47e58a131d98a172038a5c8615823766aa7babdd69b` |
| `0004` | `979ef6ec5fec074a2a3c6b12b84dc44f389575b5b2ff73b5b65bc7032e17b7c6` |
| `0005` | `5b99ba87d3c6a398ab2ca3884f3f0f1a0f055252a80a00f36985209cd81fe51b` |
| `0006` | `6f977f7c686d78a8b630f529d7644a6289038717e3738ddfa77e4997eb580668` |
| `0007` | `1314180cb2b28925efc37765236c180912c4b34fff3a6dd23e5f14e6605c4392` |

## Frozen gate commands

All commands below passed on the tested implementation commit with Node
24.18.0:

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass: lock unchanged |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm test` | Pass: 28 files, 138 tests |
| `pnpm audit --audit-level=high` | Pass: no known vulnerabilities |

The independently executed test axes are disjoint and sum to the same full
suite:

| Axis | Result |
| --- | --- |
| Contract | 7 files, 44 tests |
| Frozen fixtures | 1 file, 3 tests |
| Storage/data integrity | 5 files, 31 tests |
| Recovery | 3 files, 3 tests |
| MCP/API | 3 files, 21 tests |
| End-to-end integration | 2 files, 2 tests |
| Governance | 4 files, 23 tests |
| Security/privacy | 2 files, 10 tests |
| Replay | 1 file, 1 test |

## G2 assertion evidence

| Assertion | Frozen evidence |
| --- | --- |
| Active L1 has live exact-scope lineage and an admission decision | `admission.integration.test.ts` |
| Inferred/derived remains candidate-only; injection-like input quarantines; invalid lineage writes nothing | `admission.integration.test.ts`, `mutation-authorization.test.ts` |
| Duplicate identity is reused; divergent content opens conflict without pointer replacement | `revision-cas.integration.test.ts` |
| Concurrent successors yield one revision and one `STALE_REVISION` | `revision-cas.integration.test.ts` |
| Correction suppresses the predecessor before FTS drain and after rebuild | `correction.integration.test.ts`, `l1-governance-loop.integration.test.ts` |
| Pin, demote, scoped/global usage, revoke, and delete remain distinct and pin cannot bypass expiry | `governance-mutations.integration.test.ts`, `l1-governance-loop.integration.test.ts` |
| Missing/forged/expired/reused/wrong-scope/wrong-tool/wrong-hash approvals mutate nothing | `mutation-authorization.test.ts`, `governance-mutations.integration.test.ts` |
| Delete is disabled by default and needs local enablement plus exact approval | `governance-mutations.integration.test.ts`, `mutation-authorization.test.ts` |
| Tombstone suppresses synchronously; purge reports exact verified stores and residual hashes | `purge.integration.test.ts`, `deleted-content-residual.test.ts` |
| Restart, retry, stale backup, and frozen Context replay cannot resurrect prohibited plaintext | `purge-retry.recovery.test.ts`, `stale-tombstone-restore.recovery.test.ts`, `governance-replay.test.ts`, `l1-governance-loop.integration.test.ts` |

The end-to-end loop activates one evidence-bound L1 memory, observes the
canonical fallback while FTS is behind, corrects it, drains FTS, freezes
Context, pins it, proves pin does not override expiry, blocks Context use,
tombstones it, restarts, retries cleanup, and verifies no old or prohibited
content re-enters recall.

Frozen same-hash proposal and correction requests replay their original
receipt across process restart without rechecking consumed approval state.
Changed content under the same idempotency key returns `CONFLICT`.

## Purge and restore evidence

Exclusive deletion produced nine verified store outcomes and zero residual
hashes. The security fixture scanned the isolated data root and found no
deleted plaintext after purge/compaction; FTS rebuild and restart did not
restore it.

Shared lineage first produced an honest partial receipt naming the shared
evidence content hash. After the dependent memory was tombstoned, retrying the
same purge job completed with no residual.

Restore cases proved:

- a pre-delete backup with tombstone frontier 0 is rejected against trusted
  minimum 1, before a target is published;
- a current snapshot with an unverified pending purge is rejected with
  `INCOMPLETE_PURGE`;
- a current snapshot with honest backup residual debt restores while
  preserving one incomplete purge job;
- corrupt backup evidence fails verification and publishes no target.

Historical Context replay is also fail-closed. Correction and later usage
block invalidate an exact stale replay with `CONFLICT`. Tombstoned,
unredacted content returns `INCOMPLETE_PURGE`; after verified purge the same
artifact replays only as hash-valid `[PURGED]` content.

## Performance evidence

Both Small-profile benchmarks passed their frozen thresholds.

`pnpm benchmark:storage` populated 10,000 evidence/episode pairs and measured
200 samples with one reader/writer:

| Operation | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Episode commit | 0.367 ms | 0.646 ms | 20.032 ms |
| Search | 0.316 ms | 0.373 ms | 1.464 ms |

Projection processing took 5,458.667 ms, backup took 254.058 ms, and the
11,251.713 ms run ended with a 35,811,328-byte database and 35,819,520-byte
backup. Resident memory was 332,562,432 bytes.

`pnpm benchmark:baseline` populated 10,000 initial events and measured 200
samples per operation:

| Operation | p50 | p95 | Frozen p95 target |
| --- | ---: | ---: | ---: |
| Governed search | 0.703 ms | 1.016 ms | 200 ms |
| Context compilation | 0.893 ms | 1.201 ms | 400 ms |
| Episode commit | 1.776 ms | 4.695 ms | 150 ms |

The run ended at ledger epoch 10,200 with 10,200 evidence rows, 400 recall
requests, and 200 Context slices. These measurements exclude stdio startup,
L1 mutation/purge latency, multiple readers, and Expected/Stress profiles.

## Shared gate axes

| Axis | Result | Boundary |
| --- | --- | --- |
| Correctness | Pass | Admission, immutable identity/revision, CAS, controls, and replay |
| Retrieval/task quality | Pass for governance | Canonical L1 suppresses stale hits and preserves bounded L0 fallback; M3 owns layered quality gain |
| Governance | Pass | Exact scope, approval binding, user controls, tombstone-first delete |
| Recovery | Pass | Restart-safe receipts/purge, verified restore frontier, no target on failure |
| Cost/latency | Pass for Small profile | Frozen storage/runtime baselines; no L1 purge or multi-reader SLO claim |
| Privacy | Pass | Cross-scope, injection activation, unsafe approval, diagnostic, and deleted-content fixtures |

## Known debt

- M2 accepts an explicit evidence-bound `MemoryCandidate` through
  `memory_propose`; it does not autonomously extract candidates from episodes.
- There is no supported long-running purge scheduler. Delete creates the
  tombstone and durable purge job; M2 tests invoke `storage.runPurge`.
- Old backup files remain named residual debt. The required external trusted
  minimum prevents public stale restore, while M6 still owns durable frontier
  distribution, backup rotation, and purge audit.
- Approval is a private local manifest, not an interactive UI or remote
  identity service.
- Executable evidence is Darwin arm64 only, with one worker for reads and
  writes. Expected/Stress profiles and four-reader behavior remain unmeasured.
- Performance evidence excludes L1 mutation/purge latency and stdio startup.
- Secret storage and untrusted/synchronized volumes still fail closed pending
  M6 application encryption and key lifecycle.
- M2 contains no L2/L3, graph, vector, learning evaluation, canary, or release
  implementation.

## Decision

**GO to M3 only.**

No G2 hard No-Go condition was observed: no unauthorized or tombstoned content
entered current Context, no stale projection overrode SQLite authority, no
lost update occurred, and no purge or restore was represented as verified
without its evidence. The named debt remains outside the M2 acceptance
boundary or is explicitly fail-closed.

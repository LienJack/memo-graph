# G1A Canonical Storage Gate Decision

- Decision: **GO**
- Date: 2026-07-28
- Tested implementation commit:
  `335fcf28e5f29fedcff640502851618ea9007c84`
- Parent roadmap: `07-28-agent-memory-runtime`
- Milestone task: `07-28-agent-memory-runtime-m1a`
- Parent G1 status: **OPEN**

## Gate evidence

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm test:contract` | Pass: 6 files, 33 tests |
| `pnpm test:fixtures` | Pass: 1 file, 3 tests |
| `pnpm test:storage` | Pass: 3 files, 23 tests |
| `pnpm test:recovery -- writer-restart` | Pass: 1 file, 1 test |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm audit --audit-level high` | Pass: no known vulnerabilities |
| `pnpm benchmark:storage` | Pass on the recorded Small profile |

The M0 contract and fixture suites passed on the new M1A dependency lock. The
public M0 contract source and frozen replay manifest are unchanged; this
recertifies their behavior on lock SHA-256
`7f1101efc690eb9d026477f9f0567ac7ad414f9d024d4e40a8dc5fd1d20b7321`.

## Storage assertions closed

- The private local data root rejects unsafe, symlinked, known network,
  removable, and cloud-synchronized paths.
- `secret` evidence returns `ENCRYPTION_REQUIRED` until M6 implements
  application encryption and key lifecycle.
- WAL, foreign keys, `synchronous=FULL`, busy timeout, trusted-schema posture,
  checkpoint limits, and immutable migration hashes are active.
- One dedicated worker owns every synchronous SQLite operation; the caller
  event loop remains responsive while it is blocked.
- One serialized mutation queue commits evidence, episode membership, epoch,
  outbox, receipt, and idempotency state atomically.
- Same-key/same-request retry returns the stored receipt; key/hash conflict
  fails before mutation.
- A forced worker exit after canonical commit and before response recovers the
  original receipt with one durable effect.
- Canonical L0 tables reject UPDATE and DELETE.
- FTS search is exact-scope and distinguishes ready no-match from pending,
  rebuilding, and unavailable states.
- FTS rebuild changes neither canonical rows nor the ledger epoch.
- Content-addressed blobs are hash-checked, atomically installed, and fsynced.
- Backups contain SQLite plus all referenced blobs; restore publishes only
  after integrity, migration, epoch, receipt, and blob frontier verification.
- Diagnostics mechanically exclude inline content and search queries.

## Known debt

- Executable support and recovery evidence cover Darwin arm64 only. Linux and
  Windows remain unverified.
- The benchmark covers 10,000 events and one reader. Expected/Stress profiles
  and up to four concurrent readers remain open.
- The current FTS projector processes one outbox job per short transaction;
  10,000 jobs took 5.452 seconds. Batch optimization must be evaluated before
  an Expected-profile throughput claim.
- The client currently uses one storage worker for both reads and writes.
  Multiple read connections or reader workers require evidence before they are
  introduced.
- Application encryption and key rotation do not exist; secret and known
  untrusted-volume admission fails closed.
- Tombstone/release-frontier replay is not yet defined because M2 governance
  and M5 releases do not exist.
- No MCP transport, request-principal binding, Context compiler, or Codex host
  integration exists in M1A.

## Decision

**GO to M1B.** The L0 SQLite authority, durability, idempotency, derived FTS,
blob, and recovery boundaries are sufficient for the MCP adapter to consume.

This is not parent G1. G1 remains open until M1B proves the actual stdio MCP
task-start recall/task-end commit loop, actor/scope binding, resource
inspection, context-budget enforcement, host integration, and end-to-end
receipt replay on the same lock and schema.

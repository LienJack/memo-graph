# M4A LadybugDB local qualification probe

## Outcome

LadybugDB `@ladybugdb/core@0.18.3` passes the M4A qualification gate on the
tested Darwin arm64 / Node.js 24 environment. It is the only candidate that
proceeds to the single-candidate spike.

This is **not** a G4A adoption decision. Two conditions remain open:

1. the frozen paired replay must demonstrate material structural benefit over
   the existing SQLite adjacency baseline; and
2. graph query wall-clock containment must work under adversarial or accidental
   unbounded workloads.

The second condition is a hard gate. The native timeout API was too coarse in
the local probe, so an adapter cannot rely on it as the process safety boundary.

## Reproduction environment

| Item | Value |
| --- | --- |
| Date | 2026-07-29 |
| OS / architecture | Darwin / arm64 |
| Node.js | `v24.18.0` |
| Package | `@ladybugdb/core@0.18.3` |
| Storage version | `42` |
| npm install result | 48 packages, 0 vulnerabilities |
| `node_modules` | 57,528 KB, 2,158 files |
| `@ladybugdb/core` package | approximately 19,408 KB |
| Native binary | 19,778,472 bytes |
| Native binary SHA-256 | `57e07aa4aaaae7556c414ce9bfddb24f3a6e1e6b1b4a07882e3feb5e8261c6aa` |
| `package-lock.json` SHA-256 | `f94936668a7d52efd5f868cb80150beac06e62747197c777173cf894f7184388` |
| `package.json` SHA-256 | `e6b52de858aae533537c6355247670221cd3ad1cfe9ddbc28255852b881e96fa` |
| Probe script SHA-256 | `bc26b5d90a54bbcbb3de22a3dc0b54a9d343ab1f4234b82679bde4879d3415d3` |

The probe was executed in an isolated temporary npm project:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
npm init -y
npm install --save-exact @ladybugdb/core@0.18.3
node probe.cjs
```

The checked-in [`ladybug-probe.cjs`](./ladybug-probe.cjs) is the exact script
used for the successful capability run.

## Capability results

| Check | Result | Observed duration |
| --- | --- | ---: |
| Create `Revision` and `Link` schema | pass | 50.386 ms |
| Seed four revisions and three links | pass | 48.557 ms |
| Bounded path `1..3` with scope/lifecycle/valid-time filters | pass | 12.361 ms |
| Cross-scope `r4` exclusion | pass | included in bounded-path check |
| Delete relation `e2` and remove downstream reachability | pass | 8.143 ms |
| Explicit transaction rollback | pass, inserted row count `0` | 2.674 ms |
| Export database | pass | 6.003 ms |
| Close, reopen, and read logical snapshot | pass | 10.001 ms |
| Import into a fresh database | pass | 93.302 ms |
| Query rebuilt database | pass | 2.158 ms |
| Source/rebuilt logical snapshot equality | pass | exact JSON equality |

The bounded path result contained `r2` at depth 1 and `r3` at depth 2. The
cross-scope `r4` node was not returned. After deleting `e2`, only `r2` remained
reachable.

## Rebuild digest rule

The source database was 245,760 bytes with SHA-256
`affde9ef5dfe18497e9749e0b4cf4f907f8b211f1019001dd0cb4d3b5bf17f30`.
The imported database was 253,952 bytes with SHA-256
`4d8bd1a3545e4daac56151bc681c566f8717ed285a1fb01f1d609d87f3d2aa47`.

Physical file hashes differ even though the ordered logical node and edge
snapshots are identical. G4A rebuild verification therefore must bind and
compare a canonical logical digest, not require byte-identical database files.

## Timeout containment finding

`Connection.setQueryTimeout` exists, but it did not provide a reliable
wall-clock boundary in the tested Node wrapper:

| Probe | Configured timeout | Observed behavior |
| --- | ---: | --- |
| synchronous `UNWIND range(1, 100000000)` | 1 ms | still running after 30 seconds; manually terminated |
| asynchronous `UNWIND range(1, 1000000)` | 1 ms | interrupted after approximately 813 ms |
| warmed asynchronous `UNWIND range(1, 10000000)` | 10 ms | interrupted after 9,142.909 ms |

The API can interrupt asynchronous work, but enforcement was orders of
magnitude coarser than the requested timeout. The synchronous path can block
the event loop and must not be used by the production adapter.

The spike therefore requires:

- native queries only inside an isolated worker;
- a host-owned wall-clock deadline;
- worker termination and replacement when the deadline is exceeded;
- deterministic SQLite fallback after timeout, crash, or unavailable graph;
- no graph lane result until SQLite postvalidation has succeeded.

Failure to demonstrate bounded termination and recovery is an immediate G4A
NO-GO, even if Cypher functionality and benchmark latency otherwise pass.

## Qualification conclusion

LadybugDB qualifies for exactly one M4A implementation spike because it is
embedded, current, permissively licensed, available as a prebuilt Darwin arm64
Node package, and passed bounded traversal, correction, transaction, persistence
and logical rebuild probes.

Linux and Windows package declarations are documented but have not been
executed locally. Their validation remains a portability item, not evidence
from this probe.

Production adoption remains disabled by default. The existing SQLite ledger
and SQLite adjacency traversal remain authoritative and fully valid if the
spike ends in NO-GO.

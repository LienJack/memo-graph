# ADR 0001: Runtime and SQLite Driver

- Status: Accepted for M0
- Date: 2026-07-28
- Gate: G0

## Decision

Use this exact M0 baseline:

| Component | Pinned line |
| --- | --- |
| Node.js | 24.18.0 LTS |
| pnpm | 10.33.2 |
| TypeScript | 6.0.3 |
| Module format | ESM / NodeNext |
| Runtime validation | Zod 4.4.3 |
| Tests | Vitest 4.1.10 on Vite 7.3.6 |
| Lint | ESLint 10.8.0 + typescript-eslint 8.65.0 |
| SQLite baseline | better-sqlite3 13.0.1 |

Node 24 is the target runtime even when a developer machine has a newer
Current release installed. `.nvmrc`, `.node-version`, `engines`, and the
package-manager lock make that boundary visible.

`better-sqlite3` is the M1 baseline behind a storage port. All reads, writes,
checkpoints, and backups will execute in a dedicated worker because its API is
synchronous and the MCP protocol loop must remain responsive.

## Compatibility probe

The probe ran on Node 24.18.0, macOS 15.5, Darwin arm64:

| Capability | better-sqlite3 13.0.1 | built-in `node:sqlite` |
| --- | --- | --- |
| Prepared statements | Pass | Pass |
| Explicit transactions and rollback | Pass | Pass |
| WAL | Pass | Pass |
| FTS5 | Pass | Pass |
| Backup API | Pass | Pass |
| Defensive API | Driver-specific controls | Pass |
| SQLite library | 3.53.3 | 3.53.1 |
| API maturity | Stable package | Node API is release candidate |

The executable better-sqlite3 probe lives in
`tests/contract/sqlite-driver.compat.test.ts`. It creates only a temporary
database and verifies WAL, FTS5, prepared statements, rollback, and backup.

## Why not `node:sqlite` yet

The built-in module now meets most capability requirements and avoids a native
addon dependency. It is not selected because the official Node API still marks
the module as release candidate rather than stable. The storage port preserves
an inexpensive future migration when the API reaches stable status and passes
the same recovery tests.

## Consequences

- M1 must not import a driver outside the storage adapter/worker.
- Native build scripts are allowlisted only for `better-sqlite3` and the pinned
  `esbuild` binary used by the test toolchain.
- Linux and Windows verification is still required before G1; the M0 probe
  proves only the recorded Darwin arm64 environment.
- A driver change invalidates G0 dependency evidence and requires rerunning the
  contract and compatibility suites.

## Sources

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
- [better-sqlite3 project](https://github.com/WiseLibs/better-sqlite3)

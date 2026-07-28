# G0 Contract Gate Decision

- Decision: **GO**
- Date: 2026-07-28
- Tested implementation commit:
  `e8ae579484ee2d11178c266983d8d7eb8aa0c24c`
- Parent roadmap: `07-28-agent-memory-runtime`
- Milestone task: `07-28-agent-memory-runtime-m0`

## Reproducible baseline

| Evidence | Recorded value |
| --- | --- |
| Node.js | 24.18.0 LTS |
| pnpm | 10.33.2 |
| TypeScript | 6.0.3 |
| MCP server SDK | `@modelcontextprotocol/server` 2.0.0 |
| SQLite driver | `better-sqlite3` 13.0.1 |
| SQLite library through driver | 3.53.3 |
| Runtime validation | Zod 4.4.3 |
| Test runner | Vitest 4.1.10 |
| Platform | macOS 15.5, Darwin 24.5.0, arm64 |
| Dependency lock SHA-256 | `91f64b635495f4f1a6d4479820e7ce5d7f8082253b3f511fe6c9066d5efecc9f` |
| Replay manifest SHA-256 | `8827b6fd6f1db6df8643faa46cdd5ce1008c10cca092fada555e3896cd7804e3` |

The gate evidence was produced from the tested implementation commit after a
frozen-lockfile install on the pinned Node runtime. An earlier exploratory run
on the developer shell's Node 26 installation was green but is intentionally
excluded from the gate evidence because Node 26 is outside the declared engine
range.

## Gate results

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm test:contract` | Pass: 6 files, 33 tests |
| `pnpm test:fixtures` | Pass: 1 file, 3 tests |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm audit --audit-level high` | Pass: no known vulnerabilities |
| SQLite capability probe | Pass: WAL, FTS5, prepared statements, rollback, backup |

The replay corpus contains eleven immutable cases split into five calibration,
four holdout, and two transfer cases. The fixture tests prove manifest hashes,
declared outcomes, risk-family coverage, and partition isolation. The
performance envelope fixes record, event, artifact, concurrency, latency, and
token-budget targets before M1 implementation.

## Boundary review

No unresolved question changes any of the four G0 architectural boundaries:

1. SQLite remains the authoritative ledger.
2. MCP begins as a local stdio lifecycle with repository-owned request and
   response contracts.
3. Graph and vector stores remain optional, independently gated, rebuildable
   projections rather than authorities.
4. Learning remains candidate-only until evaluation, authorization, canary,
   and rollback gates exist.

The tree contains schemas, fixtures, compatibility probes, and documentation
only. It does not contain migrations, canonical repositories, MCP product
handlers, graph/vector adapters, or learning publication behavior.

## Known debt carried into G1

- The executable compatibility evidence covers Darwin arm64 only. Linux and
  Windows packaging and recovery evidence are required before G1.
- `node:sqlite` satisfies the tested feature set but remains release candidate;
  `better-sqlite3` stays behind the storage port.
- The graph backend is deliberately unselected until G4A.
- No vector or learning release implementation exists; those remain separate
  G4B and G5 decisions.
- The parent Trellis implementation document exceeds the context-injection
  size threshold. This is a planning-tool warning, not product runtime debt;
  milestone children must keep their own bounded implementation context.

## Decision

**GO to M1A.** M0 has frozen the contracts and measurement boundary required to
implement the SQLite ledger. Any change to the lockfile, canonical
serialization, public schemas, replay corpus, SQLite authority model, MCP
lifecycle, graph boundary, or learning release boundary invalidates this
decision and requires G0 recertification.

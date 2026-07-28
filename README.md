# memo-graph

`memo-graph` is a local, SQLite-authoritative memory runtime for Codex and
other MCP clients. It stores immutable evidence, governs versioned L1 memory,
compiles bounded Context, and records replayable receipts for every supported
read or mutation.

## Current accepted boundary

The accepted runtime includes:

- an append-only L0 evidence and episode ledger;
- FTS5-backed governed recall with canonical SQLite fallback;
- versioned L1 admission, correction, conflict, user controls, tombstone-first
  deletion, purge, backup, and verified restore;
- an explicit stdio MCP loop for Context compilation and episode commit.

M3 L2/L3 projections and the layered Context Compiler are implemented as an
experimental, rebuildable plane, but G3 is currently **HOLD**. Projection
lanes remain disabled by default while bounded retrieval, source-frontier
validation above 1,000 active L1 rows, and multi-scope frontier composition
are corrected and re-evaluated. The authoritative and releasable fallback is
the accepted L0/L1 path.

See:

- `docs/evaluations/g2-decision.md` for the accepted L1 governance gate;
- `docs/evaluations/g3-decision.md` for the current M3 HOLD and unblock
  requirements;
- `docs/operations/mcp-explicit-loop.md` for local MCP configuration;
- `docs/operations/memory-governance.md` for approvals and user controls.

## Development

Use Node.js 24.18.0 and pnpm 10.33.2.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

The repository uses Trellis. Active requirements, design, implementation
checklists, gate evidence, and developer journals live under `.trellis/`.

## Safety model

SQLite is the sole authority. FTS, L2/L3 projections, relations, and future
graph/vector stores are derived and rebuildable. A derived hit never grants
permission to enter Context: principal, exact scope, lifecycle, validity,
sensitivity, lineage, conflict, usage, tombstone, and purge rules are checked
against canonical state first.

This repository currently provides local synthetic evidence, not a production
readiness claim.

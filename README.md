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
  deletion and purge;
- the G3R-remediated layered Context Compiler over rebuildable SQLite-derived
  L2/L3 projections;
- an explicit stdio MCP loop for Context compilation and episode commit;
- one exact local synthetic G5 governed-learning release/rollback path, while
  automatic publication remains disabled.

Graph remains disabled under G4A `NO-GO`, and vector remains disabled under
G4B `NO-GO`; SQLite relations plus FTS5/recency/layered recall are the active
fallbacks. M6 implemented local operational hardening, but G6 is **NO-GO**
because direct per-fault integrity proofs and direct typed Runbook automation
evidence remain blocked. Its signed control is audit-only and keeps secret
admission disabled. The runtime therefore remains local experimental software,
not a production release.

See:

- `docs/evaluations/g3r-h3-decision.md` for the accepted layered Context gate;
- `docs/evaluations/g4a-decision.md` and `g4b-decision.md` for the independent
  graph/vector NO-GO decisions;
- `docs/evaluations/g5-decision.md` for the exact local synthetic governed
  learning decision;
- `docs/evaluations/g6-decision.md` for the terminal operational NO-GO;
- `docs/operations/mcp-explicit-loop.md` for local MCP configuration;
- `docs/operations/memory-governance.md` for approvals and user controls.

## Memory Workbench

The local Memory Workbench adds a browser entry for governed memory browsing,
immutable correction, a bounded SQLite-backed relationship Graph, and a
separate read-only Runtime dashboard. It does not introduce a second memory
authority: SQLite remains canonical, while topics, scenarios, relations, FTS,
and Graph views remain derived.

Build and launch it with an existing private operator configuration:

```bash
pnpm build:runtime
node apps/operator-cli/dist/cli.js workbench \
  --config /absolute/private/operator.json \
  --format human
```

Normal launch starts or reuses one managed Runtime and opens a one-use,
authenticated loopback URL. Use `--no-open` or `--headless` when browser opening
must be suppressed; a pairing code is revealed only on the controlling TTY.

See `docs/operations/memory-workbench.md` for configuration, lifecycle, recovery,
and trust boundaries. Workbench-specific verification is recorded in
`docs/evaluations/memory-workbench-verification.md`; it is not G6 or production
qualification.

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

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
must be suppressed; a one-use launch URL is revealed only on the controlling
TTY and can be opened directly without entering a code.

See `docs/operations/memory-workbench.md` for configuration, lifecycle, recovery,
and trust boundaries. Workbench-specific verification is recorded in
`docs/evaluations/memory-workbench-verification.md`; it is not G6 or production
qualification.

## Codex automatic memory

The managed Runtime now supports low-burden automatic capture, asynchronous
model-assisted formation, local policy/admission, bounded per-prompt recall,
and a Workbench audit/Undo path. Users do not need to say “remember” for the
automatic path. Provider output remains untrusted and cannot publish memory
without local evidence, authority, scope, conflict, and risk checks.

The current fresh-install default remains `observe`, not `balanced`: the
reproducible replay, privacy, reliability, latency, and browser gates pass, but
the complete physical Codex Desktop lifecycle matrix is not yet recorded.
Explicit MCP remains the supported fallback/control path, and an operator may
explicitly select `balanced` for local evaluation.

See `docs/operations/codex-automatic-memory.md` for the local/remote data
boundary, provider setup, modes, Workbench inspection, Undo, disablement, and
rollback. The exact qualification and remaining blocker are recorded in
`docs/evaluations/codex-automatic-memory-verification.md`.

## Install for Codex

After installing pnpm 10.33.2, install and register the managed memory tools
with one command from a fresh checkout:

```bash
pnpm codex:install
```

The command runs the frozen workspace install itself. pnpm downloads and locks
Node.js 24.18.0 through `devEngines.runtime`, so a separately installed Node 24
or a manual version-manager switch is not required.

On a clean account, the installer creates private, matching MCP/operator
configuration, an external Ed25519 recovery authority, and a local data root
under the platform's XDG directories. Existing configuration is preserved. If
only one of the two configuration files exists, installation fails closed
instead of guessing how to merge policy.

The command builds a self-contained, content-addressed release outside the Git
checkout, copies the locked Node runtime into the private installation root,
registers `memo_graph_memory` through the Codex CLI, cold-starts the managed
Runtime, and completes an official MCP `tools/list` handshake before it reports
success. Moving, switching, or deleting the source checkout afterward does not
affect either the installed release or its Node executable. Start a new Codex
task or restart Codex after installation because an already-running task does
not hot-reload MCP registrations.

Use explicit absolute-path overrides when required:

```bash
pnpm codex:install -- \
  --data-root /private/data/memo-graph/data \
  --mcp-config /private/config/memo-graph/mcp.json \
  --operator-config /private/config/memo-graph/operator.json \
  --recovery-authority-root /private/state/memo-graph/recovery-authority \
  --runtime-dir /private/state/memo-graph/workbench-runtime
```

Successful output records the deployed release, registration backup, tool
count, read status, and whether default configuration was created. The
installer prefers a compatible Codex Desktop binary over stale PATH entries.
During an upgrade it may gracefully restart only the exact Workbench owner
whose root, configuration, credentials, descriptor, instance, and PID match.
If registration or the MCP handshake/read probe still fails, a newly started
probe host is identity-checked and stopped, then the previous Codex
registration is restored.

## Development

Use pnpm 10.33.2. The workspace-managed development runtime is Node.js
24.18.0.

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

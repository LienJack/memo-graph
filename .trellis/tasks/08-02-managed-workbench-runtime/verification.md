# Verification

## Installed local configuration

- Installed Node runtime: `/Users/lienli/.local/share/memo-graph/codex-bootstrap/runtimes/node-24.18.0-ee6fb0e015284d83a91e/bin/node` (`v24.18.0`).
- MCP config: `/Users/lienli/.config/memo-graph/mcp.json` (`0600`).
- Operator config: `/Users/lienli/.config/memo-graph/operator.json` (`0600`).
- Codex bootstrap release: `/Users/lienli/.local/share/memo-graph/codex-bootstrap/releases/release-dbc85139c1d82bbd1aaa/dist/cli.js`.
- Stable Runtime directory: `/Users/lienli/.local/state/memo-graph/workbench-runtime` (`0700`).
- Workbench/MCP config identity: `sha256:9b690b424936fb30c364b27bb9a2006bffb0b7ca68ae8ee5354c4495a6c0f104`.
- Destructive tools remain disabled.

Codex now launches:

```text
/Users/lienli/.local/share/memo-graph/codex-bootstrap/runtimes/node-24.18.0-ee6fb0e015284d83a91e/bin/node
  /Users/lienli/.local/share/memo-graph/codex-bootstrap/releases/release-dbc85139c1d82bbd1aaa/dist/cli.js
  --mcp-config /Users/lienli/.config/memo-graph/mcp.json
  --operator-config /Users/lienli/.config/memo-graph/operator.json
  --runtime-dir /Users/lienli/.local/state/memo-graph/workbench-runtime
```

Rollback restores the previous direct entry:

```text
/Users/lienli/.nvm/versions/node/v24.18.0/bin/node
  /Users/lienli/Documents/GitHub/memo-graph/packages/mcp-server/dist/cli.js
  --config /Users/lienli/.config/memo-graph/mcp.json
```

## Results

- Operator and MCP schemas parse and produce the same canonical Runtime identity.
- Existing-host path: `REUSED -> MCP_MANAGED_READY`, 19 tools, prior evidence search `OK`.
- Cold path with no host: `STARTED -> browser_opened -> MCP_MANAGED_READY`, prior evidence search `OK`.
- Same-parent/same-instance double start: two `REUSED`, one `browser_opened`, two `MCP_MANAGED_READY`, zero `HOST_UNAVAILABLE`. Browser markers also bind the Workbench instance so a replacement host can open one fresh page.
- Cross-environment path: a client with macOS `TMPDIR` and a sanitized client without it reused the same stable endpoint.
- Exact stale recovery: a synthetic expired lease for dead PID `999999` produced `EXACT_DEAD_OWNER_PROOF -> STARTED -> browser_opened -> MCP_MANAGED_READY`; prior evidence remained searchable.
- Live-owner path reused the owner and did not recover its lease. Contract recovery tests cover mismatched root, lease, fence, heartbeat, time, and owner-liveness refusal.
- Loopback HTTP returned 200; Runtime endpoint was `ready`; descriptor, credential and marker artifacts were private.
- Real browser checks loaded Memory, Graph and Runtime; Runtime reported consolidation, FTS and writer lease healthy.
- The repository installer returned `tool_count: 19` and read probe status
  `NO_MATCH`; an immediate repeat selected
  a content-addressed release. A full-text scan found no source-worktree or
  random staging paths in the installed release or deployed Node runtime.
- A no-`node_modules` checkout started under the system Node `v26.3.0` and pnpm
  `10.33.2` completed `pnpm codex:install` without a manual Node switch. pnpm
  installed runtime `24.18.0`, the installer created private defaults, and the
  final probe returned 19 tools plus `NO_MATCH`.
- Codex discovery skipped incompatible candidates using `mcp list --json`; an
  exact old-contract Workbench regression proved identity-checked `SIGTERM`,
  one retry, new-host readiness, and a successful final MCP probe.
- A cold deployment with an empty data root and external recovery authority
  reached `runtime_state=ready` and listed all 19 tools from a working directory
  outside the source tree.
- A fresh ephemeral Codex task discovered `memo_graph_memory.memory_search`,
  executed it successfully, and received structured status `NO_MATCH`.
- `pnpm lint`, `pnpm typecheck`, and the bootstrap regression suite (10/10)
  passed. The full suite passed 787 tests with 6 skipped and 10 failures:
  frozen G5/G6 integrity checks reject the intentional dirty implementation,
  while operator key availability and the browser governance expectation remain
  outside this install change. The two full-suite timeout cases both passed
  immediately when rerun in isolation with their normal timeout.

## Current runtime snapshot

At final local verification on 2026-08-03, the Workbench endpoint was
loopback-only at `http://127.0.0.1:62795`, host PID `21620`, and
`runtime_state=ready`. These values are runtime snapshots and may change after
restart; consumers must read endpoint metadata rather than persist them.

## Remaining user acceptance

- Fully quit and reopen the Codex desktop app.
- Confirm one authenticated Workbench page opens automatically.
- Desktop-only follow-up: fully quit and reopen the Codex desktop app, then
  confirm one authenticated Workbench page opens automatically. Fresh Codex CLI
  task registration and read invocation are already verified.

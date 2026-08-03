# Verification

## Installed local configuration

- Node runtime: `/Users/lienli/.nvm/versions/node/v24.18.0/bin/node` (`v24.18.0`).
- MCP config: `/Users/lienli/.config/memo-graph/mcp.json` (`0600`).
- Operator config: `/Users/lienli/.config/memo-graph/operator.json` (`0600`).
- Codex bootstrap: `/Users/lienli/.config/memo-graph/codex-managed-mcp.mjs` (`0600`).
- Stable Runtime directory: `/Users/lienli/.local/state/memo-graph/workbench-runtime` (`0700`).
- Workbench/MCP config identity: `sha256:9b690b424936fb30c364b27bb9a2006bffb0b7ca68ae8ee5354c4495a6c0f104`.
- Destructive tools remain disabled.

Codex now launches:

```text
/Users/lienli/.nvm/versions/node/v24.18.0/bin/node
  /Users/lienli/.config/memo-graph/codex-managed-mcp.mjs
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

## Current runtime snapshot

At final local verification on 2026-08-03, the Workbench endpoint was loopback-only at `http://127.0.0.1:60618`, host PID `53029`, with writer fence token `14`. These values are runtime snapshots and may change after restart; consumers must read endpoint metadata rather than persist them.

## Remaining user acceptance

- Fully quit and reopen the Codex desktop app.
- Confirm one authenticated Workbench page opens automatically.
- In a new Codex task, call `memo_graph_memory` and verify a read succeeds.

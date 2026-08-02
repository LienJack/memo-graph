# Live verification

## Installed runtime

- Codex MCP name: `memo_graph_memory`
- Node: `/Users/lienli/.nvm/versions/node/v24.18.0/bin/node` (`v24.18.0`)
- Server: `/Users/lienli/Documents/GitHub/memo-graph/packages/mcp-server/dist/cli.js`
- Private config: `/Users/lienli/.config/memo-graph/mcp.json` (`0600`)
- SQLite data root: `/Users/lienli/.local/share/memo-graph` (`0700`)
- External recovery authority: `/Users/lienli/.config/memo-graph/recovery-authority` (`0700`; key and head files `0600`)

## Acceptance result

The official `@modelcontextprotocol/client` v2 client launched the configured
stdio command twice with Node 24.18.0.

- runtime readiness: `ready`
- discovered tools: 19; required Context/search/get/ingest/commit tools present
- discovered resources: 5; health, storage-health, contracts, usage and learning
- destructive tools enabled: `false`
- committed evidence: `evidence:f714c23e9fd685ff3f86dcecc9f3e4aab2c9519d87a17dc3dafc10366a8690d3`
- idempotent replay: identical receipt; ledger epoch remained `1`
- post-restart canonical search: `OK`
- post-restart exact get: `OK`
- post-restart Context compilation: `DEGRADED`, with warning `frozen replay of a partial retrieval`; a frozen hash was returned
- frozen hash: `sha256:c4dabadfebfe33438322bc13408552563e2473c2b251db56b180c0832df5fc39`

The Context status is retained as a degraded partial-lane signal rather than
reported as full success. Canonical SQLite persistence and explicit memory
retrieval both passed.

## Operational notes

- The configured transport is stdio. Codex starts the process on demand; there
  is no separate HTTP daemon to leave running.
- Codex Desktop must start a new task or restart before the newly configured
  MCP appears in its tool set.
- MCP cannot observe conversation content that Codex does not explicitly send.
  Task-start recall and task-end commit remain explicit tool calls.
- An intentionally aborted verifier left an expired root writer lease. It was
  recovered only through `recoverStaleRootLease` with exact root, lease, fence,
  heartbeat, expiry and dead-owner proof; the lock was not manually deleted.

## Spec sync decision

No `.trellis/spec/` update is required. This task deployed the existing MCP
contract without changing a command signature, API, schema, storage behavior,
or project coding convention. The recovery authority and stale-lease contracts
remain owned by the existing runtime schema, implementation, and integration
tests; this task records only the machine-local paths and observed acceptance
result.

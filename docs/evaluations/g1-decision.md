# G1 Local MCP Loop Gate Decision

- Decision: **GO**
- Date: 2026-07-28
- Tested implementation commit:
  `cd1057776529c0cff04ec9a17548488bcddd00c1`
- Implementation commits:
  `9f510e5` and `cd10577`
- Parent roadmap: `07-28-agent-memory-runtime`
- Milestone task: `07-28-agent-memory-runtime-m1b`
- G1A lineage: **GO**

## Frozen runtime and schema

| Field | Value |
| --- | --- |
| Node.js used for every gate command | 24.18.0 |
| pnpm | 10.33.2 |
| Platform | Darwin arm64, macOS 15.5 |
| Official MCP server/client | 2.0.0 / 2.0.0 |
| `better-sqlite3` | 13.0.1 |
| SQLite | 3.53.3 |
| Schema frontier | `0003` |
| Dependency lock SHA-256 | `e4d3347083d9b0147fc7ce581671196f3cc4883a5ef7663d179a3d44074dd695` |
| Migration 0001 SHA-256 | `707146d45e5f6d5e4c31740a85cd7eb81c43ec379bd39b2600cde533515e8e11` |
| Migration 0002 SHA-256 | `b70b77de89023929151ba1440d1a8971b7179bde9a5c40f529db6c99a74166f8` |
| Migration 0003 SHA-256 | `ed6d7538ee160a75bfdde47e58a131d98a172038a5c8615823766aa7babdd69b` |
| Replay manifest SHA-256 | `8827b6fd6f1db6df8643faa46cdd5ce1008c10cca092fada555e3896cd7804e3` |

## Gate evidence

All commands below were rerun on the tested implementation commit with the
pinned Node runtime:

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm test:contract` | Pass: 6 files, 34 tests |
| `pnpm test:fixtures` | Pass: 1 file, 3 tests |
| `pnpm test:storage` | Pass: 4 files, 26 tests |
| `pnpm test:recovery -- writer-restart` | Pass: 1 file, 1 test |
| `pnpm test:mcp` | Pass: 2 files, 10 tests |
| `pnpm test:integration -- codex-explicit-loop` | Pass: 1 file, 1 test |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm audit --audit-level high` | Pass: no known vulnerabilities |
| `pnpm benchmark:baseline` | Pass: all three Small-profile p95 targets |

The six disjoint suites total 15 files and 75 tests.

## Real stdio transcript evidence

`codex-explicit-loop.integration.test.ts` uses the official v2
`Client` and `StdioClientTransport` to spawn the emitted
`packages/mcp-server/dist/cli.js`. It does not call an in-memory handler.

| Step | Observed result |
| --- | --- |
| Session 1 discovery | Six tools with exact annotations and three inspection resources |
| Resource reads | Health unchanged; no recall audit or epoch change |
| Initial `memory_context_compile` | `NO_MATCH` with a sealed retrieval receipt |
| `memory_episode_commit` | `OK`; repeating identical input returned the identical receipt |
| Session 1 frontier | One evidence event, one episode, ledger epoch 1 |
| Process boundary | Official client closed the first child; a new child opened the same ledger |
| Session 2 `memory_context_compile` | `OK`; one L0 item, within 1,800 tokens |
| Hash replay | Context `frozen_hash` and retrieval `receipt_hash` validated canonically |
| Unauthorized request | `FAILED/PERMISSION_DENIED`; recall and receipt counts unchanged |
| Stderr hygiene | JSON metadata only; data-root path, query text, and injected secret marker absent |

The executable usage and Codex MCP configuration are documented in
`docs/operations/mcp-explicit-loop.md`. This gate proves the real local stdio
wire and child-process restart. It does not claim that a user has installed
the sample configuration into a live Codex product instance or that MCP can
observe unsent Codex lifecycle events.

## Assertions closed

- One immutable process configuration owns the principal, allowed scopes,
  allowed authorities, destructive posture, data root, and default budget.
- Tool identity, safety class, actor, authority, and scope claims are decoded
  and authorized before storage work.
- FTS and exact evidence reads filter both principal and scope. Receipt lookup
  additionally requires durable principal/scope access rows written in the
  same transaction as the receipt.
- The only M1 mutation tool is proposal-only `memory_episode_commit`; the
  canonical idempotency receipt prevents duplicate effects.
- Read tools can append operational retrieval evidence but cannot change
  evidence, episodes, idempotency, outbox content, or ledger epoch.
- Context compilation counts content, provenance, and uncertainty, packs only
  whole items, and passes 1, 1,800, and 32,000-token boundaries while rejecting
  zero and 32,001.
- `NO_MATCH`, `POLICY_EXCLUDED`, `DEGRADED`, and `FAILED` remain distinct.
  Pending or unavailable FTS with no real fallback reports
  `fallback_lane="none"` rather than fabricating results.
- Recall requests, Context slices/items/lineage, retrieval receipts, and
  receipt access rows are append-only and replay hash-valid JSON.
- Resource descriptions and the operations guide state that resources are not
  automatically injected into model Context.

## Performance

The stored [M1B runtime baseline](./m1b-runtime-baseline.md) populated 10,000
events and measured 200 samples per operation:

| Operation | p50 | p95 | M0 p95 target |
| --- | ---: | ---: | ---: |
| Governed search | 0.591 ms | 0.728 ms | 200 ms |
| Context compilation and receipt | 0.768 ms | 1.009 ms | 400 ms |
| Episode commit and FTS drain | 1.627 ms | 4.350 ms | 150 ms |

This is Small-profile, one-reader kernel/storage evidence. It excludes stdio
startup latency and does not certify the Expected or Stress profiles.

## Known debt

- Executable and recovery evidence remains Darwin arm64 only.
- A live Codex installation/dogfood run is not part of this gate; the tested
  host is the official MCP v2 client using a real stdio child process.
- The lifecycle is explicit. There is no automatic host adapter or access to
  conversation/task events that the host does not send.
- The storage adapter still uses one worker for reads and writes. Expected and
  Stress profiles, four readers, and stdio transport latency remain unmeasured.
- Retrieval audit tables have no retention/compaction policy yet and can grow
  with long-running use.
- Mutation receipts created before migration 0003 have no receipt-access rows
  and therefore fail closed under `memory_receipt_get`.
- M1 compiles governed inline L0 evidence only. L1 admission, correction,
  revocation, purge, L2/L3, graph/vector, and learning remain unavailable.
- Secret evidence and untrusted-volume storage still fail closed until M6
  implements application encryption and key lifecycle.

## Decision

**GO to M2 L1 governance.**

G1 proves the bounded local-only explicit memory loop on the frozen lock and
schema. It does not authorize graph or vector adoption, automatic memory
promotion, destructive operations, or learning release. Those remain behind
G2-G5 and their independent GO/No-Go decisions.

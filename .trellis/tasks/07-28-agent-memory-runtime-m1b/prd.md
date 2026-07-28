# Agent Memory Runtime M1B stdio MCP explicit loop

## Goal

Implement local-principal-bound stdio MCP tools/resources, an L0 evidence
service, a budgeted baseline Context compiler, recall/context receipts, and the
end-to-end task-start/task-end loop that closes parent G1.

## Authority

1. Product Contract R1-R3, R6, R9-R13, R17-R19 and acceptance examples AE1,
   AE3, AE5, AE7.
2. Parent `design.md` and M1/G1 section of `implement.md`.
3. G0 and G1A decisions on the current schema and lock.
4. MCP, database, error, logging, and quality specifications.

This child does not add or renumber product requirements.

## In scope

- Official `@modelcontextprotocol/server` and client 2.0.0 over local stdio.
- Configuration-owned local principal, allowed scopes/authorities, data root,
  and destructive-write posture; request payloads remain untrusted claims.
- Read-only `memory_search`, `memory_get`, `memory_explain`,
  `memory_receipt_get`, and `memory_context_compile`.
- Proposal-only `memory_episode_commit` with durable storage idempotency.
- Static inspection resources for health, contract/tool metadata, and usage.
- A baseline L0 Context compiler with deterministic token accounting,
  provenance, selection reasons, uncertainty, frozen hash, retrieval receipt,
  and a hard caller budget.
- Forward migration for recall requests, retrieval receipts, Context slices,
  and their items without changing canonical memory epoch.
- Typed OK, NO_MATCH, POLICY_EXCLUDED, DEGRADED, and FAILED responses.
- Stderr metadata diagnostics only; stdout is the MCP wire.
- An executable task-start compile / task-end commit guide.
- A real child-process stdio test where one session commits and a new session
  recalls from the same local ledger.

## Out of scope

- Automatic prompt injection or claims that resources enter Context without a
  tool call.
- L1 admission, corrections, revocation, deletion, graph/vector projections,
  or learning release.
- Secret-content admission; the M1A encryption fail-closed rule remains.
- HTTP transport, OAuth, multi-user identity, or remote storage.
- Claiming Codex product integration from SDK-only or in-memory tests; the G1
  evidence must include an actual stdio process and documented host
  configuration.

## Invariants

- The configured principal is immutable for one server process. Payload actor
  or scope claims never expand it.
- Unauthorized requests fail before storage search, receipt lookup, or
  mutation.
- Read tools/resources never change evidence, episode, idempotency, outbox, or
  ledger epoch. Recall audit rows are append-only operational evidence.
- `memory_episode_commit` is the only M1 mutation tool and stays proposal
  safety class.
- Context never exceeds the requested budget. Content, provenance, and
  uncertainty all count.
- NO_MATCH, POLICY_EXCLUDED, DEGRADED, and FAILED remain mechanically
  distinct.
- Context and retrieval receipt hashes replay exactly from their stored JSON.
- stdout contains protocol frames only; logs and errors cannot expose memory
  content, queries, paths, or tokens.

## Acceptance Criteria

- [ ] `pnpm test:mcp` proves tool annotations, schemas, principal binding,
  safety classes, statuses, resources, idempotency, and stdout/log hygiene.
- [ ] `pnpm test:integration -- codex-explicit-loop` starts a real stdio server,
  compiles an initial NO_MATCH, commits one episode, starts a new server
  session, and recalls a frozen Context slice.
- [ ] Repeating `memory_episode_commit` returns the identical receipt and one
  episode.
- [ ] Principal/scope mismatch changes no storage or recall-audit counts.
- [ ] Search, get, explain, receipt lookup, Context compile, and resource reads
  leave canonical ledger epoch and content counts unchanged.
- [ ] Context output stays within budgets at 1 token, the default 1,800, and the
  32,000 hard maximum; zero/overflow budgets fail input validation.
- [ ] Privacy fixtures produce zero cross-scope results.
- [ ] Pending/unavailable FTS returns DEGRADED rather than NO_MATCH or
  fabricated data.
- [ ] Stored retrieval receipts and Context slices pass their M0 runtime
  schemas and hash replay.
- [ ] M0, M1A, recovery, lint, typecheck, build, frozen install, and audit
  remain green on Node 24.18.0.
- [ ] `docs/evaluations/g1-decision.md` records implementation commit, lock,
  schema/migration hashes, real stdio evidence, tests, baseline performance,
  debt, and `GO` or `HOLD`.

## Notes

- G1 `GO` authorizes M2 L1 governance; it does not authorize graph/vector
  adoption or learning release.
- If stdio host integration, principal binding, receipt replay, or budget
  enforcement fails, set G1 to `HOLD`, keep storage read-only/degraded, and do
  not activate M2.

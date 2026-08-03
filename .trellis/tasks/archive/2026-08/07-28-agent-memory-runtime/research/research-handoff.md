# Agent Memory Runtime research handoff

## Purpose

This file transfers the closed `research-to-article` findings into the future implementation task. It is a planning artifact, not a substitute for the archived evidence, and it does not authorize implementation.

## Authority

- Product Contract: `docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md`
- Research topic: `/Users/lienli/Documents/work/深度调研/research/agent-context-management`
- Foundation run: `RUN20260728-185646-codex-mcp-roadmap-aeebad`
- Graph and evaluation follow-up run: `RUN20260728-195300-session-70a1e8`
- Primary synthesis: `RQ032`
- Supporting research: `RQ033`–`RQ041`
- Research readiness at handoff:
  - 41 questions;
  - 162 claims;
  - 131/131 core claims supported;
  - 23 research runs completed;
  - `validate-ready` passed, with one unrelated legacy warning retained in the research workspace.

The answer and evidence stores remain authoritative. This handoff intentionally records only the decisions needed by the roadmap.

## Settled research constraints

### MCP and Codex

- The initial integration is an explicit local MCP loop, not invisible lifecycle capture.
- Codex requests a governed `FrozenContextSlice` at task start and submits an episode or proposal at an explicit boundary.
- A standalone MCP server cannot claim access to conversation or lifecycle data the Codex Host did not send.
- Automatic observation belongs to a later Host Adapter that must preserve the same versioned request, authority, idempotency, and receipt contracts.

### Memory authority and layers

- L0 evidence and L1 governed memory require a transactional local authority.
- SQLite is the planning baseline for identity, immutable revision history, scope, validity, authority, tombstones, release pointers, idempotency, and receipts.
- L2 Topic, Scenario and Relation projections and L3 Core projections remain derived and must retain drill-down lineage to live L1/L0 records.
- Abstraction level, lifecycle, kind, scope, bitemporal validity, authority, and sensitivity are independent dimensions.
- Context is a frozen per-invocation projection, not another durable truth source.

### Graph adoption

- A graph model is appropriate for high-level temporal, causal, procedural, lineage, entity, topic, and scenario relations.
- A separate graph database is not an MVP prerequisite. SQLite relation tables and recursive CTEs establish the first graph traversal baseline.
- Graph storage, if adopted, is a rebuildable L2/L3 projection. Graph results must be revalidated against canonical SQLite status before entering context.
- Kùzu must not be selected as the default new-project backend: its upstream repository is archived and Graphiti has deprecated that path.
- The graph adapter remains disabled unless a paired replay proves material structural value and passes provenance, correction, purge, deterministic rebuild, fallback, latency, disk, privacy, and local-operations gates.
- SQLite-only is a valid and complete graph decision outcome.

### Vector retrieval

- Vector retrieval is an optional candidate-generation lane, not an authority mechanism.
- The semantic-gap subset must be declared before choosing an embedding model or vector index.
- FTS5, vector, and hybrid arms use the same hard filters, cases, reader, and Context budget.
- No-adoption is a valid completed decision when measured gains do not justify invalidation, privacy, latency, disk, or recovery cost.

### Self-learning

- Self-learning is a versioned candidate-and-release system, not model fine-tuning and not direct online self-modification.
- The online Agent may record a `LearningTrace` and propose a minimal reversible change.
- The online Agent may not publish Core Memory, Prompt, policy, Skill, or release-pointer changes.
- Evaluation compares `no_candidate`, `current`, and `candidate` on frozen calibration, protected holdout, and transfer cases.
- Publication requires quarantine, explicit authority, canary, monitoring, a versioned release receipt, and an exact rollback target.
- Critical safety, privacy, deletion, scope, or negative-transfer failures cannot be offset by average quality gains.

## Evaluation protocol

### Shared arms

1. `no_memory`
2. `transcript/current`
3. `fts_recency`
4. `layered`
5. `layered_graph`
6. `candidate_learning`

### Corpus roles

| Corpus | Primary role | Product gaps filled locally |
| --- | --- | --- |
| LoCoMo | Long-dialogue single-hop, multi-hop, temporal, adversarial and event-graph behavior | Codex tool trajectories, correction, purge, MCP status semantics |
| LongMemEval | Cross-session extraction, knowledge update, temporal reasoning and abstention | Agent workflow state, local persistence and recovery |
| LongMemEval-V2 | Static/dynamic Agent state, workflow knowledge, environmental gotchas, premise awareness and quality/latency frontier | User correction, hard deletion, authorization and SQLite/graph recovery |
| memo-graph fixtures | Product Contract behavior and failure/recovery invariants | Not a replacement for general long-memory comparisons |

### Hard No-Go invariants

- cross-scope or unauthorized recall;
- tombstoned or revoked content resurrection;
- duplicate canonical effects for one idempotency key;
- projection state that cannot be rebuilt or traced;
- a Context slice exceeding its declared budget;
- an online learning candidate changing a production pointer;
- rollback that cannot restore the exact accepted version;
- stale backup restore moving behind the tombstone or release frontier.

## Roadmap mapping

| Research conclusion | Planning unit | Gate |
| --- | --- | --- |
| Freeze contracts, fixtures, threat model and measurement before implementation | U1 | G0 |
| Establish SQLite/FTS and explicit MCP loop | U2–U3 | G1 |
| Prove version, correction and deletion governance | U4 | G2 |
| Establish layered projections and Context Compiler on SQLite | U5 | G3 |
| Compare a maintained graph adapter against SQLite relations | U6 | G4A |
| Compare optional vector retrieval against FTS5 | U7 | G4B |
| Evaluate candidate-only learning and exact rollback | U8 | G5 |
| Prove backup, restore, migration, privacy and degraded operation | U9 | G6 |

## Claim and evidence anchors

### Graph decision

- Claims: `CLa5bc43569606`, `CL878cf8d78307`, `CL628511c44e9d`
- Evidence:
  - `W1133d2091e4e` — SQLite recursive CTE graph-query capability;
  - `Wd6f43ae05df1` — SQLite WAL and local concurrency baseline;
  - `Wec7c36c51fe7` — Graphiti temporal graph, provenance and backend posture;
  - `Wdf1f62dba0c5` — official Kùzu repository archived.

### Evaluation and learning decision

- Claims: `CLc5dfbfb0e5a1`, `CL11b490275746`, `CLd71684b54222`
- Evidence:
  - `W000b85cb4b16` — LongMemEval-V2 official repository;
  - `W975e29bf949d` — LoCoMo official project;
  - `Wa878793e8780` — LongMemEval-V2 paper;
  - `W530d97e2e363` — long-horizon evaluation limitations;
  - `Wd7b4aba6018c` — *AI Agents in Depth*, chapter 8.

## Open decisions that must remain in U1

- Exact Node LTS, package manager, module format, stable MCP SDK and SQLite driver.
- Local threat model and whether file permissions are sufficient or encryption at rest is required.
- Frozen workload envelope and numeric Go/No-Go thresholds.
- Maintained graph candidates available at implementation time.
- Embedding model and index only if the vector semantic-gap gate is opened.
- Exact evaluator/Judge versions and acceptable repeat-run variance.

These decisions must not be silently preselected by the planning documents.

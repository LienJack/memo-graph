---
date: 2026-07-28
milestone: M2
gate: G2
research_run: RUN20260728-231007-m2-governance-implementa-8ca6a5
source_commit: 14248470946f937e3ce97ddadb506227e01b4650
status: ready_for_planning
---

# M2 Versioned L1 Governance — Research Handoff

## Research question

在现有 Agent Memory Runtime 中，怎样以可验证、可恢复的方式实现 L1
候选准入、不可变修订、用户控制和删除不复活？

本研究继承父 Product Contract 的 R1–R20，以 R2、R3、R5–R8、
R11–R15、R19–R20 为 M2 的直接约束，覆盖 F1、F3 与 AE2、AE4、AE8。
M2 的唯一退出条件是 G2；本研究不授权 L2/L3、图、向量或学习发布。

## Research runtime status

- Questions: 5/5 answered.
- ResearchRun: completed.
- Plan steps: P001–P005 completed；P006 在本交接写入后完成。
- Evidence: 11 个固定 commit 的代码证据，6 个完整归档的一手网页证据。
- Claims: 10/10 core Claims supported，0 open，0 conflicted。
- Search provider: `mcp:anysearch`，无 fallback。
- Source quality: 6/6 primary，3 个 independence groups，平均 authority 0.95。
- Code graph: 当前仓库没有 `.understand-anything/knowledge-graph.json`；
  本轮代码证据直接绑定 Git commit、repo-relative path 与精确行范围。

完整运行时位于：

`research-workspace/research/m2-versioned-l1-governance/`

## Claim / Evidence index

| Claim | 结论 | 证据 |
| --- | --- | --- |
| CLf4cce517dc1a | M2 继承 M1B SQLite 单写者事务、幂等、outbox、receipt 和 append-only Context；L0 evidence 仍是来源权威 | Cb69fd4e79214, C36b806033928, C5a02e3620ebd |
| CL0e365e068e24 | 准入必须由 evidence authority、sensitivity、scope 和 injection risk 决定；外部指令不能直接激活 | Ca31dcb595a63, W058ef67ec781 |
| CL2c309f177306 | 每个 active L1 revision 必须同时拥有 live evidence lineage 与 persisted AdmissionDecision | Ca31dcb595a63 |
| CLa4a573920fea | stable memory identity、immutable revision 与 expected-revision CAS 必须在同一 `BEGIN IMMEDIATE` 事务闭合 | C11d4bf9ebec4, W0f32b54f0bcc |
| CLd741275f5305 | correction 必须同步写 successor + suppression，再由 outbox 异步清理派生物 | Ca31dcb595a63, C11d4bf9ebec4 |
| CL54379d5d5bd0 | delete 先 tombstone/hard-filter，再运行可重试 Purge Saga；残留债务永远不能伪装完成 | C481781553210, Cd74944d3ea17, C773150f379ca, W6b5690426c7e, W90b57f7dd042 |
| CL8865c6147ee9 | 当前 backup/restore 没有 snapshot 外 tombstone frontier，旧备份可造成语义回退 | Cc8bbbd43ab1a, C62db98fb9373, W42754b59f310 |
| CL63ef4c228d41 | 物理残留检查必须覆盖 SQLite core/FTS secure delete；删逻辑行不足以完成 purge | W6b5690426c7e, W90b57f7dd042 |
| CL3df6bc446a42 | MCP annotations 不是授权；Runtime 必须执行 principal/scope/CAS/逐次确认 | C12af3fd5b335, Wbfba858067cc |
| CL097e6dc03152 | pin、demote、usage block、revoke、delete 是五种不同 mutation，均需幂等 receipt | Ca31dcb595a63, C12af3fd5b335, C481781553210 |

机器真相位于：

`research-workspace/research/m2-versioned-l1-governance/indexes/claims.jsonl`

## Planning decisions

### D1. Add an L1 governance control plane, not a second ledger

SQLite remains authoritative. M2 adds candidate, decision, logical object,
immutable revision, active pointer, conflict, suppression, usage rule,
tombstone, purge job and invalidation records around the existing ledger.
It does not replace L0 evidence or create a new persistence authority.

### D2. Candidate admission is deterministic and evidence-bound

The proposal payload may contain model-extracted content, but admission derives
from persisted evidence rather than self-declared trust.

| Condition | Maximum decision |
| --- | --- |
| Live user-stated evidence, allowed scope, non-secret, no injection flag | `activate` |
| Verified evidence but derived/inferred or confirmation pending | `candidate_only` |
| Sensitive, low-authority, injection-like procedural content, or unresolved conflict | `quarantine` |
| Missing/deleted evidence, forbidden scope, invalid payload, or replay hash mismatch | `reject` |

Exact duplicates reuse the existing logical memory/revision. Same normalized
logical key with different content forms a conflict group; no destructive
upsert is permitted.

### D3. Stable identity and immutable revisions use explicit CAS

- `memory_id` identifies the logical memory.
- `revision_id` identifies immutable governed content.
- A later revision names the exact predecessor.
- Pointer advance requires the caller's `expected_revision_id`.
- The transaction performs a conditional pointer update and requires exactly
  one changed row; zero changed rows is `STALE_REVISION`.
- Duplicate idempotency keys with the same request hash replay the same receipt;
  a different request hash is `CONFLICT`.

SQLite's single writer serializes commits, but it does not replace semantic
CAS: a stale caller can still submit an obsolete expected revision after a
different request committed.

### D4. Correction suppresses synchronously and propagates asynchronously

The canonical correction transaction:

1. validates principal, scope, evidence and expected revision;
2. appends the successor revision;
3. appends a suppression/status event for the prior revision;
4. advances the current pointer with CAS;
5. appends invalidation jobs and a sealed receipt.

Default recall checks suppression/lifecycle before any relevance lane. FTS,
Context and future graph/vector consumers may lag, but stale candidates are
revalidated against canonical status before use.

### D5. User controls remain separate operations

| Operation | Immediate online effect | What it must not do |
| --- | --- | --- |
| Pin | Protect a valid active revision from normal decay/eviction | Upgrade authority, extend validity, resolve conflict, bypass usage block |
| Demote | Move selection/lifecycle downward while preserving history | Rewrite evidence or delete content |
| Usage block | Exclude the memory from one Context scope or all model Context | Delete local evidence or change factual authority |
| Revoke | Hard-filter the memory from default recall and Context | Claim physical deletion |
| Delete | Commit tombstone, hard-filter, create Purge Saga | Wait for asynchronous cleanup before suppressing online use |

Every operation is important or destructive according to the frozen MCP safety
map and returns a sealed, idempotent receipt.

### D6. Server-side authorization is mandatory

Tool annotations are client hints. The Runtime enforces:

- principal and scope binding;
- expected revision CAS;
- local destructive-tools policy;
- a per-invocation approval artifact for important/destructive mutations;
- request-hash-bound idempotency;
- dry-run behavior without canonical mutation.

An LLM-generated claim that “the user approved” is not approval.

### D7. Tombstone is the online safety boundary

`memory_delete` first commits a tombstone epoch and invalidation jobs in the
canonical transaction. All recall, get, explain and Context paths hard-filter
revoked/purged/suppressed objects before ranking and revalidate after any
projection lookup.

The Purge Saga then checks these stores:

1. governed revision payloads;
2. candidate payloads and conflict materializations;
3. FTS rows and stale FTS segments;
4. Context slice item payloads and eligibility;
5. export/cache inventory;
6. content-addressed blobs with reference counts;
7. backup policy and snapshot frontier;
8. future projection consumers through the invalidation outbox.

Partial failure records the remaining content hashes and store names, remains
tombstoned, and is retryable with the original purge job/idempotency identity.

### D8. Shared lineage can produce honest purge debt

Evidence or blobs referenced by another live memory cannot be silently removed.
The deleted memory is still suppressed immediately, but the purge stays
`completed=false` until the caller also removes dependent live memories or the
shared payload becomes unreferenced. Tests must cover both complete exclusive
purge and partial shared-lineage debt.

### D9. Restore must compare a trusted minimum tombstone frontier

SQLite Online Backup creates a consistent snapshot, not a guarantee that the
snapshot is newer than later deletion. M2 therefore adds `tombstone_epoch` to
backup evidence and requires restore to receive a trusted minimum frontier.

- backup epoch >= required frontier: restore may continue, then run migration,
  integrity and residual verification;
- backup epoch < required frontier: fail closed with
  `STALE_TOMBSTONE_FRONTIER`;
- restored queries remain unavailable until verification completes.

M6 will harden durable operational distribution of all frontiers. M2 must
already prove the API invariant and stale-backup rejection fixture.

## Implementation implications

The ce-plan phase should preserve these unit boundaries:

1. contracts and test-first governance input/output schemas;
2. SQLite governance + tombstone/purge migrations;
3. admission, identity, revision CAS and conflict repository;
4. correction/suppression and default recall hard filters;
5. user control mutations and server-side approval;
6. Purge Saga, FTS/Context/blob invalidation and residual audit;
7. backup/restore tombstone frontier;
8. MCP integration, replay/recovery fixtures and G2 decision.

All feature-bearing units require happy-path, concurrency, idempotency,
permission, injection, partial-failure and cross-layer integration coverage
where applicable.

## G2 evidence contract

G2 is GO only when the tested commit proves:

- every active L1 revision has live evidence and an admission decision;
- concurrent successor attempts cannot silently overwrite one another;
- correction suppresses the prior value before projection propagation;
- pinned expired/revoked memory remains excluded;
- scoped/global usage block prevents prohibited Context inclusion;
- prompt-injection candidates cannot activate as procedural/core memory;
- exclusive deletion has zero stale resurrection across canonical, FTS,
  Context, blob, export and restored fixtures;
- partial purge stays tombstoned and names residual debt;
- duplicate correction/delete calls replay the same effect and receipt;
- a backup behind the required tombstone frontier cannot restore service.

Any failure freezes admission and falls back to L0/read-only verified L1.

## Sources

### Code evidence

All code evidence is pinned to
`14248470946f937e3ce97ddadb506227e01b4650` and stored below
`research-workspace/research/m2-versioned-l1-governance/evidence/code/`.

### External primary evidence

- W0f32b54f0bcc — SQLite Transaction.
- W6b5690426c7e — SQLite PRAGMA and `secure_delete`.
- W90b57f7dd042 — SQLite FTS5 delete/rebuild/secure-delete behavior.
- W42754b59f310 — SQLite Online Backup snapshot semantics.
- W058ef67ec781 — OWASP Prompt Injection trust boundaries.
- Wbfba858067cc — MCP Tools trust-and-safety and human-in-the-loop guidance.

Full cleaned Markdown, metadata, source assessment and content hashes are stored
under `research-workspace/research/m2-versioned-l1-governance/evidence/web/`.

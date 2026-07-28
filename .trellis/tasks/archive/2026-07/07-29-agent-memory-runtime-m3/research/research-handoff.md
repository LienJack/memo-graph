---
date: 2026-07-29
milestone: M3
gate: G3
research_run: RUN20260729-022356-m3-layered-projections-a-0c793c
source_commit: 135f3227e72c56c5fc8a256e4064ca0635cbed24
status: ready_for_planning
---

# M3 Layered Projections and Context Compiler — Research Handoff

## Research question

如何在当前 SQLite 权威的 M2 Runtime 上实现可重建的 L2/L3 主题、
场景/过程、关系与核心投影，以及多路受治理 Context Compiler，并用 G3
证明其在相同 token 预算下提升任务效用且不增加上下文污染？

本研究继承父 Product Contract 的 R4、R7–R15、R19–R20，覆盖 F2/F3
和 AE1–AE5。M3 的唯一退出条件是 G3；图、向量、Learning Lab 和 M6
运行加固仍是后续独立决策。

## Research runtime status

- Questions: RQ001–RQ006 均有 supported Claim；在本交接写入后标记 answered。
- Evidence: 10 个固定 commit 的代码证据，6 个完整归档的一手网页证据。
- Claims: 24/24 supported，其中 17 个 core，0 open，0 conflicted。
- Search provider: `mcp:anysearch`，无 fallback。
- Source quality: 6/6 primary，6 个 independence groups，平均 authority
  0.945，平均 extraction quality 0.973。
- Code graph: 仓库没有 `.understand-anything/knowledge-graph.json`；代码证据
  直接绑定 Git commit、repo-relative path 和行范围。
- Adversarial research: 未触发。当前用户消息规定持续工作流，但没有把
  “深度调研这个问题”作为本轮动作指令；按 research config 的
  `phrase_gated` 契约不调用 Grok 或 Codex adversary。

完整机器真相位于：

`research-workspace/research/m3-layered-context-compiler/`

## Claim / Evidence index

| Claim | 结论 | 主要证据 |
| --- | --- | --- |
| CL001 | 分层存储、高层综合、受限 Context 有外部可行性，但外部方案没有定义本项目治理边界 | W7ef376e6ce94, Wefc9ff30e069 |
| CL002 | 最小投影族为 Topic、Scenario/Procedure、Relation、Core，且每个 revision 都要绑定 lower lineage 和 transform | Cd616c3f2f07a, C355361c39adf, Wefc9ff30e069 |
| CL003 | 派生物不能提高来源的 authority/sensitivity/scope/validity/lifecycle 上限 | Cd616c3f2f07a, C355361c39adf, C48a102dc6876 |
| CL004 | Topic 回答“关于什么”，Scenario 回答“何时适用”；二者合并会丢 transfer 或引入 topical noise | Wefc9ff30e069, Cc174b604fbab |
| CL005 | projection identity 必须由类型、主体/范围、排序后的 source revision、transform 和规范化内容确定 | Cd616c3f2f07a, C355361c39adf, C3545d567db35 |
| CL006 | 现有 ledger epoch、outbox 和 FTS rebuild 已给出可复用的投影模式 | C5c36739b0d94, C3545d567db35, W82e962a8f323 |
| CL007 | frontier 需要 schema、ledger、tombstone、projection epoch 和 transform version | C5c36739b0d94, C3545d567db35, C48a102dc6876, W82e962a8f323 |
| CL008 | canonical mutation 必须同步阻断 descendant；反向失效和清理可以异步 | C48a102dc6876, C900dd92d403e, W82e962a8f323 |
| CL009 | full rebuild 是 incremental projector 的 Oracle | C3545d567db35, W82e962a8f323 |
| CL010 | crash 可导致 named degradation，但不能让未重校验 descendant 进入 Context | C5c36739b0d94, C3545d567db35, C900dd92d403e |
| CL011 | 安全顺序是 hard filter → lanes → canonical revalidation → conflict/dedupe → score → budget → seal | C7f9b788de747, Ce117a6da657f, C900dd92d403e, W472a9d6c24aa |
| CL012 | recent/L1、topic、scenario/procedure、core、relation lanes 必须独立启停、观测和降级 | C900dd92d403e, W7ef376e6ce94, W472a9d6c24aa |
| CL013 | 冲突要保留 provenance-bearing set，不能静默合并成新事实 | C355361c39adf, Ce117a6da657f |
| CL014 | ranking 使用 relevance、authority、freshness、diversity、conflict cost、token utility，且不得覆盖 hard filter | Ce117a6da657f, W472a9d6c24aa, Wabddfee3f031 |
| CL015 | governing constraints、preconditions、failure boundaries、conflicts 先于重复摘要进入预算 | Ce117a6da657f, W485e500bd8f8 |
| CL016 | G3 使用 accepted-M2、M3-no-projection、M3-layered 三个 paired arms，再做 leave-one-lane-out attribution | Cc174b604fbab, Wefc9ff30e069, Wabddfee3f031 |
| CL017 | G3 覆盖 extraction、multi-session、temporal、updates、abstention、transfer、conflict 和 deletion safety | Cc174b604fbab, Wabddfee3f031, C48a102dc6876 |
| CL018 | evidence utility 与 task utility 是独立指标，不能用 compression ratio 或 recall count 代替 | Wabddfee3f031, W485e500bd8f8, Cc174b604fbab |
| CL019 | pollution 包含越界、过期、未授权、无效 lineage、无价值重复和实际伤害；安全类为零容忍 | W485e500bd8f8, C900dd92d403e, C48a102dc6876 |
| CL020 | G3 GO 要求同预算效用提升、零治理/预算回归、可重建且 holdout/transfer 不回归 | Cc174b604fbab, C62bf6d199856, Wabddfee3f031, W485e500bd8f8 |
| CL021 | Small profile 固定 10k evidence、1k L1、250 projections、1k relations，并报告延迟、重建和资源 | C62bf6d199856 |
| CL022 | optional lane 不能成为 startup、correction、revoke、delete 或 safe baseline 的依赖 | C900dd92d403e, C48a102dc6876, C62bf6d199856 |
| CL023 | M3 只拥有 SQLite adjacency 和确定性投影；graph/vector/autonomous extraction/learning/ops 继续后移 | C355361c39adf, C62bf6d199856, W82e962a8f323 |
| CL024 | 可实施总契约是 SQLite authority → lineage projections → degradable lanes → revalidation → bounded frozen Context → G3 | 多问题综合证据 |

机器可验证版本位于：

`research-workspace/research/m3-layered-context-compiler/indexes/claims.jsonl`

## Planning decisions

### D1. L2/L3 是 revisioned materialized views，不是新 authority

四类最小 artifact：

| Artifact | 语义 | 最小内容 | 明确不是 |
| --- | --- | --- | --- |
| `TopicProjectionRevision` | 一组受治理事实共同讨论什么 | label、summary、source revisions、scope、validity | 用户事实 authority |
| `ScenarioProjectionRevision` | 在什么触发条件下哪些约束/步骤适用 | trigger、preconditions、procedure、failure/recovery、sources | 无条件偏好或自动 action |
| `RelationProjectionRevision` | canonical revisions 之间的 typed adjacency | subject、predicate、object、temporal bounds、sources | 图数据库权威 edge |
| `CoreProjectionRevision` | 跨多来源稳定且对任务有治理价值的高密度约束 | constraint、applicability、exceptions、sources | 永久人格或模型自我判断 |

所有投影 revision 至少包含：

- stable projection id 和 immutable revision id；
- exact principal、workspace、project、topic scope；
- sorted source memory/evidence revision ids；
- transform id/version 和 projection epoch；
- derived authority/sensitivity/validity；
- content hash、lifecycle、created/invalidated time；
- 可由当前 source frontier 重建的 normalized payload。

### D2. Topic 与 Scenario/Procedure 分开

Topic 是 subject index；Scenario 是 applicability index。Procedure 是 Scenario
payload 的一种，不单独创建没有触发条件的“操作真理”。

反例：

- “TypeScript 项目”是 topic，不表示每个 TypeScript 项目都运行同一部署步骤；
- “生产 schema migration 前”是 scenario，适用的 preconditions、rollback 和
  verification 必须一起保留；
- 只有关键词相似而 scope/scenario 不同的记录必须在 ranking 前被拒绝。

### D3. 来源权威采用 fail-closed 派生

投影 authority 不由生成器声明。其有效上限由所有 live canonical ancestors
计算：

- authority 不高于来源中的最低可用边界；
- sensitivity 取最严格值；
- scope 只能取来源 scope 的安全交集；
- validity 不能晚于任一必要来源；
- 任一必要来源 superseded、revoked、usage-blocked、tombstoned 或 lineage
  不完整，投影立即 ineligible；
- 模型生成 summary 只能成为 candidate projection payload，不能绕过这些规则。

### D4. Projection frontier 是多维 receipt

每次 projector 和 compiler 都冻结：

```text
schema_version
ledger_epoch
tombstone_epoch
projection_epoch
transform_id
transform_version
compiler_version
```

`ledger_epoch` 表示 canonical snapshot；`tombstone_epoch` 防止旧备份/旧派生物
复活；`projection_epoch` 表示已物化到哪里；transform/compiler version 防止
不同算法产物混用。

projection lag 可以存在，但新 Context 不得把 lag 当成 freshness。候选返回后
必须在请求的 canonical frontier 上重新校验。

### D5. Incremental update 与 full rebuild 必须等价

Canonical transaction 写入 source state 和幂等 outbox job。Projector：

1. claim ordered work；
2. 解析受影响 source revision；
3. 通过 reverse lineage 将当前 descendants 失效；
4. 运行确定性 transform；
5. 在短事务中 append projection revisions/relations；
6. 更新 projection state/frontier；
7. 对 retry 返回相同 identity/hash。

Full rebuild 清空可重建 live materialization 后，从固定 frontier 的 eligible
L0/L1 stable order 重算。Oracle 比较：

- live projection ids/revision ids；
- normalized payload/content hashes；
- source-lineage rows；
- relation adjacency；
- eligible/ineligible state；
- compiler ordering。

任何不等价都是 G3 hard HOLD。

### D6. Descendant suppression 同步，cleanup 异步

Correction、demote、usage block、revoke、delete/tombstone 在 canonical commit
后立即改变 eligibility。即使 outbox 未 drain：

- lane query 返回的每个 projection 都重新解析 ancestors；
- stale/unresolved descendant 被排除并记录 reason；
- purge complete 前必须包含 projections store 的 verified outcome；
- issued Context slice 不变；下一次 compile 使用新 frontier；
- projector failure 返回 named `DEGRADED`，不返回假 `NO_MATCH`。

### D7. Multi-lane compiler 使用固定安全顺序

```text
request validation
→ principal/exact-scope/lifecycle/validity/sensitivity/tombstone hard filters
→ enabled lane retrieval
→ canonical lineage/frontier revalidation
→ conflict grouping
→ lineage-aware abstraction dedupe
→ deterministic score and tie-break
→ lane minimums plus global token packing
→ immutable ContextSlice and RetrievalReceipt
```

建议 lanes：

1. `recent_l1`：当前安全 baseline；
2. `topic`：高重复主题压缩；
3. `scenario_procedure`：条件、步骤、失败/恢复；
4. `core`：高权威、高复用约束；
5. `relation_sqlite`：一跳/有界多跳 adjacency。

每条 lane 都有 enabled flag、candidate count、eligible count、duration、
degradation reason 和 selected identities。

### D8. Conflict、dedupe 和 packing 先保护判断能力

Conflict group 保留 competing revisions、current state、authority、time 和
lineage。Compiler 可以选择一个用于主 Context，但 receipt 必须说明替代项
及未选择原因，不能生成一个来源不存在的合并事实。

去重规则：

- L2/L3 覆盖同一 sources 且没有额外条件/失败边界时，保留 token utility
  更高的一个；
- lower evidence 在用于 provenance drill-down 时可以不进入 model-visible
  payload，但必须保留 receipt pointer；
- precondition、exception、conflict、failure、recovery 和 policy boundary
  不能被“更短摘要”消除。

同分 tie-break 固定为：

```text
constraint priority
→ authority
→ evidence diversity
→ freshness
→ token utility
→ lane order
→ projection/revision id
```

### D9. G3 使用三臂 paired replay

对每个 frozen case 使用相同 input、seed、request frontier、token budget、
compiler policy 和 expected rubric：

| Arm | 内容 | 用途 |
| --- | --- | --- |
| A `accepted_m2` | G2 tested commit 的 L0/L1 flat compiler | 检测整个 M3 binary 相对已接受版本的回归 |
| B `m3_no_projection` | M3 binary，但全部 L2/L3 lanes disabled | 隔离 orchestration/compiler rewrite 的影响 |
| C `m3_layered` | M3 binary，启用已声明的 projections/lanes | 测量分层记忆净价值 |

另做 `C - one lane` leave-one-out，不作为第四个 adoption arm，只用于说明
topic/scenario/core/relation 各自贡献。禁止使用 holdout/transfer 调参。

### D10. G3 指标不把“更短”当成“更好”

每个 fixture 声明：

- required answer units；
- required governing evidence units；
- prohibited units/outcomes；
- exact included/excluded identities 或允许集合；
- budget 和 latency class；
- expected conflict/degradation explanations。

指标：

- `task_utility`：fixture outcome rubric 的通过比例；
- `evidence_utility`：在预算内保留的 required answer/governing units 比例；
- `context_pollution`：不相关、过期、越界、无 lineage、无增量价值重复以及
  对答案产生实际伤害的 included units；
- `governance_failures`：cross-scope、unauthorized、revoked、tombstoned、
  stale descendant、issued-slice mutation；
- `budget_overflow`：实际 estimator total 超过 request budget；
- `explanation_coverage`：designated include/exclude/conflict/degradation
  是否都可由 receipt 解释；
- `rebuild_equivalence`：incremental 与 full rebuild 的结构/hash diff；
- p50/p95、database/WAL bytes、projection rebuild duration、receipt bytes。

### D11. G3 GO/HOLD 冻结为可证伪条件

`GO` 同时要求：

- C 相对 A 和 B 在指定 layered cases 至少产生一个严格 task/evidence-utility
  改善；
- C 的全体 case task utility 和 evidence utility 均不低于 A/B；
- calibration、holdout、transfer 分区各自无超出 frozen tolerance 的回归；
- governance failures、cross-scope leakage、stale/tombstone resurrection、
  budget overflow 均为 0；
- pollution safety 类为 0，非安全 redundancy 不高于 B；
- every designated explanation 有 hash-valid receipt；
- incremental/full rebuild 完全等价；
- lane disabled/failure 等价于 B 的安全行为并返回 named degradation；
- Context compile 在 Expected profile warm-up 后满足已冻结的 p50 <= 100 ms、
  p95 <= 400 ms；Small profile 同时用于完整 projection/rebuild/resource 报告。

没有严格效用提升、任何安全回归、不可重建或超 SLO 都是 `HOLD`。HOLD
关闭失败 lane 或整个 layered compiler，保留 accepted M2 behavior，并不阻塞
记录实验结果。

### D12. 性能和运行边界

Small profile 固定：

- 10,000 evidence events；
- 1,000 active L1；
- 250 L2/L3 projections；
- 1,000 relations；
- 1,800 default、4,096 interactive、32,000 hard-max token budgets。

Expected profile用于正式 compiler latency：

- 250,000 evidence events；
- 25,000 active L1；
- 6,000 projections；
- 50,000 relations；
- one serialized writer、最多 four concurrent readers。

报告必须包含 Node、OS、arch、SQLite/SDK、lock hash、warm-up、sample count、
p50/p95、disk、memory、WAL、rebuild 和 degraded fallback。

### D13. M3 债务边界

M3 明确不解决：

- M4A graph backend 或 graph operational adoption；
- M4B embedding/vector semantic-gap retrieval；
- 模型自动从 episode 抽取 L1 或自动生成可发布 projection 的质量证明；
- M5 candidate/learning/canary/release/rollback；
- M6 durable multi-process frontier、remote transport、production backup
  distribution 和 full operational hardening。

SQLite adjacency 必须足以完成 G3。M4A/M4B 都可以独立 No-Go。

## Implementation implications

`ce-plan` 应保持以下可独立测试和提交的 units：

1. projection/context contracts 与 failing contract tests；
2. SQLite projection、lineage、relation 和 state migrations/repositories；
3. deterministic consolidation、invalidation、outbox 和 rebuild Oracle；
4. hard filters、lane interfaces 和 canonical revalidation；
5. conflict grouping、dedupe、ranking、token packer；
6. immutable slice/receipt 与 MCP schema extension；
7. three-arm replay、pollution/governance/rebuild fixtures；
8. Small/Expected benchmarks 和 G3 decision。

每个 unit 完成后运行其 scoped tests 并单独 commit；最终再运行完整 gate。

## Sources

### Code evidence

代码证据全部固定到
`135f3227e72c56c5fc8a256e4064ca0635cbed24`，保存在
`research-workspace/research/m3-layered-context-compiler/evidence/code/`。

### External primary evidence

- W7ef376e6ce94 — MemGPT project/paper page。
- Wefc9ff30e069 — Generative Agents paper。
- W82e962a8f323 — DBSP peer-reviewed paper。
- W472a9d6c24aa — Mem0 paper。
- Wabddfee3f031 — LongMemEval paper。
- W485e500bd8f8 — Lost in the Middle, TACL。

完整 cleaned Markdown、metadata、source assessment 和 content hashes 位于
`research-workspace/research/m3-layered-context-compiler/evidence/web/`。

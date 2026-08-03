# Codex MCP Agent Memory Runtime — PRD

## Goal

为单个本地开发者规划一个通过 MCP 接入 Codex 的 Agent Memory Runtime：它保存可追溯证据，把对话逐步组织为 Topic、Scenario 和 Core 等分层记忆，在有限 Context 中进行受治理召回，并通过候选、评测、发布和回滚实现可验证自学习。

本 PRD 在 2026-07-28 规划阶段只交付研究和实施计划。后续产品代码由
10 个独立 Trellis child 按授权、Gate 和 commit 边界实施；本父任务本身
始终作为 roadmap/authority 容器，没有被启动成一个巨型编码任务。

## Execution Closure

父 roadmap 于 2026-08-02 完成。10/10 child 均已完成并归档，终态如下：

| Gate | Terminal result | Active boundary |
| --- | --- | --- |
| G0 | `GO` | 合同、回放集和技术基线冻结 |
| G1A / G1 | `GO` | SQLite 权威账本与显式 stdio MCP 闭环 |
| G2 | `GO` | 版本化 L1 治理、用户控制和 tombstone/purge |
| G3 | `HOLD`，由 G3R 取代 | 历史证据保留 |
| G3R | `GO` | 有界、scope-keyed layered Context |
| G4A | `NO-GO` | 图关闭，SQLite relations 保留 |
| G4B | `NO-GO` | 向量关闭，FTS5/layered recall 保留 |
| G5 | exact local synthetic `GO` | 治理式发布/回滚机制通过；自动发布仍关闭 |
| G6 | `NO-GO` | 首个 non-pass 为 `integrity`；secret admission 关闭 |

这表示 roadmap 已按约定产生完整实现、证据、决策和 fallback，不表示
production、fleet、HA、多平台、真实流量或 SLO readiness。SQLite 仍是唯一
权威；graph/vector、自动学习发布和 secret admission 均保持 disabled。

## Authority

1. Product Contract：`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md`
2. Research handoff：`research/research-handoff.md`
3. Technical design：`design.md`
4. Execution roadmap：`implement.md`
5. Unified plan：`docs/plans/2026-07-28-001-feat-agent-memory-runtime-plan.md`

本 PRD 只投影 Product Contract，不新增或重编号产品需求。

## Actors

- **A1 用户 / 记忆所有者：**内容、纠正、删除、敏感性和学习策略的最终权威。
- **A2 Codex Agent：**通过 MCP 请求 Context，完成任务并提交结果或候选。
- **A3 Memory Runtime：**维护本地证据、版本、派生投影、召回和 receipts。
- **A4 评测者：**使用规则、冻结回放、独立 Judge 或用户反馈判断候选是否有效。

## Product Requirements

### 本地边界

- **R1** — 通过 MCP 提供记忆能力并解耦 Codex 与持久化、召回和学习生命周期。
- **R2** — 主要内容保存在本地；本地持久化与模型 Context 数据边界必须明确。
- **R3** — 第一目标为单用户、单机；用户是记忆和学习策略的最终权威。

### 分层与权威

- **R4** — 支持对话/工作、主题、场景和高层抽象记忆。
- **R5** — 短期/长期表现为可观察生命周期。
- **R6** — 原始证据、确认事实、派生摘要/关系、本轮 Context 和学习候选保持不同权威。
- **R7** — 长期记忆包含来源、时间、范围、有效性、冲突、保留原因和推断属性。
- **R8** — 抽象可追溯到底层证据；图关系不得自动获得更高权威。
- **R9** — 向量只可作为召回信号，不是必要依赖或事实判定器。

### 召回与 Context

- **R10** — 按任务、用户、场景、时间和预算召回。
- **R11** — 召回结果说明来源、层级、状态、原因和不确定性。
- **R12** — 排除或解释重复、过时、冲突、替代、删除和低权威候选。
- **R13** — 区分无命中、策略排除和运行故障。

### 纠正与遗忘

- **R14** — 用户可检查、纠正、替代、删除、固定、降级或禁止记忆；动作传播到派生物。
- **R15** — 修订不能无痕覆盖；审计不得继续泄露被删除或无权使用的正文。

### 自我学习

- **R16** — 学习从结果、反馈、错误、知识缺口或离线评测形成候选，不等于模型训练。
- **R17** — 候选经过提出、证据、基线评测、发布/拒绝、监测和回滚。
- **R18** — 高影响、低置信、敏感和长期偏好候选需要用户确认；学习可整体关闭。
- **R19** — 召回、Context、记忆变更和学习发布可回放。
- **R20** — 离线回归门禁覆盖连续性、召回、污染、冲突、删除不复活、学习收益和回滚。

## Key Flows

- **F1 捕获并形成候选：**证据保存后，候选按类型、范围、来源、敏感性、冲突和准入规则进入会话、长期、隔离或拒绝状态。
- **F2 跨会话召回：**治理过滤后，从 recent/topic/scenario/core/structural 等 lane 生成候选，编译受预算约束的冻结 Context。
- **F3 纠正、遗忘与传播：**撤销旧权威，产生新 revision 或 tombstone，传播到摘要、关系、索引、Context、导出和备份边界。
- **F4 学习与晋升：**从结果提出最小可逆候选，运行基线、holdout、transfer 和 canary，发布或回滚。

## Acceptance Examples

- **AE1** — 稳定偏好跨会话召回，返回来源、范围和召回原因。
- **AE2** — 冲突项目状态优先返回当前有效版本，并说明替代关系。
- **AE3** — 没有向量数据库仍能按场景、时间和权威受控召回。
- **AE4** — 底层事实被纠正或删除后，摘要和高层图关系不能复活旧事实。
- **AE5** — 无命中、策略拒绝和运行故障返回不同、可操作的状态。
- **AE6** — 单场景获益但跨场景回归的学习候选不得发布。
- **AE7** — 关闭学习不影响普通记忆读取和明确授权写入。
- **AE8** — 用户可删除本地敏感内容并禁止其进入未来模型 Context。

## Success Criteria

- 跨会话连续性不依赖完整历史回放。
- 每个长期记忆和高层投影都有 live evidence lineage。
- 过时、替代、撤销和删除内容不会通过任何派生物复活。
- 分层 Context 相对 transcript/FTS baseline 产生可重复收益，且污染率不恶化。
- 每次学习发布都有独立评测、用户/策略授权、canary 和 rollback receipt。
- 用户能关闭自动捕获、某类记忆使用或学习，而不破坏核心读取。

## Scope

### In scope

- 本地 `stdio` MCP 和显式 task-start/task-end 协议。
- SQLite + FTS5 + content-addressed blobs。
- L0/L1 权威记录与 L2/L3 Topic/Scenario/Relation/Core 投影。
- SQLite relation baseline，以及通过 Gate 后的可选图/向量 lane。
- Context Compiler、receipts、纠正、撤销、purge、恢复和候选式学习。

### Deferred

- 自动 Codex Host Adapter。
- 多设备同步、远程备份、跨主机合并。
- 参数训练、强化学习、主动陪伴和无人审批高影响发布。

### Outside

- 企业共享知识库和组织级知识图谱。
- 全历史聊天归档、通用 RAG 或向量数据库平台。
- 云托管个人记忆 SaaS。
- 不可解释、不可纠正的自治人格。

## Planning Acceptance

- [x] `ce-brainstorm` Product Contract 已确认。
- [x] `research-to-article` 已闭合 RQ032–RQ041，`validate-ready` 通过。
- [x] `ce-plan` HOW 已获得用户确认。
- [x] `design.md` 与 R1–R20、F1–F4、AE1–AE8 一致。
- [x] `implement.md` 提供 U1–U9、G0–G6、详细 checklist、fallback 和 stop conditions。
- [x] Unified plan 具有完整需求追踪与未来子任务拆分。
- [x] 图和向量是独立、可拒绝的 adoption decision。
- [x] 学习发布默认关闭，候选失败不阻塞核心记忆运行时。
- [x] Markdown、Mermaid、范围、依赖和跨文档一致性验收通过。
- [x] 规划阶段父 Trellis task 保持 `planning`，未作为巨型实现任务运行；
      实施只通过独立 milestone children 进行。

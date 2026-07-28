# Current Research Topic: M3 Layered Projections and Context Compiler

本目录是独立课题 `m3-layered-context-compiler`。当用户说“当前课题”时，只使用本目录的研究状态与证据。

Codex 内使用 `$topic` 显示课题提示，或使用 `$topic <问题>` 继续研究；`$topic html <问题>` 才生成 Kami HTML。

开始回答前依次读取：

1. `../../.agents/skills/research-to-article/SKILL.md`
2. `project.json`
3. `questions/README.md` 与相关 `RQ...` 文件
4. `project.json` 指向的 active session/run（若存在）
5. `indexes/claims.jsonl` 和与当前问题关联的证据

不要读取其他课题目录来补齐证据；确需跨课题引用时，先说明来源与理由。
若用户显式引用 `research/<topic>/answers/RQ...md`，该路径是本轮 answer anchor，应进入被引用课题，不属于跨课题补证。
只有用户明确说‘追问’或使用 `$topic follow` 时才记录 `turn_type=follow_up`；展开、扩充、修改、重写等答案调整使用 `add-turn --revision`，记录 `turn_type=revision` 并保留旧版历史。
继续提问时复用已有 session、Claim 和 evidence ID，不重复研究已经确认的内容。

## 快速答案

- 问题搜索结束后先在 Codex 返回简明答案，不等待正式文章门禁。
- 写答案前完整读取 `../../.agents/skills/research-to-article/references/reader-answer-contract.md`。
- 默认读者是专业 Research Agent 技术人员；第一段直接回答问题，后文沿一条主线解释机制、取舍和边界。
- 使用能闭合问题的最短篇幅，不固定发现数或追问数；正文不能退化成来源、Claim 或证据 ID 的罗列。
- 每次回答写入 session；`add-turn` 同步更新 `answers/RQ...-可读问题.md`，当前页用“回答演化”链接旧问题与完整答案，旧版本归档到 `answers/history/<RQ>/`。
- 仅当用户明确要求 HTML/Kami 时，使用中文 `one-pager.html` 生成仅 HTML 的理解页到 `answers/`。

## Learning Runtime

- Answer Runtime 为 `partial` 或用户明确不满意时，读取 `../../.agents/skills/research-to-article/references/learning-runtime-contract.md`。
- 中间 AnswerAttempt 只写 `learning-runtime/` sidecar，不进入 `answers/` 或 turn 历史。
- Critic blocker 必须编译为 KnowledgeGap 与带反证查询的 LearningPlan；新 ResearchRun 使用 `--learning-cycle` 绑定。
- 只有 EvidenceDelta 有效且 Learning Evaluation、Answer Runtime 均 closed 时才发布重写；否则进入 loop_capped、waiting_user、conflicted 或 unanswerable 终态。

## 独立对抗评审

- 对抗评审默认关闭。只有当前用户消息把“深度调研”作为明确动作，且没有否定该动作时才启用；不能从历史消息、课题名或目录名继承。
- provider 只读取工作区 `research.config.json.adversarial_review.provider`。默认 `gpt` 使用独立 GPT-5.6 Sol + xhigh reviewer；改成 `grok` 时复用保留的 Grok CLI 适配器。
- GPT 路径先用 `run-adversarial-review --review-packet ...` 冻结输入，再启动 fresh `gpt-5.6-sol` / `xhigh` reviewer 使用 AnySearch，最后以 `--review-file ...` 记录；不得由 Writer 在同一上下文伪造独立评审。
- search_trace、source_urls 和批评不是正式 Evidence。外层 ResearchRun 重新登记和归档搜索线索，更新 Claim/EvidenceDelta 后重写，再由当前配置的 reviewer 复攻。
- provider、模型或 AnySearch 不可用时记录 provider_blocked/failed 并明确告诉用户；不得静默切换 provider 或把当前 Writer 自评冒充独立审核。

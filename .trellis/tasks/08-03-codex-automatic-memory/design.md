# 技术设计

## 权威边界

- SQLite 继续保存原始证据、捕获编排、候选、有效记忆、不可变修订和审计收据。
- Codex hook、远端模型、Workbench 和 MCP 都不是独立写入权威。
- 远端模型只返回结构化提炼提案；本地策略校验后仍须调用现有 memoryPropose。
- Graph、FTS、关系、向量和每轮上下文保持派生状态。

## 事件与数据流

1. codex-bootstrap 在用户现有的 hooks.json 或 config.toml 表示中安全合并 SessionStart、UserPromptSubmit、Stop、SessionEnd。
2. hook 命令先校验事件、执行秘密/敏感信息筛查，再调用独立凭证保护的 loopback ingress。
3. host 不可用时，hook 只把已经筛查的有界事件写入私有 XDG spool；恢复后按事件身份幂等导入。
4. UserPromptSubmit 同步提交用户事件并编译现有有效记忆；同步路径不调用远端模型。
5. Stop 保存版本化回答快照。形成任务等待静默期或下一次用户输入，较新的 Stop generation 取代中间回答。
6. managed BackgroundSupervisor 领取形成任务，将最小脱敏对话窗口发给结构化输出 provider。
7. 本地验证模型输出、查询已有有效记忆做重复/冲突判断、计算策略特征，再进入现有治理准入。
8. Workbench 从规范仓读取最近捕获、形成、准入、召回和撤销记录；Undo 使用受治理 demotion，不删除历史。

## 作用域

- 全局偏好使用本地用户作用域。
- Git 项目身份以本地 common Git directory 为主，使同一本地仓库的 worktree 共享；不同 clone 默认隔离。
- 非 Git 目录使用规范化真实根路径。
- 只有 managed host 的项目身份解析器可以注册动态仓库作用域，普通 MCP 输入不能注册。

## 隐私与安全

- 持久化前拒绝或脱敏明显秘密，元数据只保留规则和位置，不保留原始字节。
- provider egress 额外移除配置的敏感标识、绝对本地路径及不相关历史。
- 不向 provider 发送已有记忆；冲突比较在本地完成。
- hook、浏览器和 MCP 使用不同凭证，互相不可替代。
- hook/provider 故障对 Codex fail-open；治理/变更对记忆 fail-closed。

## 兼容、迁移与回滚

- migration 0020 只建立新表和约束，不扫描或晋升历史 L0。
- explicit MCP 继续可用，自动上下文使用 receipt marker 防止同轮重复呈现。
- installer 语义合并用户现有 hook 表示，备份后才写入；升级失败恢复原表示和注册。
- disabled/observe/balanced 三种模式支持先观察、后准入、最终 fresh-install 默认 balanced。

## 决策来源

- docs/plans/2026-08-03-001-feat-codex-automatic-memory-plan.md
- docs/plans/2026-07-28-001-feat-agent-memory-runtime-plan.md
- docs/plans/2026-08-02-001-feat-memory-workbench-plan.md
- https://developers.openai.com/codex/hooks

# 执行计划

## 基线

- [x] 记录当前 dirty worktree 与已知冻结失败，只修改当前单元拥有的文件，不回退旧任务改动。
- [x] 固定使用仓库 Node 24.18.0 / pnpm 10.33.2，并先运行重叠区域的窄基线测试。

## U1 契约与策略

- [x] 冻结 hook event、capture、redaction、formation proposal、provider、policy 与 audit schema。
- [x] 新建 memory-formation 包的纯策略/provider port；模型输出不能直接成为 MemoryCandidate。
- [x] 补齐四类允许记忆和所有排除类型的 contract/replay 测试。

## U2 捕获持久化与作用域

- [x] 新增 0020 forward-only migration、project identity、event generation、turn stabilization、formation job/attempt/decision/recall 表。
- [x] 扩展 storage worker/protocol/client，保留单 writer、幂等、lease、retry/quarantine 和 receipt。
- [x] 证明 migration 不回填历史 L0，崩溃恢复不重复。

## U3 Codex hook 桥接

- [x] 在 bootstrap 发布物中加入 hook config/command/spool，并兼容 hooks.json 与 config.toml。
- [x] 增加独立 hook credential/descriptor 与严格 loopback ingress。
- [x] 覆盖 trust、升级、卸载、并发 Stop、host down/spool recovery 与凭证隔离。

## U4 模型提炼与准入

- [x] 实现持久化筛查和更严格 provider-egress 筛查。
- [x] 实现结构化 provider adapter、最小 turn window、provider/prompt/schema/policy 版本记录。
- [x] 本地校验证据/权限/类别/冲突后调用现有 memoryPropose。
- [x] 覆盖 provider 故障、注入、秘密残留、四类记忆、冲突和幂等。

## U5 自动召回

- [x] UserPromptSubmit 使用 global + exact project scope 编译有效记忆。
- [x] 应用 hard filters、specificity ordering、item/token/byte budget 和 automatic receipt marker。
- [x] 覆盖跨仓隔离、生命周期过滤、显式 MCP 去重、污染回放和 200 ms p95。

## U6 Workbench

- [x] 扩展 contracts/reader/service/http/web，显示最近捕获、形成、准入、召回、重试和隔离状态。
- [x] 复用 impact/approval/correction 模式处理 review-required 变化。
- [x] Undo 使用幂等 demotion，并覆盖浏览器、并发、会话失效和可访问性测试。

## U7 资格验证

- [x] 固定中英回放语料和 deterministic fake provider。
- [x] 分别报告提炼、治理、召回、隐私、可靠性、性能，不允许总分掩盖安全失败。
- [x] 扫描 SQLite/WAL/backup/spool/log/receipt/provider request 的秘密残留。
- [ ] 物理验证 Codex Desktop startup/resume/compact/archive/multi-window/trust。（BLOCKED：当前自动化环境不能替代固定 Desktop 构建的人工矩阵，因此发布判定为 NO-GO。）
- [x] 写 GO/NO-GO 评估，记录基线失败和版本哈希。

## U8 发布与运维

- [x] 文档说明本地捕获、两层脱敏、远端数据边界、成本、provider policy、审计、Undo、禁用和回滚。
- [x] U7 为 NO-GO，fresh install 保持 `observe`；upgrade 保留旧行为。
- [x] 验证 packaged install、hook merge、provider missing、rollback 与 explicit MCP。

## 收尾

- [x] 运行相关 contract/storage/governance/integration/recovery/security/replay/browser 测试。
- [x] 执行代码审查、简化与项目规范检查。
- [ ] 只有完成所有阻塞验证后将 plan status 改为 completed。（保持 active，等待物理 Desktop 与 live provider 资格验证。）

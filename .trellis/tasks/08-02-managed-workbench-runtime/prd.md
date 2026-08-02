# 切换 Codex MCP 与 Workbench 共用 Runtime

## Goal

让 Memory Workbench 控制面板与 Codex 中的 `memo_graph_memory` MCP 同时可用，并且共享同一个受治理的 memo-graph Runtime。Workbench 托管进程是唯一 SQLite 写入者；Codex MCP 仅作为 stdio 到私有 IPC 的代理，不再直接打开数据库。

## Requirements

- 保留现有数据根目录 `/Users/lienli/.local/share/memo-graph`、主体 `user_local`、workspace scope、authority 白名单、token budget、lane policy 和外部 recovery authority，不迁移或重建记忆数据。
- 新增位于仓库外的私有 operator 配置 `/Users/lienli/.config/memo-graph/operator.json`，其派生出的 `MemoryServerConfig` 必须与 `/Users/lienli/.config/memo-graph/mcp.json` 完全同一身份。
- Workbench 使用只读产品能力：`destructive_tools_enabled` 保持 `false`。Memory、Graph 和 Runtime 页面可以浏览与观测，但不开放治理更正等破坏性工具。
- Workbench managed Runtime 必须是该数据根目录唯一的 SQLite writer；切换期间先精确识别并正常终止当前 direct MCP writer，再启动 Workbench，不删除锁、socket、descriptor 或数据库文件。
- 使用仓库固定的 Node.js `24.18.0` 和已构建的 `apps/operator-cli/dist/cli.js workbench` 启动控制面板，并打开本机浏览器中的认证页面。
- Codex 全局 MCP 配置保留原 command、MCP config path，并追加 Workbench 实际发布的 `--managed-descriptor <absolute-path>` 参数。
- 配置切换后明确提示：已经运行的 Codex 任务不会热重载 MCP 定义，需要新建任务或重启 Codex 后才能使用 managed proxy；Workbench 自身可继续运行。
- 所有新增配置、runtime directory、descriptor 和 credential 都应保持仅当前用户可访问的权限。
- 失败时应 fail closed；不得为了恢复服务而并行启动 direct writer。

## Acceptance Criteria

- [ ] `/Users/lienli/.config/memo-graph/operator.json` 可被 operator schema 解析，文件权限为 `0600`，且其派生的 Runtime 配置身份与现有 MCP 配置相同。
- [ ] Workbench 启动结果为 `ready`，loopback HTTP 页面可打开，Memory、Graph、Runtime 三个入口可加载；页面中不出现可执行破坏性更正的能力。
- [ ] Workbench endpoint 指向一个存在且权限受限的 managed Runtime descriptor，IPC 健康检查成功。
- [ ] 同一数据根目录只有 Workbench managed Runtime 持有 SQLite writer lease；Codex MCP 进程命令行包含 `--managed-descriptor`，且没有 direct-mode MCP writer 残留。
- [ ] 使用一个新的 MCP 客户端会话经 managed proxy 成功完成 `listTools` 和只读 `memory_search`，能够检索切换前已有的验证记忆。
- [ ] 新建或重启 Codex 任务后，`memo_graph_memory` 工具可用，并且 Workbench 页面在 MCP 使用期间保持可访问、Runtime 状态正常。
- [ ] 验证失败时能够按记录的回滚步骤停止已确认的 Workbench owner、移除 Codex 的 managed descriptor 参数并恢复 direct MCP；不删除任何记忆数据或 writer lock。

## Out of Scope

- 不修改 memo-graph 产品源码、数据库 schema、记忆内容或治理策略。
- 不开放 Workbench 的 governed correction/destructive tools。
- 不把 Workbench 暴露到局域网或公网，也不新增常驻系统服务、LaunchAgent 或自动开机启动。
- 不把 descriptor 路径写死为猜测值；必须采用本次 Workbench 启动实际发布的路径。

## Constraints and Risks

- 当前 Codex 任务中可能同时存在多个 direct MCP 子进程；执行时必须按父进程、完整命令和数据根身份逐个确认，不能按模糊进程名批量终止。
- managed proxy 对 canonical root identity 和完整 config identity 都会校验；operator 与 MCP 配置的任何默认值或字段漂移都会使连接阻断。
- 关闭浏览器标签页不会停止 managed host；回滚只能向 endpoint 记录并重新验证过的 owner PID 发送 `SIGTERM`。
- Workbench v1 没有公开的 `stop` 子命令，严禁通过手工删除临时运行产物来模拟停止。

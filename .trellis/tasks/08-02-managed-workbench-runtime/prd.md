# 切换 Codex MCP 与 Workbench 共用 Runtime

## Goal

让 Memory Workbench 控制面板与 Codex 中的 `memo_graph_memory` MCP 同时可用，并且共享同一个受治理的 memo-graph Runtime。Workbench 托管进程是唯一 SQLite 写入者；Codex MCP 仅作为 stdio 到私有 IPC 的代理，不再直接打开数据库。重启 Codex 后，第一次启动该 MCP 时自动启动或复用 Workbench、打开一次前端页面并连接 MCP，无需用户手工排序启动步骤。

## Requirements

- 保留现有数据根目录 `/Users/lienli/.local/share/memo-graph`、主体 `user_local`、workspace scope、authority 白名单、token budget、lane policy 和外部 recovery authority，不迁移或重建记忆数据。
- 新增位于仓库外的私有 operator 配置 `/Users/lienli/.config/memo-graph/operator.json`，其派生出的 `MemoryServerConfig` 必须与 `/Users/lienli/.config/memo-graph/mcp.json` 完全同一身份。
- Workbench 使用只读产品能力：`destructive_tools_enabled` 保持 `false`。Memory、Graph 和 Runtime 页面可以浏览与观测，但不开放治理更正等破坏性工具。
- Workbench managed Runtime 必须是该数据根目录唯一的 SQLite writer；切换期间先精确识别并正常终止当前 direct MCP writer，再启动 Workbench，不删除锁、socket、descriptor 或数据库文件。
- 使用仓库固定的 Node.js `24.18.0` 和已构建的 `apps/operator-cli/dist/cli.js workbench` 启动控制面板，并打开本机浏览器中的认证页面。
- Codex 全局 MCP 配置使用固定 Node.js 执行私有 bootstrap entry；MCP config path 由 bootstrap 固定读取，managed descriptor 则在每次启动时按实际 Runtime identity 动态取得。
- 增加仅供本机 Codex 使用的 bootstrap entry。Codex MCP command 调用 bootstrap；bootstrap 负责启动/复用 Workbench、取得匹配的 managed descriptor，随后在同一 stdio 生命周期中进入 MCP proxy。
- 每个 Codex app-server 生命周期最多自动打开一个已认证的 Workbench 浏览器标签页。多个任务并发启动 MCP 时仍只能产生一个 Runtime owner，且不能重复打开多个标签页。
- 若数据根残留 writer lease，bootstrap 仅在 exact root/lease/fence/heartbeat 全部匹配、lease 已过期且 owner PID 已确认不存在时，调用仓库的 `recoverStaleRootLease`；任何歧义均 fail closed。
- bootstrap 不写死动态端口或 descriptor stem；它通过 canonical root/config identity 和 Workbench launcher 取得本次真实 descriptor。
- 配置切换后明确提示：已经运行的 Codex 任务不会热重载 MCP command，需要新建任务或重启 Codex 后才能采用 bootstrap；Workbench 自身可继续运行。
- 所有新增配置、runtime directory、descriptor 和 credential 都应保持仅当前用户可访问的权限。
- 失败时应 fail closed；不得为了恢复服务而并行启动 direct writer。

## Acceptance Criteria

- [ ] `/Users/lienli/.config/memo-graph/operator.json` 可被 operator schema 解析，文件权限为 `0600`，且其派生的 Runtime 配置身份与现有 MCP 配置相同。
- [ ] Workbench 启动结果为 `ready`，loopback HTTP 页面可打开，Memory、Graph、Runtime 三个入口可加载；页面中不出现可执行破坏性更正的能力。
- [ ] Workbench endpoint 指向一个存在且权限受限的 managed Runtime descriptor，IPC 健康检查成功。
- [ ] 同一数据根目录只有 Workbench managed Runtime 持有 SQLite writer lease；Codex bootstrap 最终进入 managed proxy，且没有 direct-mode MCP writer 残留。
- [ ] 使用一个新的 MCP 客户端会话经 managed proxy 成功完成 `listTools` 和只读 `memory_search`，能够检索切换前已有的验证记忆。
- [ ] 新建或重启 Codex 任务后，`memo_graph_memory` 工具可用，并且 Workbench 页面在 MCP 使用期间保持可访问、Runtime 状态正常。
- [ ] 完整退出并重新启动 Codex 后，无需手工运行 operator 命令：首次 `memo_graph_memory` 启动会自动启动/复用 Workbench、打开一个前端标签页并进入 `MCP_MANAGED_READY`。
- [ ] 同一 Codex app-server 下并发启动两个以上 MCP client 时，Workbench 仍只有一个 owner，且自动打开的前端标签页不超过一个。
- [ ] 模拟过期且 owner 已死亡的精确 writer lease 时可受控恢复；owner 存活、未过期或任一证明字段漂移时拒绝接管。
- [ ] 验证失败时能够按记录的回滚步骤停止已确认的 Workbench owner、把 Codex MCP command 恢复为原 direct entry 并验证记忆连续性；不删除任何记忆数据或 writer lock。

## Out of Scope

- 不修改 memo-graph 产品源码、数据库 schema、记忆内容或治理策略。
- 不开放 Workbench 的 governed correction/destructive tools。
- 不把 Workbench 暴露到局域网或公网，也不新增常驻系统服务、LaunchAgent 或自动开机启动。
- 不把 descriptor 路径写死为猜测值；必须采用本次 Workbench 启动实际发布的路径。
- 不修改 `packages/mcp-server` 的既有产品契约；managed proxy 本身仍不直接启动 Runtime，自动编排由本机 Codex bootstrap entry 完成。

## Constraints and Risks

- 当前 Codex 任务中可能同时存在多个 direct MCP 子进程；执行时必须按父进程、完整命令和数据根身份逐个确认，不能按模糊进程名批量终止。
- managed proxy 对 canonical root identity 和完整 config identity 都会校验；operator 与 MCP 配置的任何默认值或字段漂移都会使连接阻断。
- 关闭浏览器标签页不会停止 managed host；回滚只能向 endpoint 记录并重新验证过的 owner PID 发送 `SIGTERM`。
- Workbench v1 没有公开的 `stop` 子命令，严禁通过手工删除临时运行产物来模拟停止。
- bootstrap 依赖当前仓库的已构建 dist entry 和固定绝对路径；仓库移动或清理构建产物后应 fail closed，并给出 content-free 诊断。

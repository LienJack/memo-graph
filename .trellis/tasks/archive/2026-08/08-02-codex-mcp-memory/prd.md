# 启动 memo-graph MCP 并配置 Codex

## Goal

在本机为 Codex 启用 `memo-graph` stdio MCP，使新启动的 Codex 进程能发现并调用受治理的记忆检索与提交工具，且记忆在 MCP 进程重启后仍由本地 SQLite 持久保存。

## Background

- 仓库已实现 `packages/mcp-server/dist/cli.js`，传输方式是 stdio；它不是需要独立守护的 HTTP 服务，而是由 Codex 按 MCP 配置启动。
- Codex 的全局配置文件为 `/Users/lienli/.codex/config.toml`，当前尚未配置 `memo_graph_memory`。
- 仓库要求 Node.js 24.18.0 和 pnpm 10.33.2；当前 shell 默认 Node.js 26.3.0，因此 MCP 配置必须使用绝对路径指向 Node.js 24，不依赖 shell `PATH`。
- MCP 不能自动观察 Codex 对话。Codex 必须显式调用 `memory_context_compile`、`memory_search` 和 `memory_episode_commit` 等工具。

## Requirements

- 使用仓库锁定的 Node.js 24 运行时和已构建的 MCP CLI；必要时先执行冻结依赖安装及 `build:runtime`。
- 在非仓库、非云同步的用户私有目录中创建 MCP JSON 配置和 SQLite 数据根目录。
- 采用仓库默认身份边界：`principal_id=user_local`、`workspace:workspace_local`、authority 仅允许 `user_stated` 与 `tool_result`。
- 保持 `destructive_tools_enabled=false`，不启用删除、自动发布或其他破坏性能力。
- 增量添加 Codex 全局 MCP 项 `memo_graph_memory`，不覆盖已有 MCP 和其他 Codex 设置。
- 用新 MCP 客户端进程验证服务健康、工具发现、一条合成记忆的幂等提交，以及重启后可检索。
- 明确记录：当前 Codex Desktop 任务需重启/重新打开任务才能加载新 MCP；仅写入配置不会把未发送的旧对话自动导入记忆。

## Out of Scope

- 不修改 MCP 产品代码、数据模型或治理规则。
- 不把现有 Codex `memories_1.sqlite` 或 `/Users/lienli/.codex/memories/` 自动迁移到 memo-graph。
- 不启用 Graph/Vector NO-GO 能力，不将本地实验运行时宣称为生产就绪。
- 不开启破坏性工具或自动学习发布。

## Acceptance Criteria

- [x] Node.js 24 绝对路径、MCP CLI 和私有 JSON 配置均存在，配置文件权限不向其他用户开放。
- [x] `codex mcp list/get` 显示启用的 `memo_graph_memory`，命令参数均为绝对路径。
- [x] 官方 MCP 客户端能启动实际 stdio 子进程，读取 runtime health/contracts/usage，并列出记忆工具。
- [x] 以唯一合成标识提交一条 L0 episode，相同幂等键重试不产生第二份记忆。
- [x] 关闭并重新启动 MCP 进程后，`memory_context_compile` 或 `memory_search` 能在同一 principal/scope 下找回该记忆。
- [x] 验证后数据根中存在 SQLite 权威账本，且破坏性能力仍关闭。
- [x] 交付时说明 Codex Desktop 的重载要求和显式记忆调用边界。

## Key Decisions

- 这是运行配置任务，不是新功能开发；使用轻量 PRD-only 路径。
- 使用仓库文档和测试已固定的 `user_local` / `workspace_local` 作为首次本地部署边界，避免新造身份语义。
- Codex 按需拉起 stdio MCP；“启动服务”的可观测结果是实际 MCP 子进程成功完成握手与调用，而非留下一个独立守护进程。

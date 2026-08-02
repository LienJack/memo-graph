# 执行计划

## 1. 预检与配置

- [ ] 确认工作树现状，保留用户无关改动，不改产品源码。
- [ ] 使用固定 Node.js 24.18.0 确认必要构建产物存在；仅在缺失或过期时运行仓库规定的 runtime build。
- [x] 根据现有 MCP 配置生成 `/Users/lienli/.config/memo-graph/operator.json`，原子写入并设置 `0600`。
- [x] 使用仓库 schema 分别解析 MCP 配置与 operator 派生配置，断言 canonical root identity、config identity 完全一致且 destructive tools 为 false。

## 2. 切换唯一写入者

- [x] 枚举当前 direct MCP 进程，核对 PID、PPID、完整 argv、数据根和 writer lease owner。
- [x] 仅向已确认的 direct MCP writer 发送 `SIGTERM`，轮询确认正常退出和 lease 释放。
- [x] 对重启前 PID `99728` 的过期 lease 使用 exact proof 执行受控恢复。
- [x] 启动 `apps/operator-cli/dist/cli.js workbench --config /Users/lienli/.config/memo-graph/operator.json --format human`，让 launcher 打开浏览器。
- [x] 读取与本次 root/config identity 对应的 endpoint 元数据，记录实际 `origin`、owner PID 和 `runtime_descriptor_path`。
- [x] 验证 Workbench 为 `ready`、HTTP 仅监听 loopback、IPC 可认证、运行目录和凭证权限正确。

## 3. 接入 Codex

- [ ] 备份当前 `memo_graph_memory` 配置片段的精确值，以便回滚。
- [x] 使用当前 Codex 支持的配置命令或等价安全编辑，把实际 descriptor 绝对路径追加到 MCP args，先完成手工 managed 模式验证。
- [x] 重新读取 `/Users/lienli/.codex/config.toml`，确认 command、config path 未改变，且只增加 `--managed-descriptor` 两项。
- [x] 使用官方 MCP client 经新配置连接，验证 `listTools` 和 `memory_search` 能返回切换前的验证 evidence。

## 3A. 自动 bootstrap

- [ ] 新建权限为 `0600` 的 `/Users/lienli/.config/memo-graph/codex-managed-mcp.mjs`，仅组合仓库已有 schema、launcher、lease recovery、artifact path 与 MCP CLI API。
- [ ] 保证 stdout 只承载 MCP；启动、恢复和失败诊断使用 content-free stderr reason code。
- [ ] 用父 Codex app-server PID 与启动时间 hash 的私有 marker，保证同一 app-server 生命周期只自动打开一次页面。
- [ ] 将 Codex MCP command 切换为固定 Node.js + bootstrap entry，不再把一次运行生成的 descriptor path 固化为启动前置条件。
- [ ] 验证 host 缺失、host 已存在、两个 proxy 并发、精确 stale lease、live/ambiguous lease 五种启动路径。

## 4. 用户界面与运行态验收

- [x] 在浏览器中验证 Memory、Graph、Runtime 三个页面可加载，Runtime 显示托管 owner/存储状态，页面无 destructive correction 能力。
- [x] 同时执行 MCP 只读查询并刷新 Runtime 页面，确认两端持续可用。
- [x] 检查进程和 lease：一个 Workbench managed Runtime writer，MCP 仅为带 descriptor 的 proxy，不存在 direct writer。
- [ ] 通知用户新建 Codex 任务或重启 Codex，并在新任务中调用一次 `memo_graph_memory` 完成桌面端验收。
- [ ] 完整退出/重新打开 Codex，证明无需手工 operator 命令即可启动或复用 Workbench、只打开一个前端页面并进入 managed-ready。

## 5. 回滚点

- [ ] 若 Workbench 启动前失败：保持 Codex 配置不变，恢复/重启原 direct MCP。
- [ ] 若 Workbench 已启动但 Codex 代理验证失败：保留诊断证据，验证 endpoint owner 后发送 `SIGTERM`，再移除 managed args。
- [ ] 若 Codex 配置已更新但尚未重载：先恢复原配置，再关闭已确认的 Workbench owner。
- [ ] 回滚后重新验证 direct MCP 搜索原有 evidence；不删除锁文件或任何记忆数据。

## 验证命令/检查项

- operator/MCP schema parse 与 `memoryRuntimeConfigIdentity` 等值检查。
- `ps`、endpoint metadata、descriptor/credential mode、SQLite writer lease 的一致性检查。
- loopback HTTP authenticated health/runtime-state 检查及浏览器实际渲染检查。
- 官方 MCP client 的 `listTools`、`memory_search` 与 managed-ready stderr 诊断。
- `python3 ./.trellis/scripts/task.py validate 08-02-managed-workbench-runtime`。

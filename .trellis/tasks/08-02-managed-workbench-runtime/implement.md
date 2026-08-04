# 执行计划

## 1. 预检与配置

- [x] 确认工作树现状，保留用户无关改动，不改产品源码。
- [x] 使用固定 Node.js 24.18.0 确认必要构建产物存在；仅在缺失或过期时运行仓库规定的 runtime build。
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

- [x] 在 `verification.md` 记录切换前 direct command/args 的精确值，以便回滚。
- [x] 使用当前 Codex 支持的配置命令或等价安全编辑，把实际 descriptor 绝对路径追加到 MCP args，先完成手工 managed 模式验证。
- [x] 重新读取 `/Users/lienli/.codex/config.toml`，确认 command、config path 未改变，且只增加 `--managed-descriptor` 两项。
- [x] 使用官方 MCP client 经新配置连接，验证 `listTools` 和 `memory_search` 能返回切换前的验证 evidence。

## 3A. 自动 bootstrap

- [x] 新建权限为 `0600` 的 `/Users/lienli/.config/memo-graph/codex-managed-mcp.mjs`，仅组合仓库已有 schema、launcher、lease recovery、artifact path 与 MCP CLI API。
- [x] 固定使用 `/Users/lienli/.local/state/memo-graph/workbench-runtime`，并验证有/无 `TMPDIR` 的启动环境共享同一 endpoint 与 owner。
- [x] 保证 stdout 只承载 MCP；启动、恢复和失败诊断使用 content-free stderr reason code。
- [x] 用父 Codex app-server PID、启动时间与 Workbench instance hash 的私有 marker，保证同一 instance 只自动打开一次页面，并在 host 重启后补开有效页面。
- [x] 将 Codex MCP command 切换为固定 Node.js + bootstrap entry，不再把一次运行生成的 descriptor path 固化为启动前置条件。
- [x] 验证 host 缺失、host 已存在、两个 proxy 并发、精确 stale lease、live/ambiguous lease 五种启动路径。

## 3B. 可分发安装与注册修复

- [x] 新增 `@memo-graph/codex-bootstrap` workspace 包，把本机 bootstrap 编排迁入可测试 TypeScript entry，并仅通过 package exports 导入依赖。
- [x] 为 operator 与 MCP CLI 补齐 bootstrap 所需的稳定 package exports，不改变已有运行契约。
- [x] 新增仓库级一键安装命令：构建、内容寻址 deploy、XDG 路径解析、默认治理配置与恢复权威、Codex 注册、失败回滚和官方 MCP client `tools/list` 验证。
- [x] 增加回归测试，证明部署 entry 不含仓库/用户名绝对路径，且源工作树不可用、数据根为空时部署产物仍能进入 ready 并列出完整核心工具。
- [x] 用一键安装命令迁移当前机器，确认 `memo_graph_memory` 指向版本化 release 而非 `/Users/lienli/Documents/GitHub/memo-graph`。
- [x] 将安装入口收敛为 `pnpm codex:install`：入口自行执行 frozen install，并用 pnpm `devEngines.runtime` 下载/锁定 Node.js 24.18.0，移除用户手动切 Node 与预先安装依赖的步骤。
- [x] 将验证过的 Node 24 binary 内容寻址部署到 XDG 私有安装根，Codex 注册不保留 checkout `node_modules` 或版本管理器路径。
- [x] Codex CLI discovery 增加 `mcp list --json` 兼容性探测，优先可用的 Desktop 内置 CLI并跳过旧 PATH CLI。
- [x] 增加旧 Workbench 合约升级接管：只对精确 root/config/credential/descriptor/instance/PID owner 发送 `SIGTERM`，等待退出后重试一次 MCP 验收。
- [x] 增加 Codex CLI 兼容选择与旧协议 Workbench 自动升级回归测试。

## 4. 用户界面与运行态验收

- [x] 在浏览器中验证 Memory、Graph、Runtime 三个页面可加载，Runtime 显示托管 owner/存储状态，页面无 destructive correction 能力。
- [x] 同时执行 MCP 只读查询并刷新 Runtime 页面，确认两端持续可用。
- [x] 检查进程和 lease：一个 Workbench managed Runtime writer，MCP 仅为带 descriptor 的 proxy，不存在 direct writer。
- [x] 通知用户新建 Codex 任务或重启 Codex，并以新的临时 Codex 任务调用一次 `memo_graph_memory.memory_search`，得到结构化 `NO_MATCH`。
- [ ] 完整退出/重新打开 Codex，证明无需手工 operator 命令即可启动或复用 Workbench、只打开一个前端页面并进入 managed-ready。

## 5. 回滚点

- [x] 记录 Workbench 启动前失败时的 direct MCP 恢复命令边界。
- [x] 记录 Workbench 已启动但 Codex 代理失败时的 endpoint owner 验证与 `SIGTERM` 边界。
- [x] 记录 Codex 尚未重载时先恢复原配置、再关闭已确认 owner 的顺序。
- [x] 记录回滚后必须重新搜索原有 evidence，且不得删除锁文件或记忆数据。

## 验证命令/检查项

- operator/MCP schema parse 与 `memoryRuntimeConfigIdentity` 等值检查。
- `ps`、endpoint metadata、descriptor/credential mode、SQLite writer lease 的一致性检查。
- loopback HTTP authenticated health/runtime-state 检查及浏览器实际渲染检查。
- 官方 MCP client 的 `listTools`、`memory_search` 与 managed-ready stderr 诊断。
- 安装 release manifest、Codex 注册 JSON、源工作树独立性与核心工具集合断言。
- `python3 ./.trellis/scripts/task.py validate 08-02-managed-workbench-runtime`。

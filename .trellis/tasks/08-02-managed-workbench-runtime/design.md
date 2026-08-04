# 技术设计

## 目标拓扑

```text
Codex
  └─ stdio MCP proxy (--managed-descriptor)
       └─ authenticated private IPC
            └─ Workbench managed Runtime (唯一 SQLite writer)
                 ├─ memo-graph SQLite / projections / workers
                 └─ loopback HTTP
                      └─ 浏览器 Memory / Graph / Runtime
```

Workbench host 同时拥有 SQLite writer lease、后台 worker、私有 MCP IPC 和 loopback HTTP。浏览器与 Codex 都是它的客户端，不直接打开 SQLite。

## 配置映射与身份约束

建立 `/Users/lienli/.config/memo-graph/operator.json`：

- 顶层 `data_root`、`principal_id` 复制 MCP 配置。
- `workbench` 复制 `allowed_scopes`、`allowed_authorities`、`destructive_tools_enabled`、`default_token_budget` 和 `lane_policy`。
- MCP 的 `recovery_head` 映射为 operator 的 `recovery.authority`；`backup_bundles` 与 `restore_targets` 为空对象。
- MCP 与 operator 两侧均由 `MemoryServerConfigSchema` 补全相同的 graph/vector 默认值。

启动前使用项目代码解析两份配置并比较 `memoryRuntimeConfigIdentity`，只允许身份完全一致时继续。这样避免“看起来相同、默认值不同”导致 IPC attach 被拒绝。

## 启动与切换

1. 记录当前 direct MCP 的精确 PID、PPID、完整 argv 和 writer lease 状态。
2. 用 `SIGTERM` 正常终止这些已确认的 direct MCP writer，等待其退出并释放 lease；不操作其他 Node/Codex 进程。
3. 以固定 Node.js 24.18.0 启动 operator CLI 的 `workbench` 命令。默认启动会通过一次性 URL fragment 打开浏览器并建立页面 bearer。
4. 从私有 runtime directory 中读取与本次 root/config identity 匹配的 endpoint 元数据，获得 `runtime_descriptor_path`；不通过文件名猜测。
5. 验证 HTTP、IPC、root/config identity 及 Runtime `ready` 后，更新 Codex 的 `memo_graph_memory.args`，追加该绝对 descriptor 路径。
6. 使用独立官方 MCP client 启动一次 managed proxy 做协议与记忆连续性验证。
7. 用户新建 Codex 任务或重启 Codex，使桌面应用重新读取 MCP 配置。

## Codex 自动 bootstrap

新增可部署的 `@memo-graph/codex-bootstrap` entry，Codex 的 `memo_graph_memory` command 使用安装时确认的 Node.js 24 执行部署目录中的 entry。entry 不实现存储、HTTP 或 MCP 协议，只编排已发布包 API：

1. 使用 `OperatorConfigSchema` 和 `workbenchRuntimeConfig` 解析 operator 配置，再次确认其 config identity 与 MCP 配置相同。
2. 检查数据根 writer lease。只有仓库 `recoverStaleRootLease` 要求的 exact proof 成立时才恢复；owner 存活、时间未过期、PID 无法证明或文件并发变化时保持阻断。
3. 使用固定私有目录 `/Users/lienli/.local/state/memo-graph/workbench-runtime`，首先以 no-open 模式调用 `launchOrReuseWorkbench`。不得调用基于 `tmpdir()` 的默认目录，因为 Codex 与 shell/MCP 测试环境可能得到不同的 macOS `TMPDIR`。该 launcher 已按 canonical root 串行化并发启动，因此多个 Codex 任务只能产生一个 owner。
4. 用 `process.ppid`、父进程启动时间和 Workbench `instance_id` 的 hash 形成私有 browser marker。当前 Codex app-server 对同一 host instance 第一个成功创建 marker 的 bootstrap 再请求一次 ticket bootstrap 并打开浏览器；其余 MCP 进程跳过打开动作。host 更换 instance 时 marker 随之变化，允许补开一个有效页面。
5. 用 `workbenchArtifactPaths` 根据 canonical root/config identity 取得真实 descriptor path，并调用 `runMemoryMcpCli` 的 managed 模式接管当前 stdin/stdout。bootstrap 不向 stdout 输出任何非 MCP 字节，诊断只写 content-free JSON 到 stderr。

Workbench host 独立于单个 MCP proxy 生命周期。退出一个 Codex 任务只关闭其 proxy；退出 Codex 不主动停止 host。下一次 Codex app-server 启动会复用健康 host并重新打开一个已认证页面；若 host 不在，则先创建 host。

## 可分发安装边界

仓库提供一个安装命令，按以下顺序执行：

1. `pnpm codex:install` 先执行 frozen workspace install；根清单的 `devEngines.runtime` 让 pnpm 下载并锁定 Node.js 24.18.0，后续脚本不依赖 shell 当前 Node。
2. 在该 workspace-managed Node 24 下构建 Runtime 和 bootstrap 包，并按版本与二进制 hash 把 Node executable 复制到 XDG 私有安装根；最终 Codex command 不引用 checkout 的 `node_modules` 或用户版本管理器。
3. 使用 workspace deploy 生成自包含 staging 目录；根据部署内容计算 release identity，并安装到 XDG data 目录下的版本化 release，不覆盖已有 release。
4. 从 XDG config/state 默认值或显式参数解析 MCP config、operator config 和 Workbench runtime directory。部署后的 entry 不读取 Git、仓库根或工作树路径。
5. 枚举显式 override、环境候选、Codex Desktop 内置 CLI 与 PATH CLI，逐个执行只读 `mcp list --json` 兼容性检查；选择第一个能解析当前配置的 CLI。
6. 用选中的 Codex CLI 读取旧注册，切换 `memo_graph_memory` 到新 release entry；旧注册以私有权限保存，任何后续失败都回滚。
7. 用官方 MCP client 从最终 Codex command 启动一次新连接，完成 `initialize`/`tools/list` 并断言核心工具存在。若唯一失败原因是精确匹配 owner 的旧 Workbench HTTP 合约，则正常发送 `SIGTERM`、等待退出并重试一次；任何身份歧义或二次失败都回滚。

部署包必须通过正常 package exports 访问 operator、Workbench、MCP、Runtime 与 recovery API，禁止把 workspace 内部文件的绝对路径写进生成脚本。开发仓库切换分支只影响下一次构建，不影响当前已安装 release。

## 安全与失效行为

- operator 配置写入时权限为 `0600`；Workbench runtime directory 由 host 强制为 `0700`，descriptor/credential 为 `0600`。
- HTTP 只绑定 loopback，浏览器凭证不写入 endpoint 元数据或日志。
- managed descriptor 缺失、过期、身份不符或 host 不健康时，MCP 进入 blocked/health-only 行为，不回退为 direct writer。
- `destructive_tools_enabled=false` 同时出现在两侧配置身份中，确保 UI 和 MCP 不会因切换扩大权限。

## 兼容与生命周期

- 已打开的 Codex 任务不会因编辑 `config.toml` 自动替换现有 stdio 子进程，因此切换的用户可见边界是“Workbench 当场可用，Codex 在新任务/重启后改走 proxy”。
- installer 的真实 MCP client 验证覆盖安装产物健康；桌面任务工具注册表仍按任务生命周期加载，因此安装完成后需要新建任务或重启 Codex 才能在 UI 中看到新工具。
- 关闭浏览器不停止 Runtime；只要 managed host 存活，新的浏览器 launch 可安全复用同一 owner。
- 本任务不配置 LaunchAgent 或开机自启。主机重启后，首次启动 Codex MCP 的 bootstrap 会按相同流程创建 Workbench；无需单独手工启动。

## 回滚设计

回滚先确认 endpoint owner 仍与预期 root/config identity 匹配，再向该 PID 发送 `SIGTERM` 并等待干净关闭。随后把 Codex MCP command/args 恢复为原 Node.js + `packages/mcp-server/dist/cli.js --config ...` direct entry，最后在新 Codex 任务中验证 direct 模式。任何阶段都不删除数据根、writer lease、runtime artifact 或 recovery authority。

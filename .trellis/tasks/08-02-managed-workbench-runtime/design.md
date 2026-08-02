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

## 安全与失效行为

- operator 配置写入时权限为 `0600`；Workbench runtime directory 由 host 强制为 `0700`，descriptor/credential 为 `0600`。
- HTTP 只绑定 loopback，浏览器凭证不写入 endpoint 元数据或日志。
- managed descriptor 缺失、过期、身份不符或 host 不健康时，MCP 进入 blocked/health-only 行为，不回退为 direct writer。
- `destructive_tools_enabled=false` 同时出现在两侧配置身份中，确保 UI 和 MCP 不会因切换扩大权限。

## 兼容与生命周期

- 已打开的 Codex 任务不会因编辑 `config.toml` 自动替换现有 stdio 子进程，因此切换的用户可见边界是“Workbench 当场可用，Codex 在新任务/重启后改走 proxy”。
- 关闭浏览器不停止 Runtime；只要 managed host 存活，新的浏览器 launch 可安全复用同一 owner。
- 本任务不配置开机自启。主机重启或 managed host 退出后，需要先启动 Workbench，再使用依赖 managed descriptor 的 Codex MCP。

## 回滚设计

回滚先确认 endpoint owner 仍与预期 root/config identity 匹配，再向该 PID 发送 `SIGTERM` 并等待干净关闭。随后从 Codex MCP args 中移除 `--managed-descriptor` 两项，保留原 command/config，最后在新 Codex 任务中验证 direct 模式。任何阶段都不删除数据根、writer lease、runtime artifact 或 recovery authority。

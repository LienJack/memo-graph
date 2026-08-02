# Research: U3 Runtime Host 与 MCP Attach Proxy

- Query: 在不改变现有 direct-stdio MCP 语义的前提下，如何抽取 `packages/runtime-host`，让一个 managed host 独占 Runtime/SQLite/Graph/Vector/background lifecycle，并通过认证后的私有 IPC 转发现有 MCP framing；同时识别前置 characterization、可复用函数、最小文件树、兼容性陷阱和验证命令。
- Scope: mixed
- Date: 2026-08-02

## Findings

### 1. 结论与实现边界

U3 可以继续沿用现有 MCP framing，不需要先发明 operation RPC。仓库锁定的 `@modelcontextprotocol/server@2.0.0` 已经公开支持把任意 Node `Readable`/`Writable` 交给 `StdioServerTransport`，也允许 `serveStdio` 接收自定义 `Transport`；因此一个通过认证的 `net.Socket` 可以直接作为 MCP 输入与输出。版本内的 `serveStdio` 仍负责每连接绑定一个 `McpServer`、opening/era routing、取消和连接关闭。这个判断目前是“实现面可行”，必须先用真实 Unix socket characterization 锁定并发、取消、half-close 和 stdout 语义，再删除 fallback RPC 设计。

推荐的依赖方向是：

```text
contracts/storage/graph/vector/memory-kernel
                  ↓
             runtime-host
              ↑        ↑
       mcp-server     apps/memory-workbench-host (U4)
              ↑
         stdio proxy
```

- `runtime-host` 拥有配置解析、具体 Runtime 组合、批准清单、可信私有文件读取、snapshot registry、后台 supervisor、root/config/instance identity、IPC 握手和 host 生命周期。
- `mcp-server` 只保留 MCP tools/resources 注册和两个 CLI adapter：direct 模式通过共享 factory 打开/关闭 Runtime；managed 模式只认证并转发字节，不打开 SQLite、worker、Graph/Vector 或浏览器。
- `runtime-host` 不得导入 `mcp-server`。`host.ts` 接受一个每连接的 transport-neutral `attachSession(duplex, sessionContext)` callback；U4 的 app 或集成 fixture 依赖两边并注入 `createMemoryMcpServer` + `serveStdio`。一个 IPC 连接必须得到一个新的 `McpServer`，但所有连接共享同一个 Runtime/storage。
- direct 模式默认不变；managed 必须由显式 flag/config 选择，连接失败时只启动本地 health-only MCP adapter，绝不能 fallback 到 `openMemoryRuntime`。

还有三个不能靠“只抽文件”满足的 U3 前置契约缺口：

1. consolidation 与 FTS 没有持久化的最大尝试/terminal 状态，supervisor 单独无法兑现“bounded retry + terminal failure + restart recovery”。
2. 现有 public `OperationalStatus` 没有 `runtime_owner`/`background_work` component，也没有 host absent、root mismatch、config mismatch、IPC protocol mismatch 等 reason code，无法同时满足“typed distinct”与 R18。
3. root writer lease 只在受保护的写操作进入 queue 时 heartbeat；长时间空闲的 managed host 没有显式 lease-maintenance API。

这些应在 U3 开始时作为最小 additive storage/contracts scope delta 处理，不能用内存计数器、日志字符串或 PID 检查伪装成闭环。

### 2. Files found

| Path | 当前责任与 U3 用途 |
|---|---|
| `packages/mcp-server/src/index.ts:202-242` | `MemoryServerConfigSchema` 当前与 MCP adapter 同文件；应移到 factory 所属层并由 direct/managed 共用。 |
| `packages/mcp-server/src/index.ts:525-547` | `MemoryMcpRuntime` 是 adapter 所需的最窄 Runtime port；保留在 MCP 层，避免 adapter 获取 host lifecycle 权限。 |
| `packages/mcp-server/src/index.ts:549-903` | `createMemoryMcpServer` 注册现有 tools/resources；继续作为每 IPC 连接的终点，不搬入 host。 |
| `packages/mcp-server/src/index.ts:906-1052` | `openMemoryRuntime` 是主要抽取源：recovery authority、SQLite、lazy Graph、Vector、lane retriever、approval registry、MemoryRuntime 和 close 顺序。 |
| `packages/mcp-server/src/index.ts:1054-1094` | `preflightMemoryRuntime` 应随 composition 移到 `runtime-host`，direct CLI 与 managed host 共用。 |
| `packages/mcp-server/src/cli.ts:34-129` | direct 模式现有 stdout/stderr/shutdown 基线：stdout 仅 MCP；诊断是 stderr JSON；signal/stdin EOF 关闭 transport 和 Runtime。 |
| `packages/mcp-server/src/mutations.ts:36-209` | `LocalManifestApprovalRegistry` 是 concrete composition dependency，应搬到 `runtime-host/src/approval-registry.ts`。 |
| `packages/mcp-server/src/trusted-file.ts:52-121` | 已有 `O_NOFOLLOW`、owner/mode/size/race 校验与失败清零；应搬到 host 内部工具，而不是重写弱版本。 |
| `packages/storage-sqlite/src/client.ts:628-681` | client construction 准备 root、获取唯一 writer lease，并在 writer queue admission 时 heartbeat。 |
| `packages/storage-sqlite/src/client.ts:898-917` | `SqliteStorageClient.open` 完成 health、recovery authority 初始化和 purge finalize；factory 应只调用一次。 |
| `packages/storage-sqlite/src/client.ts:1389-1435` | consolidation 的 enqueue/claim/fail/complete API。 |
| `packages/storage-sqlite/src/client.ts:1462-1560` | Graph snapshot/claim/apply/fail/status API。 |
| `packages/storage-sqlite/src/client.ts:1563-1644` | Vector configure/checkpoint/claim/apply/fail/stale API。 |
| `packages/storage-sqlite/src/client.ts:1981-1987` | FTS 只有无参数 `drainFtsOutbox()`，内部上限固定为 1000，supervisor 不能配置小批量。 |
| `packages/storage-sqlite/src/client.ts:2208-2234` | idempotent close 终止 worker 并释放 root lease；必须是 factory handle 的唯一最终 owner。 |
| `packages/storage-sqlite/src/client.ts:2580-2719` | worker 在 exit 后被清空，下一请求可 lazy respawn；pending 请求以 `WORKER_CRASHED` 失败，适合 supervisor retry/recovery。 |
| `packages/storage-sqlite/src/root-lease.ts:157-230` | `wx` acquire、fence、heartbeat、exact-owner release。 |
| `packages/storage-sqlite/src/root-lease.ts:248-291` | stale recovery 同时要求 identity/fence/heartbeat 未变化、过期、owner 确认不存活；说明 PID 不是 host reuse authority。 |
| `packages/memory-kernel/src/consolidation-service.ts:71-172` | 可直接组装的 consolidation drain；默认 claim 100，失败固定延迟 1 秒。 |
| `packages/graph-projection/src/projector.ts:132-371` | `ExactScopeGraphProjector` 已有 claim/lease/retry/bounded drain，并在 Graph write 后 read-back + health 验证。 |
| `packages/vector-retrieval/src/projector.ts:369-435` | `VectorScopeProjector.drain` 已有 bounded claim 和 per-job outcome。 |
| `packages/graph-projection/src/graph-retriever.ts:227-252` | retriever 支持现成 `store` 或 lazy `storeFactory`，两者只能选一个。 |
| `packages/graph-projection/src/graph-retriever.ts:736-771` | retriever 会关闭其 store；factory 失败后当前 Runtime 生命周期内永久降级，影响 managed shared-store 设计。 |
| `packages/graph-projection/src/process-host.ts:270-299` | `GraphProcessHost.open` 会准备 derived path、启动 child 并 initialize。 |
| `packages/graph-projection/src/process-host.ts:309-340` | 已有 content-free Graph process health，可纳入 supervisor observation。 |
| `packages/graph-projection/src/process-host.ts:443-477` | Graph host close 是有界 graceful close 后强制 kill，适合统一 close stack。 |
| `packages/vector-retrieval/src/retriever.ts:406-483` | Vector query 每次打开 runtime 并在 `finally` 关闭，没有需 host 长期持有的全局 vector child。 |
| `packages/memory-kernel/src/workbench-service.ts:38-69` | U1 的 snapshot interface 和四种 stale reason。 |
| `packages/memory-kernel/src/workbench-service.ts:224-234` | snapshot 仅接收 ordered `(memory_id, revision_id)` membership、query/frontier hash 和分页元数据。 |
| `packages/memory-kernel/src/workbench-service.ts:613-660` | cursor page 从 SQLite 按 immutable membership 重载；registry 不能保存内容或事务。 |
| `node_modules/@modelcontextprotocol/server/dist/stdio.d.mts:22-29` | pinned SDK 明确支持 Unix socket/TCP 上的自定义 transport，并由 `serveStdio` ownership。 |
| `node_modules/@modelcontextprotocol/server/dist/stdio.d.mts:40-61` | 一个 connection pin 一个 instance；handle close 同时关闭 instance/transport。 |
| `node_modules/@modelcontextprotocol/server/dist/stdio.d.mts:76-103` | `StdioServerTransport` 接受任意 `Readable`/`Writable`，默认最大单消息 buffer 10 MB。 |
| `tests/integration/codex-explicit-loop.integration.test.ts:78-99` | 已有真实 built CLI + official `StdioClientTransport` fixture。 |
| `tests/integration/codex-explicit-loop.integration.test.ts:141-366` | 已覆盖 tool/resource identity、资源无副作用、ingest replay、重启持久化、unauthorized 无写入和 stderr redaction。 |
| `tests/mcp/governance-mutations.integration.test.ts:813-885` | 已有 direct Runtime 与真实 stdio MCP mutation receipt/replay parity。 |
| `tests/mcp/context-compiler.test.ts:371-475` | 关键 direct compatibility：仅 open 配置了 Graph/Vector 的 Runtime 不得创建/start optional derived dependencies。 |
| `tests/integration/frozen-layered-context-slice.integration.test.ts:157-248` | 真实 stdio 上的 lane/frontier 语义基线。 |
| `tests/contract/mcp.contract.test.ts:45-52` | 只锁定 SDK symbol 存在，尚未锁定 socket framing/cancel/lifecycle。 |

### 3. Runtime factory 的最小可行契约

建议 `runtime-factory.ts` 提供一个统一但明确分 mode 的 factory，而不是让 CLI 或 app 各自拼装：

```ts
type RuntimeOpenMode = "direct" | "managed";

type OpenedMemoryRuntime = {
  config: MemoryServerConfig;
  configIdentity: CanonicalHash;
  rootIdentity: RootIdentity;
  storage: SqliteStorageClient;
  runtime: MemoryRuntime;
  supervisor: BackgroundSupervisor | null;
  workbenchSession(sessionId: string): WorkbenchService;
  health(): Promise<HostHealthSnapshot>;
  close(): Promise<void>;
};
```

- `mode=direct`：复现当前 `openMemoryRuntime` 的 lazy Graph 与 per-query Vector 行为；不启动 supervisor、不发布 descriptor、不建立 IPC。这样 `context-compiler.test.ts:371-475` 继续证明 open 无 optional artifact side effect。
- `mode=managed`：只由 host 调用；一个 storage/client、一个 MemoryRuntime、一个 supervisor、一个 session/snapshot pool、一个 close stack。Graph/Vector failure 只降级 projection/recall，不得把 canonical storage 假报为空。
- config identity 只绑定会改变 Runtime 权限/行为的规范化 `MemoryServerConfig`，不要把 `--mode`、descriptor path、browser port 等 attach/launcher 参数混入；否则相同 Runtime 配置无法安全 reuse。
- root identity 使用 `realpath` 后的 `(dev, ino)` 与 canonical root reference/hash；单纯字符串 path 会被 symlink/alias 绕开。现有 `rootRef` 在 `root-lease.ts` 内部，可抽成共享 internal helper或导出受测 helper，不能复制出第二种算法。
- 返回 handle 自己拥有所有 close responsibility。调用者不能单独关闭 `storage` 或 Graph child。

#### Graph/Vector ownership

direct 模式保持当前 lazy Graph。managed 模式的 Graph recall 与 Graph projector 不能各开一个 `GraphProcessHost` 指向同一个 derived store。最小可靠实现是 factory 内部的 `SharedGraphStoreManager` 加一个永不拥有 close 的 `GraphStore` proxy：proxy 的方法在调用时 lazy/retry 打开 manager；同一个 proxy 同时注入 `GraphRecallRetriever({ store: proxy })` 和 `ExactScopeGraphProjector({ store: proxy })`。retriever 的 `close()` 只触发 proxy no-op，最终由 factory manager close 实际 child 一次。这样避免现有 `storeFactory` 一次失败后永久 latch（`graph-retriever.ts:751-771`），也避免 managed startup 为可选 Graph 立即创建 artifact。

Vector 不要做同样的长生命周期 pool：现有 query retriever 和 projector 都按请求/job 打开、关闭 vector process，保留它们的 timeout/circuit/outcome 语义即可。supervisor 只拥有 projector 对象，不拥有 query child。

#### Close 顺序

1. host 状态改为 `draining`，拒绝新 attach 和新 background claim。
2. 等待当前 lane 的有界 drain；到 deadline 后停止等待，绝不继续 claim。
3. 关闭所有 per-connection MCP handles/sockets，使 outstanding call 明确失败且不重放。
4. 关闭 HTTP（U4）与 IPC listener，撤销 session/snapshot/credentials，移除当前 instance 自己拥有的 descriptor/socket。
5. 关闭 Graph shared manager/其他 child。
6. 最后 `storage.close()`，终止 worker 并释放 writer lease。

如果 U4 希望先让已有请求完成，可在第 2 和第 3 步之间设置一个独立的 session grace deadline；不能让无限 MCP 请求阻止 root lease 释放。

### 4. MCP direct framing over authenticated IPC

#### 推荐握手状态机

```text
proxy reads config + non-secret descriptor + separate 0600 credential
  → connect user-private Unix socket
  → ClientHello(instance/root/config/protocol/client_nonce/client_proof)
  ← ServerAck(server_nonce/server_proof)
  → proxy verifies host proof
  → only now attach stdin ↔ socket ↔ stdout byte pipes
  → host constructs StdioServerTransport(socket, socket, bounded maxBufferSize)
  → serveStdio(() => createMemoryMcpServer(sharedRuntimePorts), { transport })
```

- `client_proof = HMAC(K, "client" + canonical transcript)`；server proof 再绑定 client/server nonce 与全部 identity。credential 本身不进 argv/env/descriptor/log，也不原样上 wire。比较固定长度 digest 时使用 `timingSafeEqual`。
- 握手 frame 使用 strict Zod、UTF-8 单行、独立的较小上限（建议 8 KiB）、短 timeout 和 unknown-key rejection。MCP transport 只在 ACK 完成后接管 socket。
- proxy 必须等 ACK 后才读取/pipe stdin。否则一个 packet 内的 handshake + MCP bytes 可能被临时 parser 消费或丢失；也可能把私有 ACK 写到 MCP stdout。禁止 pipelined opening 可以把这个边界变得可测且简单。
- MCP stdout 永远只出现 MCP JSON-RPC newline frames；连接/认证/descriptor/health 诊断只进 stderr content-free JSON。
- browser bearer、preview seal、approval identity 和 IPC credential 各自独立；任一 token 不能跨边界验证。
- 一个 proxy EOF/close 只关闭该 connection 的 `serveStdio` handle。host/runtime 生命周期独立；其他 proxy 与 supervisor 继续。
- host close 时 pending request 可以因 transport close 失败，但 proxy 不允许自动重连并 replay mutation；客户端若基于同一 idempotency key 主动重试，仍由现有 Runtime 规则决定 replay。

#### Descriptor、endpoint 与 stale cleanup

- descriptor 是 atomic non-secret metadata：`schema_version`、instance ID、MCP attach protocol、canonical root identity/hash、config hash、socket path、created/ready time。credential 是另一个随机至少 256-bit、`0600` 文件，目录 `0700`。
- macOS `sockaddr_un.sun_path` 常见上限约 103 bytes；不要把完整 data root 拼进 socket path。用 user-private 的短 runtime base directory + root/config hash 的短安全文件名，并在测试中覆盖长 root。
- reuse 必须成功完成相互认证并匹配 root/config/protocol/instance；PID 仅是诊断，不是 authority。
- “auth mismatch/explicit identity mismatch”表示可能存在另一个 live owner，不能删 socket。只有连接失败/超时且 authenticated probe 未得到有效 live response，并且 descriptor/socket 的 `lstat → open/no-follow → fstat → re-read` identity 仍未变化时，才能 quarantine 后清理。清理后仍需由 U4 的 launch lock 仲裁新 host；U3 不应提前创建 `launch-lock.ts`。
- host absent 时 managed CLI 仍需完成 MCP initialize：本地创建 health-only MCP server，返回 typed blocked state；不得把 plain text/error byte 写 stdout，也不得因 attach failure 走 direct factory。

#### 当前 public health vocabulary 的缺口

`OperationalComponentSchema` 目前只有 `canonical/data_root/.../graph_projection/vector_projection/learning`（`operations.ts:430-436`），没有 Runtime owner 与 background work；reason codes（`operations.ts:448-464`）也只能把 attach failure 压成 `INTERNAL_FAILURE`。而当前 `operationalStatusFromStorageHealth` 又固定把 Graph/Vector 报成 disabled（`storage-sqlite/src/operational-health.ts:314-331`）。

U3 应先添加最小 additive vocabulary，或在同一 unit 中新增严格的 host-health contract，再由 MCP health provider 与后续 U4/U8 共用。至少需要区分：

- `HOST_UNAVAILABLE`
- `HOST_IDENTITY_MISMATCH`（details 内再安全区分 root/config/instance，不包含 path）
- `IPC_PROTOCOL_INCOMPATIBLE`
- `HOST_AUTHENTICATION_FAILED`
- `RUNTIME_BLOCKED`
- `BACKGROUND_RETRYING`
- `BACKGROUND_TERMINAL_FAILURE`

同时需要 `runtime_owner` 与 `background_work` observations，scope 只能是 canonical hash/typed governed scope，不能带 data root、memory text、evidence payload、credential 或 exception message。canonical storage observation 永远排第一；projection/background 是 subordinate，不能把 projection ready 当成 canonical ready。

### 5. Snapshot registry 实现映射

U1 已将边界缩小为 ordered membership identity，适合纯内存 host registry：

- `snapshot-registry.ts` 实现 `InMemoryWorkbenchSnapshotRegistry`，存 `query_hash`、`frontier_hash`、ordered `(memory_id, revision_id)`、page size、omitted count、created/expires time，不存 content、summary、evidence 或 SQLite transaction。
- cursor 是 `wbcur1_` + base64url 的有界 signed payload，绑定 instance ID、session ID、snapshot ID、query hash、offset、expiry。cursor 不暴露 free-text query。
- 由于 restart 会轮换 signing secret，要想稳定返回 `SNAPSHOT_RESTARTED`，可以把 bounded instance ID 放在 signed payload 的可解析 header：先做结构/长度检查并比较 instance，再对同-instance cursor 验证 HMAC。外部伪造最多得到 restarted，不会取得 membership。
- 当前 instance 且 HMAC/query/session/offset 无效 → `CURSOR_INVALID`；signed expiry 已过 → `SNAPSHOT_EXPIRED`；signed current cursor 指向已不存在且尚未过期的 snapshot → `SNAPSHOT_EVICTED`。这样不需要无界 tombstone map。
- count、总 membership、估算 bytes、TTL 四个上限都在 `create` 前检查；按 `(created_at, snapshot_id)` 确定性淘汰。单个 snapshot 自身超过总 budget 时返回 typed resource failure，不得淘汰全部后悄悄截断。
- `WorkbenchSnapshotRegistry` interface 没有 session 参数，因此 host 应为每个 browser session 构造带 session binding 的 façade；底层可共享一个 global budget coordinator，防止创建很多 session 绕过 host 总量上限。
- host restart/stop 清空全部 membership 和 HMAC key；proxy/browser session 不能复用旧 cursor。

### 6. Background supervisor 与当前 job API

`background-supervisor.ts` 建议实现可注入的 lane state machine，而不是四个独立 `setInterval`：

```text
starting → running → draining → stopped
                 ↘ terminal/degraded observation (lane-local)
```

- 每 lane 只允许一个 in-flight `runOnce()`；另有很小的全局 background concurrency 上限，避免四个 lane 同时向单 storage worker claim。
- 每次 tick 先看 host state 和 storage queue/capacity health；interactive/health/mutation capacity 优先。当前所有 worker operation 最终都串行进入 storage worker，`storage-worker.ts` 的 operation chain 是最后防线，不代表 supervisor 可以无限 claim。
- FTS lane 调 `drainFtsOutbox`；consolidation lane 组装 `ConsolidationService`；Graph lane 使用 shared Graph proxy 的 `ExactScopeGraphProjector`；Vector enabled 时组装 `VectorScopeProjector`。
- job APIs 已通过 lease expiry 在下一次 claim 时恢复过期 processing；host startup 不需要改写所有 job，只需在 first claim 前发布 `recovering` observation，并让 repository 的 claim transaction 做原子 recovery。
- shutdown 先禁止下一 claim，再 await 当前 drain 到 deadline。现有 projectors 没有 `AbortSignal`，所以不能声称正在执行的 per-job call 被安全取消；deadline 后关闭 transport/storage，未完成 lease 由新 host 在 expiry 后恢复。
- health 只记录 lane state、last-success/failure reason code、in-flight、consecutive failures、next retry、claimed/completed/failed/terminal counts、observation time；绝不保存 job payload、memory/revision content 或 raw exception。

#### 必须补齐的 durable retry/terminal contract

- generic projection claim 选择所有 pending/failed 且没有 attempt cap（`projection-repository.ts:488-547`）；fail 只改回 failed + retry_at（`:550-593`）。重启后会无限重试。
- FTS drain 默认一次 1000（`fts-index.ts:94-118`），失败只 `attempts + 1` 并保持可立即再次选择（`:190-201`, `:245-251`），supervisor 周期会形成 hot loop。
- Graph claim 已有 `attempts < MAX_GRAPH_PROJECTION_ATTEMPTS`（`graph-projection-repository.ts:309-351`），Vector 有 `attempts < 32`（`vector-projection-repository.ts:347-379`），但达到上限的 row 仍是 `failed`，public status 需要能把“unclaimable terminal”与“will retry”分开。

最小修复是把 attempt policy 放进 contracts/repository，而不是放在 supervisor memory：

1. generic/FTS/Graph/Vector 共用或各自拥有显式 `max_attempts` 常量与可测 retry schedule；claim 不再拿 terminal rows。
2. FTS 失败写 future `available_at`，并允许 client 传一个较小 bounded drain limit。
3. status 返回 retryable failed 与 terminal failed 的 distinct counts/last reason；startup health 读取 durable state。
4. expiry recovery 不额外增加 attempt；真正 claim 时只加一次，避免 crash/restart 双重计数。

否则 U3 的测试只能证明“本进程停止轮询”，不能证明 restart 后 terminal failure。

### 7. Direct-mode characterization：必须在搬代码前落测试

先提交/运行 characterization，再移动 `openMemoryRuntime`；后续相同测试成为 compatibility oracle。

#### 7.1 复用并加强已有真实 CLI tests

扩展 `codex-explicit-loop.integration.test.ts` 或新增 `tests/mcp/direct-mode-characterization.integration.test.ts`，使用 built `packages/mcp-server/dist/cli.js`：

1. 默认未提供 managed flag 时仍是 direct；tool metadata、resource URIs、代表性 read/mutation/receipt/replay 与当前完全一致。
2. 读取 resources 无副作用；unauthorized call 不增加 recall/receipt；stderr 不出现 root、query、content、secret。
3. stdin EOF、SIGTERM、client crash 都最终释放 root lease；同 config 能再次 direct open。
4. 两个 direct process 争同 root：第一个继续可用，第二个只提供 blocked health，绝不成为第二 writer。
5. 配置 Graph/Vector 但没有调用对应 lane 时，open/close 不创建 optional derived artifacts（继续锁定 `context-compiler.test.ts:371-475`）。
6. 用 raw child stdio 发送 initialize/list/call frames，断言 stdout 每一行都是合法 MCP JSON-RPC，无 ready/handshake/log byte；所有 diagnostics 都是 content-free stderr JSON。
7. 用注入的 slow MCP fixture 明确测试 concurrent request ID correlation、`notifications/cancelled` 和 transport close；不要依赖真实 SQLite 操作恰好够慢。

#### 7.2 Unix-socket framing spike

在 `tests/mcp/managed-host-proxy.integration.test.ts` 先做最薄 spike：认证 ACK 后创建 `new StdioServerTransport(socket, socket, { maxBufferSize })`，交给 `serveStdio`，factory 返回现有 `createMemoryMcpServer`。

必须逐项证明：

- initialize/listTools/listResources/readResource/代表性 call 与 direct 的 canonical structured response、tool annotations、resource text 相同。
- 两个 proxy 并发时 request IDs/response 不串线；每连接是独立 MCP server state，共享 Runtime receipt/state。
- cancellation 只影响目标连接/请求；断连本身不被解释成另一个 client 的 cancel。
- proxy half-close、stdin EOF、SIGKILL 只回收该 session，host 仍接受下一 proxy；另一个现有 proxy 仍工作。
- host stop 会关闭所有 sessions；outstanding request 清楚失败，不自动 replay；新 host 需要新 credential/handshake。
- socket/descriptor/auth frames 从未进入 proxy stdout，browser bearer 不能 attach，IPC credential 不能调用 browser API。

只有当这个 spike 给出具体、可重放的 cancel/lifecycle 失败时，才进入“共享 exact operation registry + 两 adapter”的备选设计。不能因为 IPC 看起来像 RPC 就先复制 tools registry。

### 8. Smallest viable U3 tree

```text
packages/runtime-host/
  package.json
  tsconfig.json
  src/
    runtime-factory.ts       # config + direct/managed composition + close stack
    host.ts                  # one Runtime owner, IPC listener, session registry
    approval-registry.ts     # LocalManifestApprovalRegistry + private-file helper
    background-supervisor.ts # injectable lane state machine + health snapshot
    snapshot-registry.ts     # bounded per-session façade/global accounting
    ipc-handshake.ts         # descriptor/credential schemas + mutual auth
    index.ts                 # narrow public exports
packages/mcp-server/src/
  index.ts                   # MCP registration only; imports shared config types
  cli.ts                     # explicit direct or managed adapter selection
  ipc-proxy.ts               # auth, health-only failure adapter, byte piping
```

- 不在 U3 创建 `launch-lock.ts`：reviewed U3 file list没有它，repeated launch arbitration 属于 U4 operator/app lifecycle；U3 只提供 identity/probe/descriptor primitives。
- `trusted-file.ts` 与 `mutations.ts` 可以先作为 compatibility re-export，减少已有 import 一次性破坏；真正实现只能在 `runtime-host` 一份。
- `runtime-host` 依赖 `contracts`, `storage-sqlite`, `memory-kernel`, `graph-projection`, `vector-retrieval`, `zod`；不依赖 MCP SDK。
- `mcp-server` 依赖 `runtime-host`, `contracts`, `storage-sqlite`（最好再缩成 structural health/storage port）, MCP SDK, `zod`；Graph/Vector composition dependencies 从这里移走。
- root `build:runtime` 在 Graph/Vector/Memory/Storage build 后、MCP/app build 前加入 `@memo-graph/runtime-host`。workspace 已覆盖 `packages/*`，无需改 workspace glob。

测试最小集合：

```text
tests/mcp/direct-mode-characterization.integration.test.ts   # move-before baseline
tests/mcp/managed-host-proxy.integration.test.ts              # framing/auth/parity/multi-client
tests/integration/workbench-host.integration.test.ts          # one owner/factory/supervisor/snapshot
tests/recovery/workbench-lifecycle.recovery.test.ts            # crash/stale/restart/drain
```

已有 `codex-explicit-loop`, `governance-mutations`, `frozen-layered-context-slice`, `context-compiler`, root lease、Graph/Vector recovery tests 继续作为回归 gate，不要复制其大 fixture。

### 9. Compatibility and failure traps

1. **隐藏 direct fallback**：managed attach failure 调用 shared factory 会争 writer lease，直接违反核心目标。用 CLI 分支和 spy/child-process 测试证明 managed path 未 import/open storage。
2. **握手与 MCP bytes 粘包**：认证 parser 读取过量后再交 socket 会丢 initialize。ACK-before-pipe，或显式把 remainder push back；推荐前者。
3. **每连接 server state**：不能把一个 `McpServer` instance 复用给多个 socket；共享的只能是 Runtime/storage ports。
4. **stdout 污染**：任何 ready/attach/error/ACK 不得写 proxy stdout。host-unavailable 也通过本地 health-only MCP framing 回应。
5. **SDK era behavior**：pinned `serveStdio` 2.0.0 有 connection opening/era routing，不等同于简单 `server.connect`。必须继续 pin 版本和 contract test，不要在 proxy 手写 JSON line router。
6. **Graph double owner/double close**：retriever 和 projector 各自 `open` 会争同 derived store；把 shared store ownership 放 factory，borrower close no-op。
7. **Graph 一次失败永久 latch**：现有 lazy `storeFactory` 失败后本 Runtime 不重试；managed shared proxy/manager 必须绕开或显式改变并测试该语义。
8. **direct lazy behavior 退化**：composition 抽取后若统一走 managed eager setup，会让普通 MCP open 创建 Graph/Vector artifact，现有测试会失败。
9. **lease heartbeat**：当前 idle host 没有显式 heartbeat；不能把 background FTS tick 当隐式 ownership keepalive。新增 storage-owned `maintainWriterLease()`/定时器，并测试 event-loop stall 后 exact-owner/fence behavior。
10. **terminal failure 仅内存化**：重启会重新 claim，违背 U3；attempt cap 与 status 必须 durable。
11. **FTS hot loop**：failed job 的 `available_at` 未后移；supervisor backoff只降低整个 lane 频率，不能表达 per-job durable retry。
12. **health 欺骗**：当前 aggregator 固定 Graph/Vector disabled；managed health 必须读取实际 config + projector/process status，并保持 canonical-first。
13. **typed mismatch vocabulary 不足**：只用 `INTERNAL_FAILURE` 不能满足 distinct recoverable result；需 additive contract 或经过计划确认的专用 host health contract。
14. **socket path 长度**：data root 越深越容易在 macOS bind 时报错；使用短 hashed path 并测试 100+ 字符 root。
15. **stale cleanup race**：probe 失败后另一个 host 可能重建 endpoint；cleanup 前后必须比较 descriptor/socket identity，且只移除当前观察的 stale artifact。
16. **credential channel confusion**：browser/IPC/approval/preview token 分开生成、存储、schema、validator 和日志 code；不要用一个 bearer 加 audience 字符串冒充隔离。
17. **proxy EOF 杀 host**：不要从 connection cleanup 调 factory close；host shutdown authority 只能来自 launcher/signal/control lifecycle。
18. **自动 replay**：proxy reconnect 后不能重发未确认 mutation；只能由 caller 使用原 idempotency identity 决定是否重试。
19. **snapshot session 绕预算**：每 session 独立 map 但没有 global cap 会被同 UID 页面耗尽；用共享 budget coordinator。
20. **当前 full-suite 已知例外**：U1 check 记录 G5/G6 frozen/digest gate 会因 feature worktree 变更而失败，operator-cli inherited key fixture 也有既存 `KEY_UNAVAILABLE`；U3 验证不得把这些写成绿色，也不要在 partial unit 重生 release artifacts。

### 10. Verification commands

使用仓库已验证的 Node 24.18.0 / pnpm 10.33.2；Node 26 不是本任务的有效 runtime：

```bash
export PATH="/Users/lienli/.nvm/versions/node/v24.18.0/bin:$PATH"
node --version
pnpm --version

pnpm --filter @memo-graph/runtime-host build
pnpm --filter @memo-graph/mcp-server build
pnpm build:runtime
pnpm exec tsc -p tsconfig.json --noEmit
pnpm lint

pnpm exec vitest run \
  tests/contract/mcp.contract.test.ts \
  tests/mcp/direct-mode-characterization.integration.test.ts \
  tests/integration/codex-explicit-loop.integration.test.ts \
  tests/mcp/governance-mutations.integration.test.ts \
  tests/integration/frozen-layered-context-slice.integration.test.ts \
  tests/mcp/context-compiler.test.ts

pnpm exec vitest run \
  tests/mcp/managed-host-proxy.integration.test.ts \
  tests/integration/workbench-host.integration.test.ts \
  tests/recovery/workbench-lifecycle.recovery.test.ts \
  tests/recovery/root-lease.recovery.test.ts \
  tests/storage/projection-schema.integration.test.ts \
  tests/recovery/graph-outage.recovery.test.ts

python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-02-memory-workbench
git diff --check
```

另外要做两个 real-process assertion，普通 unit mock 不能代替：

- 运行中 host + 两个 concurrent stdio proxy 时，root lease/fence 始终只有一个 owner，杀掉任一 proxy 不变化。
- managed CLI 的 module/child spy 证明从启动到退出都没有创建 SQLite worker、Graph/Vector child、browser process 或第二 lease。

full `pnpm test` 可以在 focused gate 后运行，但结果要连同 U1 check 记录的既知 G5/G6 与 operator key exception 原样报告；不得为了让 partial U3 变绿而更新 frozen release artifacts。

### 11. External references

- MCP Transports specification（draft，stdio 为 UTF-8、newline-delimited JSON-RPC，stdout 不得混入非协议输出）：https://modelcontextprotocol.io/specification/draft/basic/transports
- Node.js v24 `node:net` IPC documentation（`net.Socket` 是 Duplex；Unix socket path 在 macOS 常见约 103 bytes，crash 后 pathname 可能残留）：https://nodejs.org/download/release/latest-v24.x/docs/api/net.html
- Node.js v24 `crypto.timingSafeEqual`（只保证固定长度 byte comparison；外围逻辑仍需避免 timing leak）：https://nodejs.org/download/release/latest-v24.x/docs/api/crypto.html
- 版本内 authoritative surface：`@modelcontextprotocol/server@2.0.0` 的本地 `dist/stdio.d.mts:22-29,40-61,76-103`；实现必须以 pinned package 测试为准，而不是假定未来 SDK 行为。
- Runtime baseline：root `package.json` 锁定 Node `>=24 <25`、pnpm `10.33.2`、TypeScript `6.0.3`、Zod `4.4.3`、MCP client/server `2.0.0`。

### 12. Related specs

- `.trellis/tasks/08-02-memory-workbench/prd.md:13-16,31-46,55-64`：one host、distinct startup、immediate authority、authority-first content-free health、direct/managed compatibility。
- `.trellis/tasks/08-02-memory-workbench/design.md:7-17,37-47,55-63`：acyclic ownership、managed supervisor、credential separation、explicit direct/managed mode。
- `docs/plans/2026-08-02-001-feat-memory-workbench-plan.md:429-494`：U3 authoritative scope、files、test scenarios 和 verification。
- `.trellis/tasks/08-02-memory-workbench/research/u1-check.md:13-21`：snapshot 只能保存 ordered identity，不能保存 content/transaction。
- `.trellis/tasks/08-02-memory-workbench/research/u2-check.md:5-14`：correction CAS、single-use approval、receipt replay 和 projection work invariants，managed proxy 必须保持。
- `.trellis/spec/backend/database-guidelines.md`：SQLite authority、single writer、derived projections 和 transaction boundaries。
- `.trellis/spec/backend/error-handling.md`：strict typed failure 与 fail-closed boundary。
- `.trellis/spec/backend/logging-guidelines.md`：content-free structured diagnostics。
- `.trellis/spec/backend/directory-structure.md`：package dependency direction和 composition placement。
- `.trellis/spec/backend/quality-guidelines.md`、`.trellis/spec/guides/cross-layer-thinking-guide.md`：built boundary tests、cross-layer failure matrix、recovery/compatibility proof。

## Caveats / Not Found

- `packages/runtime-host` 当前不存在；没有可直接复用的 host/descriptor/session/supervisor implementation。
- 未找到真实 Unix-socket MCP framing、cancel、half-close 或 multi-proxy characterization；现有 contract test 只证明 SDK symbols 存在。raw framing 可行性来自 pinned SDK surface，尚不是本仓库的完成证据。
- 未找到 host descriptor、IPC protocol、machine credential 或 stale authenticated probe 的现有 schema；U3 需要新建 strict internal contracts。
- 未找到 durable generic/FTS terminal-failure 状态，也未找到 retryable-vs-terminal counts；这是 U3 requirement 的实际阻塞项，不是 supervisor 参数调优。
- 未找到能够表达 `runtime_owner`/`background_work` 与各类 attach mismatch 的现有 public health vocabulary。若不做 additive contracts 变更，只能得到不满足 PRD 的 `INTERNAL_FAILURE`。
- 未找到 public root lease heartbeat API；现有 heartbeat 仅发生在 protected writer admission。需要 storage-owned maintenance seam 或经明确验证的等价设计。
- U4 才拥有 launch lock、loopback HTTP、browser bootstrap 与 app process lifecycle；U3 研究没有把这些提前并入 runtime-host。
- v1 physically qualified target 是 macOS；Node API 保留跨平台 seam 不等于 Linux/Windows packaged evidence。

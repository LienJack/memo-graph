# Claim Map

| Claim | 类型 | 重要性 | 状态 | 置信度 | 证据 | 判断 |
| --- | --- | --- | --- | ---: | --- | --- |
| `CLf4cce517dc1a` | judgment | core | supported | 0.98 | Cb69fd4e79214, C36b806033928, C5a02e3620ebd | M2 应继承 M1B 的 SQLite 单写者事务、幂等键、outbox、receipt 和 append-only Context 基线，仅新增 L1 governance control plane；L0 evidence 仍是来源权威。 |
| `CL0e365e068e24` | judgment | core | supported | 0.96 | Ca31dcb595a63, W058ef67ec781 | 候选准入必须基于已持久化 evidence authority、sensitivity、scope 与 injection-risk 形成确定性 decision；低权威或外部指令型内容不得直接激活为 procedural/core memory。 |
| `CL2c309f177306` | fact | core | supported | 0.99 | Ca31dcb595a63 | 每个 active L1 revision 必须同时拥有 live evidence lineage 和 persisted AdmissionDecision；需要用户确认的候选只有 user-stated authority 的显式确认才能激活。 |
| `CLa4a573920fea` | judgment | core | supported | 0.97 | C11d4bf9ebec4, W0f32b54f0bcc | 逻辑记忆应使用稳定 memory_id 与不可变 revision；active pointer 的推进必须把 expected_revision_id 放入同一 BEGIN IMMEDIATE 事务的条件 UPDATE，并以 exactly-one-row 结果作为 CAS 成功证明。 |
| `CLd741275f5305` | judgment | core | supported | 0.96 | Ca31dcb595a63, C11d4bf9ebec4 | 纠正必须在 canonical successor 与旧 revision suppression 同一事务中同步生效，然后通过 outbox 异步清理 FTS/Context 等派生物；不可变 Context 不能被当作在线权威。 |
| `CL54379d5d5bd0` | judgment | core | supported | 0.98 | C481781553210, Cd74944d3ea17, C773150f379ca, W6b5690426c7e, W90b57f7dd042 | memory_delete 必须先提交 durable tombstone 并让所有在线读取 hard-filter，再由可重试 Purge Saga 清理 canonical payload、FTS、Context、blob、export 和 backup policy；任何残留债务都保持 tombstone 且 PurgeReceipt.completed=false。 |
| `CL8865c6147ee9` | fact | core | supported | 0.99 | Cc8bbbd43ab1a, C62db98fb9373, W42754b59f310 | 当前 backup 是 ledger 的一致 snapshot，当前 restore 只验证 snapshot 内 epoch/receipt/blob，因此 M2 必须引入 snapshot 外可比较的 tombstone frontier；旧备份落后时只能拒绝或前向重放，不能直接恢复服务。 |
| `CL63ef4c228d41` | judgment | core | supported | 0.97 | W6b5690426c7e, W90b57f7dd042 | G2 的物理残留检查需要在删除 payload 前启用 SQLite core secure_delete，并对 FTS5 启用相应 secure-delete/rebuild 策略；仅删除逻辑行而保留 freelist 或旧 FTS segment 不足以宣称 purge complete。 |
| `CL3df6bc446a42` | judgment | core | supported | 0.98 | C12af3fd5b335, Wbfba858067cc | MCP tool annotations 只能作为客户端提示，重要/破坏性 mutation 的授权必须由 Runtime 根据 principal、scope、expected revision 和逐次确认执行；客户端应保留拒绝调用的 human-in-the-loop。 |
| `CL097e6dc03152` | judgment | core | supported | 0.97 | Ca31dcb595a63, C12af3fd5b335, C481781553210 | pin、demote、usage block、revoke 和 delete 必须是不同 mutation：pin 只影响保留/选择且不提升 authority，usage block 控制 Context，revoke 立即 hard-filter，delete 额外启动 tombstone/Purge Saga；每项都返回可重放 receipt。 |

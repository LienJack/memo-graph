# RQ001

- 状态：`answered`
- 优先级：`high`
- 父问题：`无`
- 依赖问题：无
- 搜索预算：未设置

## 问题

在现有 Agent Memory Runtime 中，怎样以可验证、可恢复的方式实现 L1 候选准入、不可变修订、用户控制和删除不复活？

## 验收条件

- 形成覆盖候选准入、CAS 修订、纠正抑制、用户控制、Purge Saga 和 G2 的 Claim/Evidence 交接
- 每个核心结论至少绑定当前 commit 的代码证据或一手技术证据

## 关联证据

- `Cb69fd4e79214` · context · M2 继承单 writer、WAL、FULL synchronous、migration evidence 和 projection health 基线
- `C36b806033928` · context · M1 权威账本已有 append-only evidence、idempotency、outbox 和 backup manifest 基础表
- `C5a02e3620ebd` · context · M1 已持久化 Context 和 retrieval receipt 且附加 append-only triggers，M2 删除必须显式处理派生物

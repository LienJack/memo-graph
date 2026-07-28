# RQ004

- 状态：`answered`
- 优先级：`high`
- 父问题：`RQ001`
- 依赖问题：RQ003
- 搜索预算：未设置

## 问题

tombstone-first Purge Saga 怎样清理 canonical、FTS、Context、blob、export 与 backup 边界并阻止旧备份复活？

## 验收条件

- 定义已知存储清单、残留债务、重试语义、tombstone frontier 和恢复拒绝条件

## 关联证据

- `C481781553210` · supports · MutationReceipt 和 PurgeReceipt 已定义投影工作、tombstone epoch、store inventory 与 residual debt
- `Cc8bbbd43ab1a` · implementation · 当前 backup 只冻结 ledger epoch、receipt、migration 和 blob inventory，尚未携带 tombstone frontier
- `C62db98fb9373` · implementation · 当前 restore 只校验 snapshot 内 epoch、receipt 和 blob 数，不能与 live tombstone frontier 比较
- `Cd74944d3ea17` · implementation · FTS 由 outbox 投影且可重建，但 rebuild 目前会从全部 inline evidence 重建，必须增加 tombstone hard filter
- `C773150f379ca` · implementation · Context slice 与 receipt 作为不可变派生物持久化，删除需要通过 suppression/invalidation 阻止继续使用并记录清理结果
- `W6b5690426c7e` · supports · 删除页覆写、freelist 与 VACUUM 边界
- `W90b57f7dd042` · supports · FTS 删除、rebuild 与 secure-delete 配置边界
- `W42754b59f310` · supports · backup 是源数据库某时刻 snapshot，因此恢复必须叠加 tombstone frontier

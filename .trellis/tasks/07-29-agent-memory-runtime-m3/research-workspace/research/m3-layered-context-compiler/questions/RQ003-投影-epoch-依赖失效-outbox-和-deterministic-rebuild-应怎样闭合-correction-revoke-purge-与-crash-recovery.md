# RQ003

- 状态：`answered`
- 优先级：`high`
- 父问题：`RQ001`
- 依赖问题：无
- 搜索预算：未设置

## 问题

投影 epoch、依赖失效、outbox 和 deterministic rebuild 应怎样闭合 correction、revoke、purge 与 crash recovery？

## 验收条件

- 给出 source frontier、descendant invalidation、幂等重建和故障恢复契约，并定位当前 M2 可复用边界

## 关联证据

- `C5c36739b0d94` · implementation · M2 already provides durable outbox claim/process/fail mechanics and source revalidation before projection insertion, which can anchor M3 projectors.
- `C3545d567db35` · implementation · FTS rebuild is transactionally reconstructed from canonical current eligible rows in stable order and advances projection state, establishing a reusable rebuild convention.
- `C48a102dc6876` · implementation · The purge projection stage currently covers FTS work and projection frontier only; M3 must register and verify new descendants without weakening nine-store purge completeness.
- `W82e962a8f323` · supports · Peer-reviewed primary source for ordered deltas and view maintenance.
- `C900dd92d403e` · supports · Canonical revalidation already gates runtime candidates.

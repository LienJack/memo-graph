# RQ004

- 状态：`answered`
- 优先级：`high`
- 父问题：`RQ001`
- 依赖问题：无
- 搜索预算：未设置

## 问题

多路召回应如何执行 hard filter、lane retrieval、冲突呈现、去重、排序和硬预算打包？

## 验收条件

- 冻结 lane 顺序、过滤/重校验边界、冲突和约束保留规则，以及 deterministic tie-break

## 关联证据

- `C7f9b788de747` · implementation · The current compiler accepts only L0/L1 candidates, validates request scope, and already exposes typed exclusions/degraded lanes; M3 must extend rather than bypass this boundary.
- `Ce117a6da657f` · implementation · The baseline deterministically sorts, deduplicates L0 under governed L1, enforces a hard global token budget, freezes hashes, and seals inclusion/exclusion receipts, but has no lane quotas or L2/L3 candidates.
- `C900dd92d403e` · implementation · Runtime recall currently merges only exact-scope L0 FTS and canonically governed L1, names degraded lanes, and removes L0 duplicates covered by L1.
- `W472a9d6c24aa` · context · Primary preprint; supports retrieval and update patterns but not authority semantics.
- `C355361c39adf` · supports · Relation revisions preserve provenance for conflict presentation.
- `C48a102dc6876` · supports · Purge state must gate every lane.
- `Wabddfee3f031` · context · Benchmark separates indexing, retrieval, and reading controls.
- `W485e500bd8f8` · supports · Long-context position sensitivity supports strict packing.
- `W7ef376e6ce94` · context · Virtual-context tiers motivate independent bounded lanes.

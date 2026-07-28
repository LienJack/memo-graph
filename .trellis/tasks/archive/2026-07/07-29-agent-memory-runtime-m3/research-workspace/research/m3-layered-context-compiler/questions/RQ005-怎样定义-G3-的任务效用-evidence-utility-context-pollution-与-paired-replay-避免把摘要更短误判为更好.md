# RQ005

- 状态：`answered`
- 优先级：`high`
- 父问题：`RQ001`
- 依赖问题：无
- 搜索预算：未设置

## 问题

怎样定义 G3 的任务效用、evidence utility、context pollution 与 paired replay，避免把摘要更短误判为更好？

## 验收条件

- 定义 baseline/layered/no-projection arms、case families、指标、阈值、holdout/transfer 和硬 No-Go

## 关联证据

- `Cc174b604fbab` · supports · The frozen corpus already separates calibration, holdout, and transfer risks for normal preference, conflict, correction, privacy, temporal, deletion, injection, multi-hop, projection failure, negative transfer, and policy exclusion.
- `Wabddfee3f031` · supports · Primary benchmark paper for capability coverage and staged evaluation.
- `W485e500bd8f8` · supports · Peer-reviewed primary source for position sensitivity and long-context degradation.
- `C48a102dc6876` · supports · Deletion and projection cleanup define safety fixtures.
- `C900dd92d403e` · supports · Current recall behavior is the paired baseline.
- `C62bf6d199856` · supports · Performance envelope supplies SLO and profile boundaries.
- `Wefc9ff30e069` · supports · Component ablation supports per-lane attribution.

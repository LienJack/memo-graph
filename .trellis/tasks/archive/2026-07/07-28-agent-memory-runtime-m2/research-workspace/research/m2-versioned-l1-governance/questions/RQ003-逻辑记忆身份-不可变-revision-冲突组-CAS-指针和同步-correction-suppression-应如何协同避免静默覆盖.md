# RQ003

- 状态：`answered`
- 优先级：`high`
- 父问题：`RQ001`
- 依赖问题：RQ002
- 搜索预算：未设置

## 问题

逻辑记忆身份、不可变 revision、冲突组、CAS 指针和同步 correction suppression 应如何协同避免静默覆盖？

## 验收条件

- 覆盖并发 successor、重复请求幂等、旧 revision 默认召回排除和纠正即时生效

## 关联证据

- `C11d4bf9ebec4` · implementation · 现有 writer 使用 BEGIN IMMEDIATE、双重幂等检查、事务内 ledger/outbox/receipt 提交，可复用为 L1 mutation 原子边界
- `W0f32b54f0bcc` · supports · 事务原子性、单写者与 BEGIN IMMEDIATE 边界
- `Ca31dcb595a63` · supports · revision and admission contract informs correction semantics

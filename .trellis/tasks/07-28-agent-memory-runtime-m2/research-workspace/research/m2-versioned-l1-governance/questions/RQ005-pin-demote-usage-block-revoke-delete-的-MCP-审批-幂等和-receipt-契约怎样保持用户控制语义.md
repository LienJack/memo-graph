# RQ005

- 状态：`answered`
- 优先级：`high`
- 父问题：`RQ001`
- 依赖问题：RQ002、RQ003
- 搜索预算：未设置

## 问题

pin、demote、usage block、revoke、delete 的 MCP 审批、幂等和 receipt 契约怎样保持用户控制语义？

## 验收条件

- 证明 pin 不提升 authority，usage block 阻止 Context，revoke/delete 不可被默认 recall 绕过

## 关联证据

- `C12af3fd5b335` · supports · 工具安全分级、幂等键、expected revision 与 dry-run 是 M2 mutation envelope 基线
- `Wbfba858067cc` · supports · tool annotations 是 hints 且客户端应在工具调用中保留用户确认能力
- `Ca31dcb595a63` · supports · memory lifecycle invariants constrain user controls
- `C481781553210` · supports · receipt contracts apply to control mutations and delete

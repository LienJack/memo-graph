import type { RecoveryKind } from "../app/recovery-state.js";

export type MemoryFixture = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  scope: string;
  updatedAt: string;
  status: "current" | "historical";
};

export const MEMORY_FIXTURES: readonly MemoryFixture[] = [
  {
    id: "mem_workbench_direction",
    eyebrow: "产品方向",
    title: "记忆工作台是默认入口",
    body: "启动后首先进入可治理的记忆浏览，Graph 与运行状态作为同级视图。",
    scope: "workspace:memo-graph",
    updatedAt: "刚刚验证",
    status: "current",
  },
  {
    id: "mem_authority_boundary",
    eyebrow: "治理边界",
    title: "证据与历史保持只读",
    body: "纠正产生新修订和用户反馈证据，不覆盖旧内容，也不把派生关系提升为权威。",
    scope: "topic:memory-governance",
    updatedAt: "8 分钟前",
    status: "current",
  },
  {
    id: "mem_runtime_health",
    eyebrow: "运行约束",
    title: "仪表盘以 canonical authority 为首",
    body: "Runtime、Graph 和后台任务状态从属于 canonical storage，首版仪表盘不提供操作按钮。",
    scope: "workspace:memo-graph",
    updatedAt: "21 分钟前",
    status: "current",
  },
];

export const STATE_MESSAGES: Record<RecoveryKind, string> = {
  "initial-loading": "正在验证本地 Runtime 与记忆权限…",
  refreshing: "正在刷新权威快照，当前内容暂时保留。",
  ready: "已连接当前 Runtime，显示可召回的权威记忆。",
  "ready-empty": "这个范围已验证，但还没有可召回记忆。",
  "filtered-empty": "当前筛选没有结果；这不代表记忆库为空。",
  "governance-excluded": "有记录因治理规则未显示，内容不会在这里泄露。",
  truncated: "结果已达到安全边界，仍可按游标继续读取。",
  degraded: "Canonical 记忆可用，但部分投影服务正在降级。",
  blocked: "Runtime 处于阻断模式；仅运行状态可用于诊断。",
  unauthorized: "当前页面没有读取权限，请重新打开工作台。",
  expired: "页面授权已过期，草稿仍只保留在本页内存中。",
  disconnected: "与 Runtime 的连接已断开，旧内容不再表示当前状态。",
  "stale-instance": "Runtime 已重启；此页面属于旧实例。",
  failed: "请求失败，未确认任何新的权威内容。",
};

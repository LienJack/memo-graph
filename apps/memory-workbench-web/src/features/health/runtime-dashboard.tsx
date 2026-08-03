import { useEffect, useRef, useState } from "react";

import type {
  WorkbenchHealthComponent,
  WorkbenchHealthResult,
} from "@memo-graph/contracts/workbench";

import { RequestCoordinator } from "../../api/request-coordinator.js";
import type { MemoryWorkbenchApi } from "../memories/api.js";

type Phase = "loading" | "ready" | "stale" | "unavailable";

const COMPONENT_LABEL = {
  canonical_storage: "Canonical storage",
  runtime_owner: "Runtime owner",
  fts_projection: "FTS projection",
  layered_projection: "Layered projection",
  graph_projection: "Graph projection",
  background_work: "Background work",
} as const;

const STATE_LABEL = {
  healthy: "健康",
  lagging: "滞后",
  degraded: "降级",
  failed: "失败",
  unavailable: "无观察",
} as const;

const SCOPE_LABEL = {
  canonical_root: "canonical root",
  runtime_instance: "current Runtime instance",
  configured_scopes: "all configured scopes",
} as const;

const GUIDANCE_LABEL = {
  NONE: "无需操作",
  REOPEN_WORKBENCH: "重新打开工作台以建立新的 Runtime 会话",
  CHECK_RUNTIME_CONFIG: "检查 Runtime 配置是否启用了对应投影",
  WAIT_FOR_PROJECTION: "等待受管后台任务收敛；canonical 权威不受影响",
  INSPECT_PROJECTION_LOGS: "检查投影诊断；不要直接修改派生数据",
  INSPECT_BACKGROUND_LOGS: "检查后台任务诊断与终止失败",
  PROTECT_CANONICAL_DATA: "停止依赖当前内容并检查 canonical 存储恢复路径",
} as const;

export function RuntimeDashboard({ api }: { api: MemoryWorkbenchApi }) {
  const [health, setHealth] = useState<WorkbenchHealthResult | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const coordinator = useRef(new RequestCoordinator());
  const retained = useRef<WorkbenchHealthResult | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = (): void => {
      void coordinator.current.run((signal) => api.health(signal)).then((result) => {
        if (result.status === "superseded") return;
        retained.current = result.value;
        setHealth(result.value);
        setPhase(
          Date.now() >= Date.parse(result.value.stale_after)
            ? "stale"
            : "ready",
        );
      }).catch(() => {
        setHealth(retained.current);
        setPhase(retained.current === null ? "unavailable" : "stale");
      });
    };
    poll();
    timer = setInterval(poll, 5_000);
    return () => {
      if (timer !== null) clearInterval(timer);
      coordinator.current.cancel();
    };
  }, [api]);

  return (
    <section className="runtime-dashboard" aria-labelledby="runtime-heading">
      <header className="feature-intro runtime-intro">
        <p className="eyebrow">AUTHORITY FIRST · READ ONLY</p>
        <h2 id="runtime-heading">运行状态层级</h2>
        <p>Canonical storage 决定权威可用性；Runtime、投影与后台任务只提供从属观察，不拥有记忆内容。</p>
      </header>

      {phase === "loading" ? (
        <p className="health-fetch-state" role="status">正在读取当前 Runtime 观察…</p>
      ) : null}
      {phase === "unavailable" ? (
        <div className="health-fetch-state health-fetch-failed" role="status">
          <strong>当前没有可信健康观察</strong>
          <p>页面不会把缺失响应解释为健康；请从终端重新打开当前工作台实例。</p>
        </div>
      ) : null}
      {phase === "stale" && health !== null ? (
        <div className="health-stale-notice" role="status">
          正在保留最后一次观察；它已过期，不能代表当前 Runtime 状态。
        </div>
      ) : null}

      {health === null ? null : (
        <div className="health-hierarchy" data-stale={phase === "stale"}>
          <HealthComponentCard component={health.canonical} primary />

          <section className="health-tier" aria-labelledby="runtime-owner-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">RUNTIME OWNERSHIP</p>
                <h3 id="runtime-owner-heading">单一运行实例</h3>
              </div>
              <ObservationTime value={health.observed_at} />
            </div>
            <HealthComponentCard component={health.runtime} />
          </section>

          <section className="health-tier" aria-labelledby="projection-health-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">DERIVED · NON-AUTHORITATIVE</p>
                <h3 id="projection-health-heading">派生投影</h3>
              </div>
              <span>{health.projections.length} 个观察</span>
            </div>
            <div className="projection-health-grid">
              {health.projections.map((component) => (
                <HealthComponentCard component={component} key={component.component} />
              ))}
            </div>
          </section>

          <section className="health-tier" aria-labelledby="background-health-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">SUPERVISED WORK</p>
                <h3 id="background-health-heading">后台任务</h3>
              </div>
              <span>{health.lanes.length} 条 lane</span>
            </div>
            <HealthComponentCard component={health.background} />
            <div className="health-table-wrap">
              <table className="health-lanes">
                <caption className="sr-only">后台任务的内容无关运行指标</caption>
                <thead>
                  <tr>
                    <th scope="col">Lane</th>
                    <th scope="col">状态</th>
                    <th scope="col">完成</th>
                    <th scope="col">重试</th>
                    <th scope="col">终止</th>
                    <th scope="col">最近成功</th>
                  </tr>
                </thead>
                <tbody>
                  {health.lanes.map((lane) => (
                    <tr key={lane.lane}>
                      <th scope="row"><code>{lane.lane}</code></th>
                      <td><HealthState state={lane.state} /></td>
                      <td>{lane.completed}</td>
                      <td>{lane.retrying}</td>
                      <td>{lane.terminal}</td>
                      <td>{lane.last_success_at === null ? "尚无观察" : formatTime(lane.last_success_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="read-only-note">
            此仪表盘只执行认证 GET 轮询，不提供 retry、rebuild、backup、restore、cleanup 或 key 操作。
          </p>
        </div>
      )}
    </section>
  );
}

function HealthComponentCard({
  component,
  primary = false,
}: {
  component: WorkbenchHealthComponent;
  primary?: boolean;
}) {
  return (
    <article
      className={primary ? "health-component health-authority" : "health-component"}
      data-health-state={component.state}
    >
      <div className="health-component-heading">
        <div>
          <span>{COMPONENT_LABEL[component.component]}</span>
          <small>{component.authority_plane} · {SCOPE_LABEL[component.observation_scope]}</small>
        </div>
        <HealthState state={component.state} />
      </div>
      {primary ? <h3>Canonical authority</h3> : null}
      <p>{component.reason_code ?? "当前观察未发现阻塞原因。"}</p>
      <p className="health-guidance">{GUIDANCE_LABEL[component.guidance_code]}</p>
      {component.metrics.length > 0 ? (
        <dl className="health-metrics">
          {component.metrics.map((metric) => (
            <div key={metric.name}>
              <dt>{metric.name.replaceAll("_", " ")}</dt>
              <dd>{formatMetric(metric.value, metric.unit)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <ObservationTime value={component.observed_at} />
    </article>
  );
}

function HealthState({ state }: { state: WorkbenchHealthComponent["state"] }) {
  return <span className="health-state" data-state={state}>{STATE_LABEL[state]}</span>;
}

function ObservationTime({ value }: { value: string | null }) {
  return <time className="health-observed" dateTime={value ?? undefined}>{value === null ? "无观察时间" : `观察于 ${formatTime(value)}`}</time>;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatMetric(value: number, unit: "count" | "epoch" | "bytes" | "milliseconds"): string {
  if (unit === "bytes") {
    return new Intl.NumberFormat("zh-CN", {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 1,
    }).format(value / (1024 * 1024));
  }
  if (unit === "milliseconds") return `${value.toLocaleString("zh-CN")} ms`;
  if (unit === "epoch") return `epoch ${value.toLocaleString("zh-CN")}`;
  return value.toLocaleString("zh-CN");
}

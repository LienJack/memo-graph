import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MEMORY_FIXTURES, STATE_MESSAGES, type MemoryFixture } from "../api/fixture-api.js";
import { FocusDialog } from "./focus-dialog.js";
import type { MemoryWorkbenchApi } from "../features/memories/api.js";
import { GovernedMemoryBrowser } from "../features/memories/memory-browser.js";
import {
  canMutate,
  recoveryPolicy,
  type RecoveryKind,
  type RecoveryState,
} from "./recovery-state.js";
import {
  parseStructuralUrl,
  urlForMemoryStructure,
  urlForView,
  type WorkbenchView,
} from "./url-state.js";

export type AppProps = {
  initialRecoveryKind?: RecoveryKind;
  initialUrl?: string;
  api?: MemoryWorkbenchApi;
};

const NAVIGATION: readonly { view: WorkbenchView; label: string; meta: string }[] = [
  { view: "memory", label: "记忆", meta: "浏览与治理" },
  { view: "graph", label: "Graph", meta: "关系视图" },
  { view: "runtime", label: "运行仪表盘", meta: "只读健康状态" },
];

export function App({ api, initialRecoveryKind = "ready", initialUrl }: AppProps) {
  const startingUrl = useMemo(
    () => new URL(initialUrl ?? window.location.href),
    [initialUrl],
  );
  const parsedStart = useMemo(() => parseStructuralUrl(startingUrl), [startingUrl]);
  const [view, setView] = useState<WorkbenchView>(parsedStart.state.view);
  const [structure, setStructure] = useState(parsedStart.state);
  const [searchText, setSearchText] = useState("");
  const [recovery, setRecovery] = useState<RecoveryState<readonly MemoryFixture[]>>(
    () => recoveryState(initialRecoveryKind),
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [dirtyDraft, setDirtyDraft] = useState(false);
  const [liveAuthority, setLiveAuthority] = useState<
    "verified" | "checking" | "unavailable"
  >(api === undefined ? "verified" : "checking");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (initialUrl === undefined && parsedStart.changed) {
      window.history.replaceState(null, "", parsedStart.sanitizedUrl);
    }
  }, [initialUrl, parsedStart]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [view]);

  const navigate = useCallback(
    (next: WorkbenchView): void => {
      if (
        dirtyDraft &&
        next !== "memory" &&
        !window.confirm("当前纠正草稿尚未提交。离开会丢弃草稿，是否继续？")
      ) {
        return;
      }
      if (next !== "memory") {
        setDirtyDraft(false);
      }
      setView(next);
      setStructure((current) => ({ ...current, view: next }));
      setAnnouncement(`已切换到${labelForView(next)}`);
      if (initialUrl === undefined) {
        const nextUrl = urlForView(new URL(window.location.href), next);
        window.history.pushState(null, "", nextUrl);
      }
    },
    [dirtyDraft, initialUrl],
  );

  const visibleMemories = useMemo(() => {
    const normalized = searchText.trim().toLocaleLowerCase("zh-CN");
    if (normalized.length === 0) {
      return MEMORY_FIXTURES;
    }
    return MEMORY_FIXTURES.filter((memory) =>
      [memory.title, memory.body, memory.scope]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(normalized),
    );
  }, [searchText]);

  const effectiveRecovery =
    recovery.kind === "ready" && searchText.trim().length > 0 && visibleMemories.length === 0
      ? recoveryState("filtered-empty")
      : recovery;
  const authority = api === undefined
    ? authoritySummary(effectiveRecovery.kind)
    : liveAuthoritySummary(liveAuthority);

  return (
    <div className="workbench-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar" aria-label="记忆工作台导航">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">M</span>
          <div>
            <strong>MEMO GRAPH</strong>
            <span>记忆工作台</span>
          </div>
        </div>
        <nav aria-label="一级视图">
          <ul className="nav-list">
            {NAVIGATION.map((entry) => (
              <li key={entry.view}>
                <a
                  aria-current={view === entry.view ? "page" : undefined}
                  href={urlForView(startingUrl, entry.view).href}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(entry.view);
                  }}
                >
                  <span>{entry.label}</span>
                  <small>{entry.meta}</small>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="authority-card" data-authority={authority.state}>
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>{authority.label}</strong>
            <span>{authority.detail}</span>
          </div>
        </div>
      </aside>

      <main id="main-content" className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">LOCAL · GOVERNED · READABLE</p>
            <h1 ref={headingRef} tabIndex={-1}>{labelForView(view)}</h1>
          </div>
          <button
            className="button-quiet"
            onClick={() => setDialogOpen(true)}
            ref={dialogTriggerRef}
            type="button"
          >
            视图说明
          </button>
        </header>

        {view === "memory" ? (
          api === undefined ? (
            <MemoryView
              recovery={effectiveRecovery}
              searchText={searchText}
              setRecovery={setRecovery}
              setSearchText={setSearchText}
              visibleMemories={visibleMemories}
              onOpenHealth={() => navigate("runtime")}
            />
          ) : (
            <GovernedMemoryBrowser
              api={api}
              onAuthorityChange={setLiveAuthority}
              onDirtyChange={setDirtyDraft}
              onOpenHealth={() => navigate("runtime")}
              onStructureChange={(next) => {
                setStructure((current) => ({
                  ...current,
                  scopeKind: next.scope?.kind ?? null,
                  scopeId: next.scope?.id ?? null,
                  selectedMemoryId: next.selectedMemoryId,
                  selectedRevisionId: next.selectedRevisionId,
                  includeNonCurrent: next.includeNonCurrent,
                }));
                if (initialUrl === undefined) {
                  window.history.pushState(
                    null,
                    "",
                    urlForMemoryStructure(
                      new URL(window.location.href),
                      next,
                    ),
                  );
                }
              }}
              structure={structure}
            />
          )
        ) : null}
        {view === "graph" ? <GraphView /> : null}
        {view === "runtime" ? <RuntimeView /> : null}
      </main>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <FocusDialog
        onClose={() => setDialogOpen(false)}
        open={dialogOpen}
        returnFocusTo={dialogTriggerRef.current}
        title={`${labelForView(view)}的权威边界`}
      >
        <p>
          页面只把当前 canonical memory 视为权威。Graph 是受限的解释视图；运行仪表盘只报告状态，不执行重建、重试或清理。
        </p>
      </FocusDialog>
    </div>
  );
}

type MemoryViewProps = {
  recovery: RecoveryState<readonly MemoryFixture[]>;
  searchText: string;
  setRecovery: (state: RecoveryState<readonly MemoryFixture[]>) => void;
  setSearchText: (value: string) => void;
  visibleMemories: readonly MemoryFixture[];
  onOpenHealth: () => void;
};

function MemoryView({
  recovery,
  searchText,
  setRecovery,
  setSearchText,
  visibleMemories,
  onOpenHealth,
}: MemoryViewProps) {
  const policy = recoveryPolicy(recovery);
  const displayed = contentFor(recovery, visibleMemories);
  const stale = policy.contentTreatment === "stale-context";

  return (
    <section aria-labelledby="memory-collection-heading" className="workspace-grid">
      <div className="collection-panel">
        <div className="collection-heading">
          <div>
            <p className="eyebrow">CURRENT EFFECTIVE</p>
            <h2 id="memory-collection-heading">可召回记忆</h2>
          </div>
          <span className="count-chip">{displayed.length} 条</span>
        </div>
        <label className="search-field">
          <span>在当前页面搜索</span>
          <input
            autoComplete="off"
            onChange={(event) => setSearchText(event.currentTarget.value)}
            placeholder="标题、内容或 scope"
            type="search"
            value={searchText}
          />
          <small>搜索文本仅保留在本页，不写入 URL。</small>
        </label>

        <RecoveryNotice
          onClearFilters={() => setSearchText("")}
          onOpenHealth={onOpenHealth}
          onRetry={() => setRecovery(recoveryState("ready"))}
          recovery={recovery}
        />

        {displayed.length > 0 ? (
          <ol className="memory-list" aria-label="记忆结果" data-stale={stale}>
            {displayed.map((memory) => (
              <li key={memory.id}>
                <article className="memory-card">
                  <div className="memory-meta">
                    <span>{memory.eyebrow}</span>
                    <span>{memory.updatedAt}</span>
                  </div>
                  <h3>{memory.title}</h3>
                  <p>{memory.body}</p>
                  <footer>
                    <code>{memory.scope}</code>
                    <span>{stale ? "旧实例上下文" : "当前 · 可治理"}</span>
                  </footer>
                </article>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      <aside className="detail-rail" aria-label="选择与权限摘要">
        <p className="eyebrow">SELECTION</p>
        <h2>先选择一条记忆</h2>
        <p>详情将组合当前修订、历史、来源链与投影状态。证据和历史始终只读。</p>
        <dl className="compact-facts">
          <div><dt>编辑能力</dt><dd>{canMutate(recovery) ? "按目标治理" : "已禁用"}</dd></div>
          <div><dt>分页模型</dt><dd>有界快照</dd></div>
          <div><dt>来源链</dt><dd>可缺失但不伪造</dd></div>
        </dl>
      </aside>
    </section>
  );
}

function RecoveryNotice({
  recovery,
  onClearFilters,
  onOpenHealth,
  onRetry,
}: {
  recovery: RecoveryState<readonly MemoryFixture[]>;
  onClearFilters: () => void;
  onOpenHealth: () => void;
  onRetry: () => void;
}) {
  const policy = recoveryPolicy(recovery);
  const action = policy.primaryAction;
  return (
    <div
      className={`recovery-notice recovery-${recovery.kind}`}
      data-recovery-kind={recovery.kind}
      data-testid={`recovery-${recovery.kind}`}
    >
      <div role="status">
        <strong>{stateLabel(recovery.kind)}</strong>
        <p>{recovery.message}</p>
      </div>
      {action === "clear-filters" ? <button onClick={onClearFilters} type="button">清除筛选</button> : null}
      {action === "open-health" ? <button onClick={onOpenHealth} type="button">查看运行状态</button> : null}
      {action === "retry" ? <button onClick={onRetry} type="button">重试读取</button> : null}
      {action === "reopen" ? <button onClick={onOpenHealth} type="button">重新打开工作台</button> : null}
      {action === "continue" ? <button type="button">继续读取</button> : null}
    </div>
  );
}

function GraphView() {
  return (
    <section className="feature-panel" aria-labelledby="graph-heading">
      <div className="feature-intro">
        <p className="eyebrow">BOUNDED EXPLANATION</p>
        <h2 id="graph-heading">关系图谱</h2>
        <p>画布只是辅助层；所有节点与关系都会保留等价的键盘可访问列表。</p>
      </div>
      <div className="graph-preview" aria-hidden="true">
        <span className="graph-node graph-node-core">记忆治理</span>
        <span className="graph-node graph-node-a">来源链</span>
        <span className="graph-node graph-node-b">纠正流程</span>
        <span className="graph-node graph-node-c">运行状态</span>
      </div>
      <div className="semantic-graph">
        <h3>语义关系列表</h3>
        <ul>
          <li><button type="button">记忆治理 → supported_by → 来源链</button></li>
          <li><button type="button">记忆治理 → depends_on → 纠正流程</button></li>
          <li><button type="button">运行状态 → explains → 投影可用性</button></li>
        </ul>
      </div>
    </section>
  );
}

function RuntimeView() {
  return (
    <section className="feature-panel" aria-labelledby="runtime-heading">
      <div className="feature-intro">
        <p className="eyebrow">AUTHORITY FIRST · READ ONLY</p>
        <h2 id="runtime-heading">运行状态层级</h2>
        <p>Canonical storage 决定权威可用性；Runtime、投影和后台工作是从属观察。</p>
      </div>
      <div className="health-grid">
        <HealthCard label="Canonical storage" status="Ready" detail="当前修订与治理前沿已验证" primary />
        <HealthCard label="Runtime owner" status="Ready" detail="本地实例已连接" />
        <HealthCard label="Graph projection" status="Degraded" detail="只影响关系视图，不改变 canonical authority" />
        <HealthCard label="Background work" status="Observing" detail="队列指标只读，无操作入口" />
      </div>
      <p className="read-only-note">此仪表盘不提供 retry、rebuild、backup、restore、cleanup 或 key 操作。</p>
    </section>
  );
}

function HealthCard({ label, status, detail, primary = false }: { label: string; status: string; detail: string; primary?: boolean }) {
  return (
    <article className={primary ? "health-card health-primary" : "health-card"}>
      <span>{label}</span>
      <strong>{status}</strong>
      <p>{detail}</p>
    </article>
  );
}

function recoveryState(kind: RecoveryKind): RecoveryState<readonly MemoryFixture[]> {
  const message = STATE_MESSAGES[kind];
  switch (kind) {
    case "initial-loading": return { kind, message };
    case "refreshing": return { kind, message, retained: MEMORY_FIXTURES };
    case "ready": return { kind, message, content: MEMORY_FIXTURES };
    case "ready-empty": return { kind, message };
    case "filtered-empty": return { kind, message, filtersApplied: 1 };
    case "governance-excluded": return { kind, message, excludedCount: 3 };
    case "truncated": return { kind, message, retained: MEMORY_FIXTURES, omittedCount: 8 };
    case "degraded": return { kind, message, retained: MEMORY_FIXTURES, reasonCode: "GRAPH_PROJECTION_STALE" };
    case "blocked": return { kind, message, reasonCode: "CANONICAL_STORAGE_BLOCKED" };
    case "unauthorized": return { kind, message };
    case "expired": return { kind, message };
    case "disconnected": return { kind, message, stale: MEMORY_FIXTURES };
    case "stale-instance": return { kind, message, stale: MEMORY_FIXTURES };
    case "failed": return { kind, message, stale: null, retryable: true };
  }
}

function contentFor(state: RecoveryState<readonly MemoryFixture[]>, filtered: readonly MemoryFixture[]): readonly MemoryFixture[] {
  switch (state.kind) {
    case "ready": return filtered;
    case "refreshing":
    case "truncated":
    case "degraded": return state.retained;
    case "disconnected":
    case "stale-instance":
    case "failed": return state.stale ?? [];
    case "initial-loading":
    case "ready-empty":
    case "filtered-empty":
    case "governance-excluded":
    case "blocked":
    case "unauthorized":
    case "expired": return [];
  }
}

function labelForView(view: WorkbenchView): string {
  return NAVIGATION.find((entry) => entry.view === view)?.label ?? "记忆";
}

function stateLabel(kind: RecoveryKind): string {
  return kind.replaceAll("-", " ").toLocaleUpperCase("en-US");
}

function authoritySummary(kind: RecoveryKind): {
  state: "verified" | "checking" | "unavailable";
  label: string;
  detail: string;
} {
  switch (kind) {
    case "ready":
    case "ready-empty":
    case "filtered-empty":
    case "governance-excluded":
    case "truncated":
      return { state: "verified", label: "Canonical authority", detail: "当前实例已验证" };
    case "degraded":
      return { state: "verified", label: "Canonical authority", detail: "权威可用 · 投影降级" };
    case "initial-loading":
    case "refreshing":
      return { state: "checking", label: "Authority check", detail: "正在验证当前实例" };
    case "blocked":
    case "unauthorized":
    case "expired":
    case "disconnected":
    case "stale-instance":
    case "failed":
      return { state: "unavailable", label: "Authority unavailable", detail: "当前内容不具权威性" };
  }
}

function liveAuthoritySummary(
  state: "verified" | "checking" | "unavailable",
): {
  state: "verified" | "checking" | "unavailable";
  label: string;
  detail: string;
} {
  if (state === "verified") {
    return {
      state,
      label: "Canonical authority",
      detail: "当前实例已验证",
    };
  }
  if (state === "checking") {
    return {
      state,
      label: "Authority check",
      detail: "正在验证当前实例",
    };
  }
  return {
    state,
    label: "Authority unavailable",
    detail: "当前内容不具权威性",
  };
}

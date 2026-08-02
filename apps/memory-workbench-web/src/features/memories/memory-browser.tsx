import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  WorkbenchMemoryDetailResult,
  WorkbenchMemoryListRequest,
  WorkbenchMemoryListResult,
  WorkbenchMemorySummary,
} from "@memo-graph/contracts/workbench";

import { WorkbenchApiError } from "../../api/client.js";
import { RequestCoordinator } from "../../api/request-coordinator.js";
import type { StructuralUrlState } from "../../app/url-state.js";
import { CorrectionPanel } from "../corrections/correction-panel.js";
import type { MemoryWorkbenchApi } from "./api.js";

type ListState =
  | { kind: "loading"; items: readonly WorkbenchMemorySummary[] }
  | {
      kind: "ready" | "degraded";
      items: readonly WorkbenchMemorySummary[];
      nextCursor: string | null;
      omittedCount: number;
      excludedCount: number;
      warnings: readonly string[];
    }
  | {
      kind: "empty" | "filtered-empty" | "excluded";
      items: readonly WorkbenchMemorySummary[];
      excludedCount: number;
      reasonCodes: readonly string[];
    }
  | {
      kind: "blocked" | "unauthorized" | "failed" | "stale";
      items: readonly WorkbenchMemorySummary[];
      reasonCode: string;
      retryable: boolean;
    };

export function GovernedMemoryBrowser({
  api,
  structure,
  onStructureChange,
  onOpenHealth,
  onDirtyChange,
  onAuthorityChange,
}: {
  api: MemoryWorkbenchApi;
  structure: StructuralUrlState;
  onStructureChange(next: {
    scope: { kind: StructuralUrlState["scopeKind"]; id: string } | null;
    selectedMemoryId: string | null;
    selectedRevisionId: string | null;
    includeNonCurrent: boolean;
  }): void;
  onOpenHealth(): void;
  onDirtyChange(dirty: boolean): void;
  onAuthorityChange(state: "verified" | "checking" | "unavailable"): void;
}) {
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState<string | null>(null);
  const [list, setList] = useState<ListState>({ kind: "loading", items: [] });
  const [detail, setDetail] = useState<WorkbenchMemoryDetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [knownGroupOptions, setKnownGroupOptions] = useState<GroupOption[]>([]);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const listCoordinator = useRef(new RequestCoordinator());
  const detailCoordinator = useRef(new RequestCoordinator());
  const detailLoadingGeneration = useRef(0);
  const listItems = useRef<readonly WorkbenchMemorySummary[]>([]);

  const request = useMemo<WorkbenchMemoryListRequest>(() => ({
    query: appliedSearch,
    scope:
      structure.scopeKind === null || structure.scopeId === null
        ? null
        : { kind: structure.scopeKind, id: structure.scopeId },
    include_non_current: structure.includeNonCurrent,
    limit: 40,
  }), [
    appliedSearch,
    structure.includeNonCurrent,
    structure.scopeId,
    structure.scopeKind,
  ]);

  const loadList = useCallback(async (
    nextRequest: WorkbenchMemoryListRequest,
    append = false,
  ): Promise<void> => {
    const retained = append ? listItems.current : [];
    setList((current) => ({
      kind: "loading",
      items: append ? current.items : [],
    }));
    try {
      const coordinated = await listCoordinator.current.run((signal) =>
        api.listMemories(nextRequest, signal),
      );
      if (coordinated.status === "superseded") {
        return;
      }
      setList(listState(coordinated.value, retained));
    } catch (error) {
      setList((current) => apiFailureState(error, current.items));
    }
  }, [api]);

  useEffect(() => {
    listItems.current = list.items;
  }, [list.items]);

  useEffect(() => {
    const observed = uniqueGroups(list.items);
    if (observed.length === 0) {
      return;
    }
    setKnownGroupOptions((current) => mergeGroupOptions(current, observed));
  }, [list.items]);

  const loadDetail = useCallback(async (
    memoryId: string,
    revisionId: string | null = null,
  ): Promise<WorkbenchMemoryDetailResult | null> => {
    const loadingGeneration = ++detailLoadingGeneration.current;
    setDetailLoading(true);
    try {
      const coordinated = await detailCoordinator.current.run((signal) =>
        api.memoryDetail(memoryId, revisionId, signal),
      );
      if (coordinated.status === "superseded") {
        return null;
      }
      setDetail(coordinated.value);
      return coordinated.value;
    } catch (error) {
      const reasonCode = error instanceof WorkbenchApiError
        ? error.code
        : "DETAIL_REQUEST_FAILED";
      const failed: WorkbenchMemoryDetailResult = {
        status: "failed",
        reason_code: reasonCode,
        retryable: true,
        warnings: [],
      };
      setDetail(failed);
      return failed;
    } finally {
      if (loadingGeneration === detailLoadingGeneration.current) {
        setDetailLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadList(request);
    return () => listCoordinator.current.cancel();
  }, [loadList, request]);

  useEffect(() => {
    if (structure.selectedMemoryId !== null) {
      void loadDetail(
        structure.selectedMemoryId,
        structure.selectedRevisionId,
      );
    } else {
      detailLoadingGeneration.current += 1;
      detailCoordinator.current.cancel();
      setDetail(null);
      setDetailLoading(false);
    }
    return () => detailCoordinator.current.cancel();
  }, [
    loadDetail,
    structure.selectedMemoryId,
    structure.selectedRevisionId,
  ]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onAuthorityChange(
      list.kind === "loading"
        ? "checking"
        : ["ready", "degraded", "empty", "filtered-empty", "excluded"].includes(list.kind)
          ? "verified"
          : "unavailable",
    );
  }, [list.kind, onAuthorityChange]);

  const groups = useMemo(() => groupMemories(list.items), [list.items]);
  const selectedScope = structure.scopeKind === null || structure.scopeId === null
    ? ""
    : `${structure.scopeKind}:${structure.scopeId}`;
  const groupOptions = useMemo(() => mergeGroupOptions(
    knownGroupOptions,
    structure.scopeKind === null || structure.scopeId === null
      ? []
      : [{
          value: selectedScope,
          label: `已选范围 · ${selectedScope}`,
          scope: { kind: structure.scopeKind, id: structure.scopeId },
        }],
  ), [knownGroupOptions, selectedScope, structure.scopeId, structure.scopeKind]);

  const selectMemory = (memory: WorkbenchMemorySummary): void => {
    if (dirty && !window.confirm("当前纠正草稿尚未提交。离开会丢弃草稿，是否继续？")) {
      return;
    }
    setDirty(false);
    setSelectionVersion((current) => current + 1);
    onStructureChange({
      scope:
        structure.scopeKind === null || structure.scopeId === null
          ? null
          : { kind: structure.scopeKind, id: structure.scopeId },
      selectedMemoryId: memory.memory_id,
      selectedRevisionId: memory.revision_id,
      includeNonCurrent: structure.includeNonCurrent,
    });
  };

  const refreshAfterCommit = async (
    memoryId: string,
    revisionId: string,
  ): Promise<void> => {
    void loadList(request);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refreshed = await loadDetail(memoryId, revisionId);
      if (
        refreshed?.status !== "ready" ||
        !["pending", "rebuilding"].includes(
          refreshed.memory.projection_state,
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    onStructureChange({
      scope:
        structure.scopeKind === null || structure.scopeId === null
          ? null
          : { kind: structure.scopeKind, id: structure.scopeId },
      selectedMemoryId: memoryId,
      selectedRevisionId: revisionId,
      includeNonCurrent: structure.includeNonCurrent,
    });
  };

  return (
    <section aria-labelledby="memory-collection-heading" className="workspace-grid memory-workspace">
      <div className="collection-panel">
        <div className="collection-heading">
          <div>
            <p className="eyebrow">CURRENT EFFECTIVE · EXACT SCOPE</p>
            <h2 id="memory-collection-heading">可召回记忆</h2>
          </div>
          <span className="count-chip">{list.items.length} 条</span>
        </div>

        <form
          className="memory-controls"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setAppliedSearch(searchDraft.trim() || null);
          }}
          role="search"
        >
          <label className="search-field">
            <span>搜索记忆内容</span>
            <input
              autoComplete="off"
              onChange={(event) => setSearchDraft(event.currentTarget.value)}
              placeholder="搜索文本只进入已认证请求"
              type="search"
              value={searchDraft}
            />
            <small>搜索文本仅留在页面内存，不写入 URL、历史或 referrer。</small>
          </label>
          <button className="button-primary" type="submit">搜索</button>
        </form>

        <div className="structural-filters" aria-label="结构筛选">
          <label>
            <span>精确 scope</span>
            <select
              onChange={(event) => {
                const option = groupOptions.find(
                  ({ value }) => value === event.currentTarget.value,
                );
                onStructureChange({
                  scope: option?.scope ?? null,
                  selectedMemoryId: null,
                  selectedRevisionId: null,
                  includeNonCurrent: structure.includeNonCurrent,
                });
              }}
              value={selectedScope}
            >
              <option value="">全部允许范围</option>
              {groupOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="checkbox-field">
            <input
              checked={structure.includeNonCurrent}
              onChange={(event) => onStructureChange({
                scope:
                  structure.scopeKind === null || structure.scopeId === null
                    ? null
                    : { kind: structure.scopeKind, id: structure.scopeId },
                selectedMemoryId: null,
                selectedRevisionId: null,
                includeNonCurrent: event.currentTarget.checked,
              })}
              type="checkbox"
            />
            <span>包含非当前修订</span>
          </label>
        </div>

        <ListNotice
          list={list}
          onClear={() => {
            setSearchDraft("");
            setAppliedSearch(null);
          }}
          onOpenHealth={onOpenHealth}
          onRetry={() => void loadList(request)}
        />

        {groups.map((group) => (
          <section className="memory-group" key={group.key} aria-labelledby={`group-${group.safeKey}`}>
            <div className="group-heading">
              <h3 id={`group-${group.safeKey}`}>{group.label}</h3>
              <span>{group.items.length} 条</span>
            </div>
            <ol className="memory-list" aria-label={`${group.label}记忆`}>
              {group.items.map((memory) => (
                <li key={memory.revision_id}>
                  <article className="memory-card" data-current={memory.is_current}>
                    <button
                      aria-pressed={
                        structure.selectedMemoryId === memory.memory_id &&
                        structure.selectedRevisionId === memory.revision_id
                      }
                      className="memory-card-action"
                      onClick={() => selectMemory(memory)}
                      type="button"
                    >
                      <span className="memory-meta">
                        <span>{kindLabel(memory.kind)}</span>
                        <span>{memory.is_current ? "当前" : nonCurrentLabel(memory.non_current_reason)}</span>
                      </span>
                      <strong>{contentText(memory)}</strong>
                      <span className="memory-card-footer">
                        <code>{memory.scope.kind}:{memory.scope.id}</code>
                        <span>{memory.authority} · r{memory.revision}</span>
                      </span>
                    </button>
                  </article>
                </li>
              ))}
            </ol>
          </section>
        ))}

        {(list.kind === "ready" || list.kind === "degraded") && list.nextCursor !== null ? (
          <button
            className="load-more"
            onClick={() => void loadList({ ...request, cursor: list.nextCursor }, true)}
            type="button"
          >
            继续读取快照
          </button>
        ) : null}
      </div>

      <aside className="detail-rail governed-detail" aria-label="记忆详情与治理">
        <MemoryDetail
          api={api}
          detail={detail}
          loading={detailLoading}
          mutationAvailable={list.kind === "ready" || list.kind === "degraded"}
          onCommitted={refreshAfterCommit}
          onDirtyChange={setDirty}
          selectionVersion={selectionVersion}
        />
      </aside>
    </section>
  );
}

function MemoryDetail({
  api,
  detail,
  loading,
  mutationAvailable,
  onCommitted,
  onDirtyChange,
  selectionVersion,
}: {
  api: MemoryWorkbenchApi;
  detail: WorkbenchMemoryDetailResult | null;
  loading: boolean;
  mutationAvailable: boolean;
  onCommitted(memoryId: string, revisionId: string): Promise<void>;
  onDirtyChange(dirty: boolean): void;
  selectionVersion: number;
}) {
  if (loading && detail === null) {
    return <div className="detail-state" role="status">正在组合权威详情…</div>;
  }
  if (detail === null) {
    return (
      <div className="detail-state">
        <p className="eyebrow">SELECTION</p>
        <h2>选择一条记忆</h2>
        <p>详情会组合当前修订、历史、来源链和投影状态；每一层都保留自己的权威边界。</p>
      </div>
    );
  }
  if (detail.status !== "ready") {
    return (
      <div className="detail-state" role="status">
        <p className="eyebrow">DETAIL UNAVAILABLE</p>
        <h2>{detail.status === "governance_excluded" ? "详情受治理规则限制" : "无法读取详情"}</h2>
        <p>{detail.reason_code}</p>
      </div>
    );
  }
  const memory = detail.memory;
  const editable =
    mutationAvailable &&
    memory.is_current &&
    memory.writable &&
    memory.lifecycle === "active" &&
    memory.content.status === "available";
  return (
    <div className="detail-content">
      <header className="detail-header">
        <p className="eyebrow">AUTHORITATIVE DETAIL</p>
        <h2>{contentText(memory)}</h2>
        <div className="detail-badges">
          <span>{memory.is_current ? "当前权威" : nonCurrentLabel(memory.non_current_reason)}</span>
          <span>{memory.lifecycle}</span>
          <span>{memory.projection_state}</span>
        </div>
      </header>
      <dl className="compact-facts">
        <div><dt>Memory</dt><dd><code>{memory.memory_id}</code></dd></div>
        <div><dt>Revision</dt><dd><code>{memory.revision_id}</code></dd></div>
        <div><dt>Scope</dt><dd>{memory.scope.kind}:{memory.scope.id}</dd></div>
        <div><dt>Authority</dt><dd>{memory.authority}</dd></div>
        <div><dt>Validity</dt><dd>{formatDate(memory.validity.valid_from)} 起</dd></div>
      </dl>

      <details className="detail-disclosure" open>
        <summary>修订历史（{detail.history.length}）</summary>
        <ol className="history-list">
          {detail.history.map((revision) => (
            <li key={revision.revision_id}>
              <div><strong>r{revision.revision}</strong><span>{revision.is_current ? "当前" : revision.lifecycle}</span></div>
              <p>{revision.content.status === "available" ? revision.content.text : `内容不可用 · ${revision.content.reason_code}`}</p>
              <code>{revision.revision_id}</code>
            </li>
          ))}
        </ol>
      </details>

      <details className="detail-disclosure" open>
        <summary>来源链（{detail.provenance.nodes.length} 节点）</summary>
        <ul className="provenance-list">
          {detail.provenance.nodes.map((node) => (
            <li key={node.node_id} data-status={node.status}>
              <div><strong>{node.label}</strong><span>{provenanceKindLabel(node.kind)}</span></div>
              <p>{node.content.status === "available" ? node.content.text : `缺口 · ${node.content.reason_code}`}</p>
            </li>
          ))}
        </ul>
        {detail.provenance.truncated ? (
          <p className="boundary-note">来源链达到边界，另有 {detail.provenance.omitted_count} 个节点未展示。</p>
        ) : null}
        {detail.provenance.cycle_detected ? (
          <p className="boundary-note">检测到循环引用；循环被显示为 typed gap，没有继续展开。</p>
        ) : null}
      </details>

      <CorrectionPanel
        api={api}
        detail={detail}
        enabled={editable}
        key={`${memory.memory_id}:${selectionVersion}`}
        onCommitted={async (result) =>
          onCommitted(result.memory_id, result.current_revision_id)}
        onDirtyChange={onDirtyChange}
      />
    </div>
  );
}

function ListNotice({
  list,
  onClear,
  onOpenHealth,
  onRetry,
}: {
  list: ListState;
  onClear(): void;
  onOpenHealth(): void;
  onRetry(): void;
}) {
  const content = listNotice(list);
  if (content === null) {
    return null;
  }
  return (
    <div className={`recovery-notice recovery-${list.kind}`} data-testid={`memory-state-${list.kind}`}>
      <div role="status"><strong>{content.title}</strong><p>{content.message}</p></div>
      {list.kind === "filtered-empty" ? <button onClick={onClear} type="button">清除搜索</button> : null}
      {list.kind === "blocked" || list.kind === "excluded" ? <button onClick={onOpenHealth} type="button">查看运行状态</button> : null}
      {(list.kind === "failed" || list.kind === "stale") && list.retryable ? <button onClick={onRetry} type="button">重新读取</button> : null}
    </div>
  );
}

function listState(
  result: WorkbenchMemoryListResult,
  retained: readonly WorkbenchMemorySummary[],
): ListState {
  switch (result.status) {
    case "ready":
    case "degraded":
      return {
        kind: result.status,
        items: [...retained, ...result.items],
        nextCursor: result.page.next_cursor,
        omittedCount: result.page.omitted_count,
        excludedCount: result.excluded_count,
        warnings: result.warnings,
      };
    case "ready_empty":
      return { kind: "empty", items: [], excludedCount: 0, reasonCodes: [] };
    case "filtered_empty":
      return { kind: "filtered-empty", items: [], excludedCount: 0, reasonCodes: [] };
    case "governance_excluded":
      return {
        kind: "excluded",
        items: [],
        excludedCount: result.excluded_count,
        reasonCodes: result.reason_codes,
      };
    case "stale_cursor":
      return {
        kind: "stale",
        items: retained,
        reasonCode: result.reason_code,
        retryable: true,
      };
    case "blocked":
    case "unauthorized":
    case "failed":
      return {
        kind: result.status,
        items: retained,
        reasonCode: result.reason_code,
        retryable: result.retryable,
      };
  }
}

function apiFailureState(
  error: unknown,
  retained: readonly WorkbenchMemorySummary[],
): ListState {
  if (error instanceof WorkbenchApiError && error.status === 401) {
    return { kind: "unauthorized", items: [], reasonCode: error.code, retryable: false };
  }
  if (error instanceof WorkbenchApiError && error.status === 503) {
    return { kind: "blocked", items: [], reasonCode: error.code, retryable: true };
  }
  return { kind: "failed", items: retained, reasonCode: "REQUEST_FAILED", retryable: true };
}

function listNotice(list: ListState): { title: string; message: string } | null {
  switch (list.kind) {
    case "loading": return { title: "VERIFYING", message: list.items.length > 0 ? "正在刷新，现有内容暂时保留。" : "正在读取当前权威快照。" };
    case "ready": return list.excludedCount > 0 ? { title: "GOVERNED", message: `${list.excludedCount} 条记录因治理规则未展示。` } : null;
    case "degraded": return { title: "BOUNDED", message: `结果已按安全边界截断；${list.omittedCount} 条未展示。` };
    case "empty": return { title: "READY EMPTY", message: "这个范围已验证，但没有可召回的当前记忆。" };
    case "filtered-empty": return { title: "NO MATCH", message: "当前搜索或结构筛选没有结果；这不代表记忆库为空。" };
    case "excluded": return { title: "GOVERNANCE EXCLUDED", message: `${list.excludedCount} 条候选未通过当前读取规则，内容不会泄露。` };
    case "blocked": return { title: "RUNTIME BLOCKED", message: `Canonical Runtime 不可用（${list.reasonCode}）。` };
    case "unauthorized": return { title: "AUTHORITY EXPIRED", message: "当前页面不再拥有读取权限，请重新打开工作台。" };
    case "stale": return { title: "SNAPSHOT STALE", message: `分页快照失效（${list.reasonCode}），保留项不再代表完整当前结果。` };
    case "failed": return { title: "READ FAILED", message: `读取失败（${list.reasonCode}），没有确认新的权威内容。` };
  }
}

function groupMemories(items: readonly WorkbenchMemorySummary[]) {
  const groups = new Map<string, { key: string; safeKey: string; label: string; items: WorkbenchMemorySummary[] }>();
  for (const memory of items) {
    const key = `${memory.group.scope.kind}:${memory.group.scope.id}`;
    const group = groups.get(key) ?? {
      key,
      safeKey: key.replaceAll(/[^A-Za-z0-9_-]/gu, "-"),
      label: groupLabel(memory),
      items: [],
    };
    group.items.push(memory);
    groups.set(key, group);
  }
  return [...groups.values()];
}

type GroupOption = {
  value: string;
  label: string;
  scope: { kind: StructuralUrlState["scopeKind"]; id: string };
};

function uniqueGroups(items: readonly WorkbenchMemorySummary[]): GroupOption[] {
  const options = new Map<string, GroupOption>();
  for (const memory of items) {
    const value = `${memory.scope.kind}:${memory.scope.id}`;
    options.set(value, {
      value,
      label: groupLabel(memory),
      scope: { kind: memory.scope.kind, id: memory.scope.id },
    });
  }
  return [...options.values()];
}

function mergeGroupOptions(
  current: readonly GroupOption[],
  observed: readonly GroupOption[],
): GroupOption[] {
  const merged = new Map(current.map((option) => [option.value, option]));
  for (const option of observed) {
    merged.set(option.value, option);
  }
  return [...merged.values()];
}

function groupLabel(memory: WorkbenchMemorySummary): string {
  if (memory.group.kind === "workspace_project") {
    return `项目 / 工作区 · ${memory.group.scope.id}`;
  }
  if (memory.group.kind === "topic") {
    return `主题 · ${memory.group.scope.id}`;
  }
  return `其他范围 · ${memory.group.scope.kind}:${memory.group.scope.id}`;
}

function contentText(memory: WorkbenchMemorySummary): string {
  return memory.content.status === "available"
    ? memory.content.text
    : `内容不可用 · ${memory.content.reason_code}`;
}

function kindLabel(kind: WorkbenchMemorySummary["kind"]): string {
  return kind === "semantic" ? "语义" : kind === "episodic" ? "情景" : "程序";
}

function nonCurrentLabel(reason: WorkbenchMemorySummary["non_current_reason"]): string {
  return reason === null ? "当前" : reason.replaceAll("_", " ");
}

function provenanceKindLabel(kind: "memory_revision" | "evidence" | "gap"): string {
  return kind === "memory_revision" ? "记忆修订" : kind === "evidence" ? "证据" : "来源缺口";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

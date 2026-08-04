import { useCallback, useEffect, useState } from "react";

import type {
  WorkbenchAutomaticMemoryActivity,
  WorkbenchAutomaticMemoryListResult,
} from "@memo-graph/contracts/workbench";

import type { MemoryWorkbenchApi } from "../memories/api.js";

type ReadyResult = Extract<
  WorkbenchAutomaticMemoryListResult,
  { status: "ready" | "ready_empty" }
>;

const DISPOSITION_LABEL = {
  activate: "已生效",
  candidate_only: "候选",
  review_required: "待确认",
  reject: "已拒绝",
} as const;

function timeLabel(value: string | null): string {
  if (value === null) return "尚未发生";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function stateLabel(item: WorkbenchAutomaticMemoryActivity): string {
  if (item.job?.status === "quarantined" || item.state === "quarantined") {
    return "已隔离";
  }
  if (item.job?.status === "completed") return "形成完成";
  if (item.job?.status === "processing") return "正在形成";
  if (item.job?.status === "pending") return "等待形成";
  return item.assistant_captured_at === null ? "等待回答" : "正在稳定";
}

type UndoState = {
  decisionId: string;
  status: "previewing" | "ready" | "confirming" | "error" | "complete";
  previewId: string | null;
  message: string;
} | null;

export function RecentAutomaticMemory({
  api,
  onOpenMemory,
}: {
  api: MemoryWorkbenchApi;
  onOpenMemory: (
    memoryId: string,
    revisionId: string,
    scope: { kind: "workspace" | "user"; id: string },
  ) => void;
}) {
  const [result, setResult] = useState<WorkbenchAutomaticMemoryListResult | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [undo, setUndo] = useState<UndoState>(null);

  const load = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    void api.automaticMemory({ limit: 40 }, controller.signal)
      .then(setResult)
      .catch(() => setResult({
        status: "failed",
        reason_code: "AUTOMATIC_MEMORY_READ_FAILED",
        retryable: true,
        warnings: [],
      }))
      .finally(() => setLoading(false));
    return controller;
  }, [api]);

  useEffect(() => {
    const controller = load();
    return () => controller.abort("unmounted");
  }, [load]);

  const previewUndo = useCallback((
    decisionId: string,
    memoryId: string,
    revisionId: string,
  ) => {
    setUndo({
      decisionId,
      status: "previewing",
      previewId: null,
      message: "正在验证自动形成来源与当前版本…",
    });
    void api.previewAutomaticMemoryUndo(memoryId, revisionId)
      .then((preview) => {
        if (preview.status === "ready") {
          setUndo({
            decisionId,
            status: "ready",
            previewId: preview.preview_id,
            message: "确认后会把这条记忆降为候选，不再自动召回；历史与来源证据会保留。",
          });
          return;
        }
        setUndo({
          decisionId,
          status: "error",
          previewId: null,
          message: preview.reason_code,
        });
      })
      .catch(() => setUndo({
        decisionId,
        status: "error",
        previewId: null,
        message: "AUTOMATIC_MEMORY_UNDO_PREVIEW_FAILED",
      }));
  }, [api]);

  const confirmUndo = useCallback((decisionId: string, previewId: string) => {
    setUndo({
      decisionId,
      status: "confirming",
      previewId,
      message: "正在应用已确认的治理变更…",
    });
    void api.confirmAutomaticMemoryUndo(previewId)
      .then((confirmed) => {
        if (confirmed.status !== "ready") {
          setUndo({
            decisionId,
            status: "error",
            previewId: null,
            message: confirmed.reason_code,
          });
          return;
        }
        setUndo({
          decisionId,
          status: "complete",
          previewId: null,
          message: "已降为候选；后续自动上下文不会再召回它。",
        });
        load();
      })
      .catch(() => setUndo({
        decisionId,
        status: "error",
        previewId: null,
        message: "AUTOMATIC_MEMORY_UNDO_FAILED",
      }));
  }, [api, load]);

  const ready = result?.status === "ready" || result?.status === "ready_empty"
    ? result as ReadyResult
    : null;

  return (
    <section aria-labelledby="automatic-memory-heading" className="automatic-memory-view">
      <header className="feature-intro automatic-memory-intro">
        <div>
          <p className="eyebrow">CAPTURE → FORMATION → ADMISSION → RECALL</p>
          <h2 id="automatic-memory-heading">自动记忆记录</h2>
          <p>这里只显示元数据和治理结果；原始对话仍留在证据层，不复制到审计记录。</p>
        </div>
        <button className="button-quiet" disabled={loading} onClick={() => load()} type="button">
          {loading ? "刷新中…" : "刷新"}
        </button>
      </header>

      {ready !== null ? (
        <dl className="automatic-overview" aria-label="自动记忆总览">
          <div><dt>捕获事件</dt><dd>{ready.overview.events}</dd></div>
          <div><dt>形成中</dt><dd>{ready.overview.pending}</dd></div>
          <div><dt>已完成</dt><dd>{ready.overview.completed}</dd></div>
          <div><dt>已隔离</dt><dd>{ready.overview.quarantined}</dd></div>
          <div><dt>自动召回</dt><dd>{ready.overview.recall_uses}</dd></div>
        </dl>
      ) : null}

      {loading && result === null ? (
        <p className="automatic-state" role="status">正在读取不可变审计记录…</p>
      ) : null}
      {result !== null && ready === null ? (
        <div className="automatic-state" role="alert">
          <strong>自动记忆记录暂不可用</strong>
          <span>{"reason_code" in result ? result.reason_code : "UNKNOWN"}</span>
        </div>
      ) : null}
      {ready?.status === "ready_empty" ? (
        <div className="automatic-state">
          <strong>还没有自动记忆活动</strong>
          <span>正常使用 Codex 后，捕获与形成状态会出现在这里。</span>
        </div>
      ) : null}

      {ready?.status === "ready" ? (
        <ol className="automatic-timeline" aria-label="最近自动记忆活动">
          {ready.items.map((item) => (
            <li key={item.turn_key}>
              <article className="automatic-record">
                <header>
                  <div>
                    <span className="automatic-state-chip" data-state={item.state}>
                      {stateLabel(item)}
                    </span>
                    <code>{item.scope.kind}:{item.scope.id}</code>
                  </div>
                  <time dateTime={item.assistant_captured_at ?? item.user_captured_at ?? undefined}>
                    {timeLabel(item.assistant_captured_at ?? item.user_captured_at)}
                  </time>
                </header>
                <dl className="automatic-record-facts">
                  <div><dt>Turn</dt><dd><code>{item.turn_id}</code></dd></div>
                  <div><dt>Generation</dt><dd>{item.generation}</dd></div>
                  <div><dt>Attempts</dt><dd>{item.job?.attempts ?? 0}</dd></div>
                  <div><dt>Provider</dt><dd>{item.provider?.model ?? "尚未调用"}</dd></div>
                </dl>
                {item.decisions.length > 0 ? (
                  <div className="automatic-decisions">
                    {item.decisions.map((decision) => {
                      const openScope =
                        decision.memory_scope?.kind === "workspace" ||
                          decision.memory_scope?.kind === "user"
                          ? decision.memory_scope
                          : item.scope;
                      const undoForDecision = undo?.decisionId === decision.decision_id
                        ? undo
                        : null;
                      const decisionLabel =
                        decision.disposition === "activate" &&
                          decision.current_lifecycle === "candidate"
                          ? "已撤销"
                          : DISPOSITION_LABEL[decision.disposition];
                      return (
                      <div className="automatic-decision" key={decision.decision_id}>
                        <div>
                          <strong data-disposition={decision.disposition}>
                            {decisionLabel}
                          </strong>
                          <span>{decision.reason_codes.join(" · ")}</span>
                        </div>
                        {decision.memory_id !== null && decision.revision_id !== null ? (
                          <div className="automatic-decision-actions">
                            <button
                              className="button-quiet"
                              onClick={() => onOpenMemory(
                                decision.memory_id as string,
                                decision.revision_id as string,
                                openScope,
                              )}
                              type="button"
                            >
                              打开权威记忆
                            </button>
                            {decision.disposition === "activate" &&
                                decision.current_lifecycle === "active" ? (
                              <button
                                className="button-quiet button-caution"
                                disabled={undoForDecision?.status === "previewing" || undoForDecision?.status === "confirming"}
                                onClick={() => previewUndo(
                                  decision.decision_id,
                                  decision.memory_id as string,
                                  decision.revision_id as string,
                                )}
                                type="button"
                              >
                                撤销自动召回
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        {undoForDecision !== null ? (
                          <div className="automatic-undo" role="status">
                            <p>{undoForDecision.message}</p>
                            {undoForDecision.status === "ready" && undoForDecision.previewId !== null ? (
                              <div>
                                <button
                                  className="button-primary"
                                  onClick={() => confirmUndo(decision.decision_id, undoForDecision.previewId as string)}
                                  type="button"
                                >
                                  确认降为候选
                                </button>
                                <button className="button-quiet" onClick={() => setUndo(null)} type="button">
                                  取消
                                </button>
                              </div>
                            ) : null}
                            {undoForDecision.status === "error" || undoForDecision.status === "complete" ? (
                              <button className="button-quiet" onClick={() => setUndo(null)} type="button">
                                关闭
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );})}
                  </div>
                ) : (
                  <p className="automatic-record-note">尚无策略决定；捕获内容不会提前进入长期记忆。</p>
                )}
                {item.provider !== null ? (
                  <details>
                    <summary>模型调用与脱敏信息</summary>
                    <dl className="automatic-provider-facts">
                      <div><dt>Provider</dt><dd>{item.provider.provider_id}</dd></div>
                      <div><dt>脱敏</dt><dd>{item.provider.redaction_action}</dd></div>
                      <div><dt>Tokens</dt><dd>{item.provider.input_tokens} in / {item.provider.output_tokens} out</dd></div>
                      <div><dt>Latency</dt><dd>{item.provider.latency_ms} ms</dd></div>
                    </dl>
                  </details>
                ) : null}
              </article>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

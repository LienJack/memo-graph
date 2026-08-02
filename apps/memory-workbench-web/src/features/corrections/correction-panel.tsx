import { useEffect, useRef, useState } from "react";

import type {
  WorkbenchCorrectionConfirmResult,
  WorkbenchCorrectionPreviewResult,
  WorkbenchMemoryDetailResult,
} from "@memo-graph/contracts/workbench";

import { FocusDialog } from "../../app/focus-dialog.js";
import type { MemoryWorkbenchApi } from "../memories/api.js";

type ReadyDetail = Extract<
  WorkbenchMemoryDetailResult,
  { status: "ready" }
>;
type ReadyPreview = Extract<
  WorkbenchCorrectionPreviewResult,
  { status: "ready" }
>;
type ReadyConfirmation = Extract<
  WorkbenchCorrectionConfirmResult,
  { status: "ready" }
>;

export function CorrectionPanel({
  api,
  detail,
  enabled,
  onCommitted,
  onDirtyChange,
}: {
  api: MemoryWorkbenchApi;
  detail: ReadyDetail;
  enabled: boolean;
  onCommitted(result: ReadyConfirmation): Promise<void>;
  onDirtyChange(dirty: boolean): void;
}) {
  const original = detail.memory.content.status === "available"
    ? detail.memory.content.text
    : "";
  const [replacement, setReplacement] = useState(original);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ReadyPreview | null>(null);
  const [receipt, setReceipt] = useState<ReadyConfirmation | null>(null);
  const [committedReason, setCommittedReason] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const previewController = useRef<AbortController | null>(null);
  const confirmTrigger = useRef<HTMLButtonElement>(null);
  const previousTarget = useRef({
    revisionId: detail.memory.revision_id,
    original,
  });
  const dirty =
    receipt === null &&
    (replacement !== original || reason.trim().length > 0);
  const validDraft =
    enabled &&
    receipt === null &&
    replacement.trim().length > 0 &&
    replacement !== original &&
    reason.trim().length > 0 &&
    reason.trim().length <= 2_000;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (dirty && receipt === null) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, receipt]);

  useEffect(() => () => previewController.current?.abort("unmounted"), []);

  useEffect(() => {
    if (previousTarget.current.revisionId === detail.memory.revision_id) {
      return;
    }
    const draftWasDirty =
      replacement !== previousTarget.current.original || reason.trim().length > 0;
    if (
      !draftWasDirty ||
      receipt?.current_revision_id === detail.memory.revision_id
    ) {
      setReplacement(original);
    } else {
      setPreview(null);
      setMessage("当前修订已变化；本页草稿仍保留，必须重新预览后才能确认。");
    }
    previousTarget.current = {
      revisionId: detail.memory.revision_id,
      original,
    };
  }, [
    detail.memory.revision_id,
    original,
    reason,
    receipt?.current_revision_id,
    replacement,
  ]);

  const createPreview = async (): Promise<void> => {
    if (!validDraft) {
      return;
    }
    previewController.current?.abort("superseded");
    const controller = new AbortController();
    previewController.current = controller;
    setPreviewing(true);
    setMessage(null);
    setPreview(null);
    try {
      const result = await api.previewCorrection(
        {
          memory_id: detail.memory.memory_id,
          expected_revision_id: detail.memory.revision_id,
          replacement: { text: replacement, media_type: "text/plain" },
          reason,
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      if (result.status === "ready") {
        setPreview(result);
        setMessage("预览已封存；只有这个修订、理由和影响闭包可以被确认。");
      } else {
        setMessage(previewFailureMessage(result.status, result.reason_code));
      }
    } catch {
      if (!controller.signal.aborted) {
        setMessage("预览失败；草稿仍保留在本页，尚未写入任何记忆。");
      }
    } finally {
      if (!controller.signal.aborted) {
        setPreviewing(false);
      }
    }
  };

  const confirm = async (): Promise<void> => {
    if (preview === null || confirming) {
      return;
    }
    setConfirming(true);
    setMessage(null);
    try {
      const result = await api.confirmCorrection(preview.preview_id);
      if (result.status === "ready") {
        setReceipt(result);
        setCommittedReason(preview.reason);
        setConfirmOpen(false);
        setPreview(null);
        setReplacement(preview.replacement.text);
        setReason("");
        setMessage(
          result.replayed
            ? "已恢复先前成功的纠正回执。"
            : "纠正已提交，新修订成为当前权威。",
        );
        await onCommitted(result);
      } else {
        setConfirmOpen(false);
        setPreview(null);
        setMessage(confirmFailureMessage(result.status, result.reason_code));
      }
    } catch {
      setConfirmOpen(false);
      setMessage(
        "确认结果未知。请保留当前页面并用同一预览重试；服务端会按 operation id 恢复既有回执。",
      );
    } finally {
      setConfirming(false);
    }
  };

  const discard = (): void => {
    previewController.current?.abort("discarded");
    setReplacement(original);
    setReason("");
    setPreview(null);
    setReceipt(null);
    setCommittedReason(null);
    setMessage("本页草稿已丢弃；没有发生记忆写入。");
  };

  return (
    <section className="correction-panel" aria-labelledby="correction-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">GOVERNED CORRECTION</p>
          <h3 id="correction-heading">纠正当前记忆</h3>
        </div>
        <span className={enabled ? "capability-ready" : "capability-off"}>
          {enabled ? "目标可治理" : "只读"}
        </span>
      </div>
      {!enabled ? (
        <p className="boundary-note">
          只有当前、active、内容可用且属于本实例权限范围的记忆可以纠正。历史、证据与派生节点保持只读。
        </p>
      ) : (
        <>
          <label className="field-stack">
            <span>替换内容</span>
            <textarea
              disabled={confirming || receipt !== null}
              maxLength={256_000}
              onChange={(event) => {
                setReplacement(event.currentTarget.value);
                setPreview(null);
                setReceipt(null);
                setCommittedReason(null);
              }}
              rows={7}
              value={replacement}
            />
          </label>
          <label className="field-stack">
            <span>纠正理由（必填）</span>
            <textarea
              disabled={confirming || receipt !== null}
              maxLength={2_000}
              onChange={(event) => {
                setReason(event.currentTarget.value);
                setPreview(null);
                setReceipt(null);
                setCommittedReason(null);
              }}
              placeholder="说明为什么旧记忆不再准确，以及新内容依据什么成立"
              rows={3}
              value={reason}
            />
            <small>{reason.trim().length}/2000 · 理由会进入回执与来源链</small>
          </label>
          <div className="correction-actions">
            <button
              className="button-primary"
              disabled={!validDraft || previewing || confirming}
              onClick={() => void createPreview()}
              type="button"
            >
              {previewing ? "正在证明影响范围…" : "生成纠正预览"}
            </button>
            <button
              disabled={!dirty || confirming}
              onClick={discard}
              type="button"
            >
              丢弃草稿
            </button>
          </div>
        </>
      )}

      {message === null ? null : <p className="operation-message" role="status">{message}</p>}

      {preview === null ? null : (
        <article className="preview-card" aria-labelledby="preview-heading">
          <div className="section-heading">
            <h4 id="preview-heading">封存预览</h4>
            <code>{shortHash(preview.seal_hash)}</code>
          </div>
          <div className="text-diff" aria-label="纠正前后差异">
            <div>
              <span>旧内容</span>
              <del>{original}</del>
            </div>
            <div>
              <span>新内容</span>
              <ins>{preview.replacement.text}</ins>
            </div>
          </div>
          <dl className="preview-facts">
            <div><dt>纠正理由</dt><dd>{preview.reason}</dd></div>
            <div><dt>Canonical closure</dt><dd>{preview.impact.descendant_count} 个后代</dd></div>
            <div><dt>支持上限</dt><dd>{preview.impact.supported_limit}</dd></div>
            <div><dt>过期时间</dt><dd>{formatTime(preview.expires_at)}</dd></div>
          </dl>
          {preview.impact.sample.length > 0 ? (
            <details>
              <summary>查看影响样本（{preview.impact.sample.length}）</summary>
              <ul className="compact-list">
                {preview.impact.sample.map((member) => (
                  <li key={member.projection_revision_id}>
                    <code>{member.projection_id}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {preview.impact.sample_truncated ? (
            <p className="boundary-note">
              样本已截断，另有 {preview.impact.omitted_count} 个成员未展示；确认依据仍是完整 closure hash。
            </p>
          ) : null}
          <button
            className="button-danger"
            onClick={() => setConfirmOpen(true)}
            ref={confirmTrigger}
            type="button"
          >
            确认应用纠正
          </button>
        </article>
      )}

      {receipt === null ? null : (
        <article className="receipt-card" aria-labelledby="receipt-heading">
          <p className="eyebrow">MUTATION RECEIPT</p>
          <h4 id="receipt-heading">新修订已发布</h4>
          <dl className="preview-facts">
            <div><dt>当前修订</dt><dd><code>{receipt.current_revision_id}</code></dd></div>
            <div><dt>前一修订</dt><dd><code>{receipt.previous_revision_id}</code></dd></div>
            <div><dt>回执</dt><dd><code>{receipt.receipt.receipt_id}</code></dd></div>
            <div><dt>纠正理由</dt><dd>{committedReason}</dd></div>
            <div><dt>恢复状态</dt><dd>{receipt.replayed ? "已重放既有结果" : "首次提交"}</dd></div>
          </dl>
        </article>
      )}

      <FocusDialog
        onClose={() => setConfirmOpen(false)}
        open={confirmOpen}
        returnFocusTo={confirmTrigger.current}
        title="确认创建新的权威修订"
      >
        <p>
          此操作不会覆盖历史；它会原子写入用户反馈证据、新修订、旧派生抑制与回执。确认后不能从本页撤销。
        </p>
        <div className="dialog-actions">
          <button onClick={() => setConfirmOpen(false)} type="button">返回预览</button>
          <button
            className="button-danger"
            disabled={confirming}
            onClick={() => void confirm()}
            type="button"
          >
            {confirming ? "正在提交…" : "确认并创建新修订"}
          </button>
        </div>
      </FocusDialog>
    </section>
  );
}

function previewFailureMessage(status: string, reason: string): string {
  if (status === "stale") {
    return `当前修订已变化（${reason}）。草稿已保留，请刷新详情后重新预览。`;
  }
  if (status === "blocked") {
    return `影响闭包不能被安全证明（${reason}），因此无法进入确认。`;
  }
  return `无法创建纠正预览（${reason}）；没有发生记忆写入。`;
}

function confirmFailureMessage(status: string, reason: string): string {
  if (status === "stale_preview") {
    return `预览已过期或目标修订发生冲突（${reason}）。草稿仍保留，请刷新并重新预览。`;
  }
  if (status === "approval_consumed") {
    return `预览授权不可再次消费（${reason}）。请刷新详情以恢复最终结果。`;
  }
  return `纠正未被确认（${reason}）；不要把当前草稿视为已写入。`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 18)}…${hash.slice(-8)}`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

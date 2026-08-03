import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryWorkbenchApi } from "../../apps/memory-workbench-web/src/features/memories/api.js";
import { mountWorkbench } from "../../apps/memory-workbench-web/src/mount.js";
import { readyDetail, readyHealth, readyList } from "./helpers/workbench-fixtures.js";

const mounted: { unmount(): void }[] = [];

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

function api(): MemoryWorkbenchApi {
  let currentLifecycle: "active" | "candidate" = "active";
  return {
    listMemories: vi.fn(async () => readyList),
    memoryDetail: vi.fn(async () => readyDetail),
    graph: vi.fn(async () => ({
      status: "failed",
      reason_code: "GRAPH_FIXTURE_UNUSED",
      retryable: false,
      warnings: [],
    })),
    health: vi.fn(async () => readyHealth),
    automaticMemory: vi.fn(async () => ({
      status: "ready",
      overview: {
        projects: 1,
        events: 6,
        turns: 3,
        pending: 1,
        completed: 2,
        quarantined: 0,
        recall_uses: 4,
      },
      items: [{
        turn_key: "turn_key_automatic_1",
        project_id: "project_memo_graph",
        scope: { kind: "workspace", id: "memo_graph" },
        session_id: "session_automatic_1",
        turn_id: "turn_automatic_1",
        generation: 1,
        state: "completed",
        user_captured_at: "2026-08-03T08:00:00.000Z",
        assistant_captured_at: "2026-08-03T08:00:03.000Z",
        job: {
          job_id: "job_automatic_1",
          status: "completed",
          attempts: 1,
          updated_at: "2026-08-03T08:00:05.000Z",
        },
        provider: {
          provider_id: "openai",
          model: "gpt-5.6-luna",
          state: "succeeded",
          redaction_action: "redacted",
          input_tokens: 128,
          output_tokens: 36,
          latency_ms: 820,
          completed_at: "2026-08-03T08:00:05.000Z",
        },
        decisions: [{
          decision_id: "decision_automatic_1",
          proposal_id: "proposal_automatic_1",
          disposition: "activate",
          reason_codes: ["eligible_for_activation"],
          requires_user_confirmation: false,
          decided_at: "2026-08-03T08:00:05.000Z",
          candidate_id: "candidate_automatic_1",
          memory_id: "memory_automatic_1",
          revision_id: "revision_automatic_1",
          receipt_id: "receipt_automatic_1",
          memory_scope: { kind: "user", id: "user_local" },
          current_lifecycle: currentLifecycle,
        }],
      }],
      warnings: [],
    })),
    previewAutomaticMemoryUndo: vi.fn(async () => ({
      status: "ready",
      preview_id: "preview_automatic_1",
      memory_id: "memory_automatic_1",
      expected_revision_id: "revision_automatic_1",
      effect: "demote_from_automatic_recall",
      expires_at: "2026-08-03T08:05:00.000Z",
      warnings: ["history_and_provenance_are_preserved"],
    })),
    confirmAutomaticMemoryUndo: vi.fn(async () => {
      currentLifecycle = "candidate";
      return {
        status: "ready",
        memory_id: "memory_automatic_1",
        current_revision_id: "revision_automatic_1",
        lifecycle: "candidate",
        replayed: false,
        receipt: {
          schema_version: "1.0.0",
          receipt_id: "receipt_automatic_undo_1",
          created_at: "2026-08-03T08:01:00.000Z",
          state: "durable",
          request_hash: `sha256:${"a".repeat(64)}`,
          receipt_hash: `sha256:${"b".repeat(64)}`,
          kind: "mutation",
          idempotency_key: "automatic-undo-operation-1",
          affected_memory_ids: ["memory_automatic_1"],
          affected_revision_ids: ["revision_automatic_1"],
          resulting_epoch: 4,
          projection_jobs: [],
          warnings: [],
        },
        warnings: [],
      };
    }),
    previewCorrection: vi.fn(),
    confirmCorrection: vi.fn(),
  };
}

describe("automatic memory workbench", () => {
  it("shows formation lineage and requires preview-confirm before undo", async () => {
    await page.viewport(1280, 900);
    const workbenchApi = api();
    const container = document.createElement("div");
    document.body.append(container);
    mounted.push(mountWorkbench(container, {
      api: workbenchApi,
      initialUrl: "http://127.0.0.1:4321/?view=automatic",
    }));

    await expect.element(page.getByRole("heading", { name: "自动记忆记录" })).toBeVisible();
    await expect.element(page.getByText("gpt-5.6-luna")).toBeVisible();
    await expect.element(page.getByText("6").first()).toBeVisible();
    expect(workbenchApi.confirmAutomaticMemoryUndo).not.toHaveBeenCalled();

    const screenshotPath = import.meta.env.VITE_MEMO_AUTO_SCREENSHOT;
    if (screenshotPath !== undefined) {
      await page.screenshot({ path: screenshotPath });
    }

    await page.getByRole("button", { name: "撤销自动召回" }).click();
    await expect.element(page.getByText(/历史与来源证据会保留/u)).toBeVisible();
    expect(workbenchApi.previewAutomaticMemoryUndo).toHaveBeenCalledWith(
      "memory_automatic_1",
      "revision_automatic_1",
    );
    expect(workbenchApi.confirmAutomaticMemoryUndo).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "确认降为候选" }).click();
    await expect.element(page.getByText(/已降为候选/u)).toBeVisible();
    expect(workbenchApi.confirmAutomaticMemoryUndo).toHaveBeenCalledWith(
      "preview_automatic_1",
    );
    await expect.element(page.getByText("已撤销")).toBeVisible();
    expect(page.getByRole("button", { name: "撤销自动召回" }).query()).toBeNull();
  });
});

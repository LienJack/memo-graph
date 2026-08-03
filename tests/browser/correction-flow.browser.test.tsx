import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryWorkbenchApi } from "../../apps/memory-workbench-web/src/features/memories/api.js";
import { mountWorkbench } from "../../apps/memory-workbench-web/src/mount.js";
import {
  currentMemory,
  readyConfirmation,
  readyDetail,
  readyList,
  readyHealth,
  readyPreview,
} from "./helpers/workbench-fixtures.js";

const mounted: { unmount(): void }[] = [];
const originalText = currentMemory.content.status === "available"
  ? currentMemory.content.text
  : "";

afterEach(() => {
  for (const root of mounted.splice(0)) {
    root.unmount();
  }
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

function api(overrides: Partial<MemoryWorkbenchApi> = {}): MemoryWorkbenchApi {
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
      status: "ready_empty",
      overview: { projects: 0, events: 0, turns: 0, pending: 0, completed: 0, quarantined: 0, recall_uses: 0 },
      items: [], warnings: [],
    })),
    previewAutomaticMemoryUndo: vi.fn(),
    confirmAutomaticMemoryUndo: vi.fn(),
    previewCorrection: vi.fn(async () => readyPreview),
    confirmCorrection: vi.fn(async () => readyConfirmation),
    ...overrides,
  };
}

function render(workbenchApi: MemoryWorkbenchApi): void {
  const container = document.createElement("div");
  document.body.append(container);
  mounted.push(mountWorkbench(container, { api: workbenchApi }));
}

async function openCurrentMemory(): Promise<void> {
  await expect.element(page.getByText(originalText).first()).toBeVisible();
  await page.getByRole("button", { name: new RegExp(originalText, "u") }).click();
  await expect.element(page.getByRole("heading", { name: "纠正当前记忆" })).toBeVisible();
}

describe("sealed correction experience", () => {
  it("previews a bounded diff, confirms explicitly, and shows the receipt", async () => {
    const workbenchApi = api();
    render(workbenchApi);
    await openCurrentMemory();

    const replacement = page.getByRole("textbox", { name: "替换内容" });
    const reason = page.getByRole("textbox", { name: "纠正理由（必填）" });
    await replacement.fill("启动后直接进入可治理的记忆工作台。");
    await reason.fill("用户明确纠正了启动入口描述");
    await page.getByRole("button", { name: "生成纠正预览" }).click();

    await expect.element(page.getByRole("heading", { name: "封存预览" })).toBeVisible();
    await expect.element(page.getByText("2 个后代")).toBeVisible();
    await expect.element(page.getByText(/样本已截断，另有 1 个成员/u)).toBeVisible();
    expect(workbenchApi.previewCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        memory_id: "memory_current",
        expected_revision_id: "revision_current",
        reason: "用户明确纠正了启动入口描述",
      }),
      expect.any(AbortSignal),
    );

    await page.getByRole("button", { name: "确认应用纠正" }).click();
    await expect.element(page.getByRole("dialog", { name: "确认创建新的权威修订" })).toBeVisible();
    await page.getByRole("button", { name: "确认并创建新修订" }).click();

    await expect.element(page.getByRole("heading", { name: "新修订已发布" })).toBeVisible();
    await expect.element(page.getByText("receipt_workbench_correction")).toBeVisible();
    await expect.element(page.getByText("用户明确纠正了启动入口描述")).toBeVisible();
    await expect.poll(() => vi.mocked(workbenchApi.memoryDetail).mock.calls.length).toBeGreaterThan(1);
    expect(workbenchApi.memoryDetail).toHaveBeenCalledWith(
      "memory_current",
      "revision_successor",
      expect.any(AbortSignal),
    );
    expect(window.location.search).toContain("revision_id=revision_successor");
    expect(workbenchApi.confirmCorrection).toHaveBeenCalledWith(
      "workbench-preview_test",
    );
  });

  it("keeps the local draft after a stale preview and blocks confirmation", async () => {
    const workbenchApi = api({
      previewCorrection: vi.fn(async () => ({
        status: "stale",
        reason_code: "STALE_REVISION",
        retryable: false,
        warnings: [],
      })),
    });
    render(workbenchApi);
    await openCurrentMemory();

    const replacement = page.getByRole("textbox", { name: "替换内容" });
    const reason = page.getByRole("textbox", { name: "纠正理由（必填）" });
    await replacement.fill("另一个标签页已经推进了修订");
    await reason.fill("保留当前草稿以便人工比较");
    await page.getByRole("button", { name: "生成纠正预览" }).click();

    await expect.element(page.getByText(/当前修订已变化/u)).toBeVisible();
    await expect.element(replacement).toHaveValue("另一个标签页已经推进了修订");
    await expect.element(reason).toHaveValue("保留当前草稿以便人工比较");
    await expect.element(page.getByRole("button", { name: "确认应用纠正" })).not.toBeInTheDocument();
    expect(workbenchApi.confirmCorrection).not.toHaveBeenCalled();
  });

  it("requires a reason and explicit preview while cancel remains write-free", async () => {
    const workbenchApi = api();
    render(workbenchApi);
    await openCurrentMemory();

    const replacement = page.getByRole("textbox", { name: "替换内容" });
    const preview = page.getByRole("button", { name: "生成纠正预览" });
    await replacement.fill("只有替换内容，没有理由");
    await expect.element(preview).toBeDisabled();
    await page.getByRole("button", { name: "丢弃草稿" }).click();
    await expect.element(replacement).toHaveValue(originalText);
    await expect.element(page.getByText(/没有发生记忆写入/u)).toBeVisible();
    expect(workbenchApi.previewCorrection).not.toHaveBeenCalled();
    expect(workbenchApi.confirmCorrection).not.toHaveBeenCalled();
  });

  it("guards top-level navigation while a local correction draft is dirty", async () => {
    const workbenchApi = api();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(workbenchApi);
    await openCurrentMemory();
    await page.getByRole("textbox", { name: "替换内容" }).fill("尚未提交的本地草稿");
    await page.getByRole("textbox", { name: "纠正理由（必填）" }).fill("离开前必须显式确认丢弃");

    await page.getByRole("link", { name: /Graph/u }).click();
    await expect.element(page.getByRole("heading", { level: 1, name: "记忆" })).toBeVisible();
    expect(confirm).toHaveBeenCalledTimes(1);

    confirm.mockReturnValue(true);
    await page.getByRole("link", { name: /Graph/u }).click();
    await expect.element(page.getByRole("heading", { level: 1, name: "Graph" })).toBeVisible();
  });

  it("recovers an accepted correction after the first confirmation response is lost", async () => {
    const confirmCorrection = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ ...readyConfirmation, replayed: true });
    render(api({ confirmCorrection }));
    await openCurrentMemory();
    await page.getByRole("textbox", { name: "替换内容" }).fill("启动后直接进入可治理的记忆工作台。");
    await page.getByRole("textbox", { name: "纠正理由（必填）" }).fill("用户明确纠正了启动入口描述");
    await page.getByRole("button", { name: "生成纠正预览" }).click();
    await page.getByRole("button", { name: "确认应用纠正" }).click();
    await page.getByRole("button", { name: "确认并创建新修订" }).click();
    await expect.element(page.getByText(/确认结果未知/u)).toBeVisible();

    await page.getByRole("button", { name: "确认应用纠正" }).click();
    await page.getByRole("button", { name: "确认并创建新修订" }).click();
    await expect.element(page.getByText("已恢复先前成功的纠正回执。")).toBeVisible();
    await expect.element(page.getByText("receipt_workbench_correction")).toBeVisible();
    expect(confirmCorrection).toHaveBeenCalledTimes(2);
  });
});

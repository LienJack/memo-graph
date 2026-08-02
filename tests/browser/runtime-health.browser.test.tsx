import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryWorkbenchApi } from "../../apps/memory-workbench-web/src/features/memories/api.js";
import { mountWorkbench } from "../../apps/memory-workbench-web/src/mount.js";
import {
  degradedGraph,
  readyConfirmation,
  readyDetail,
  readyHealth,
  readyList,
  readyPreview,
} from "./helpers/workbench-fixtures.js";

const mounted: { unmount(): void }[] = [];

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

function api(
  health: MemoryWorkbenchApi["health"] = vi.fn(async () => readyHealth),
): MemoryWorkbenchApi {
  return {
    listMemories: vi.fn(async () => readyList),
    memoryDetail: vi.fn(async () => readyDetail),
    graph: vi.fn(async () => degradedGraph),
    health,
    previewCorrection: vi.fn(async () => readyPreview),
    confirmCorrection: vi.fn(async () => readyConfirmation),
  };
}

function render(workbenchApi: MemoryWorkbenchApi): void {
  const container = document.createElement("div");
  document.body.append(container);
  mounted.push(mountWorkbench(container, { api: workbenchApi }));
}

describe("authority-first Runtime dashboard", () => {
  it("keeps canonical authority primary and renders subordinate observations without controls", async () => {
    const workbenchApi = api();
    render(workbenchApi);
    await page.getByRole("link", { name: /运行仪表盘/u }).click();

    await expect.element(page.getByRole("heading", { name: "Canonical authority" })).toBeVisible();
    expect(workbenchApi.health).toHaveBeenCalledWith(expect.any(AbortSignal));
    await expect.element(page.getByRole("heading", { name: "派生投影" })).toBeVisible();
    await expect.element(page.getByText("LAYERED_PROJECTION_LAGGING")).toBeVisible();
    await expect.element(page.getByText("GRAPH_PROJECTION_NOT_CONFIGURED")).toBeVisible();
    await expect.element(page.getByRole("table", { name: "后台任务的内容无关运行指标" })).toBeVisible();
    await expect.element(page.getByText("writer_lease")).toBeVisible();
    expect(
      document.querySelector(
        '.runtime-dashboard button, .runtime-dashboard input, .runtime-dashboard select, .runtime-dashboard textarea',
      ),
    ).toBeNull();
    expect(document.body.textContent).toContain("只执行认证 GET 轮询");
  });

  it("does not invent healthy cards when the first observation is unavailable", async () => {
    render(api(vi.fn(async () => Promise.reject(new Error("offline")))));
    await page.getByRole("link", { name: /运行仪表盘/u }).click();

    await expect.element(page.getByText("当前没有可信健康观察")).toBeVisible();
    expect(document.querySelector(".health-component")).toBeNull();
  });

  it("labels an expired response as stale while retaining its read-only context", async () => {
    render(api(vi.fn(async () => ({
      ...readyHealth,
      observed_at: "2026-08-02T01:00:00.000Z",
      stale_after: "2026-08-02T01:00:15.000Z",
    }))));
    await page.getByRole("link", { name: /运行仪表盘/u }).click();

    await expect.element(page.getByText(/最后一次观察/u)).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Canonical authority" })).toBeVisible();
    expect(document.querySelector('.health-hierarchy[data-stale="true"]')).not.toBeNull();
  });
});

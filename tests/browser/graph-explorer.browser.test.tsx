import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryWorkbenchApi } from "../../apps/memory-workbench-web/src/features/memories/api.js";
import { mountWorkbench } from "../../apps/memory-workbench-web/src/mount.js";
import {
  currentMemory,
  degradedGraph,
  readyConfirmation,
  readyDetail,
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

function api(overrides: Partial<MemoryWorkbenchApi> = {}): MemoryWorkbenchApi {
  return {
    listMemories: vi.fn(async () => readyList),
    memoryDetail: vi.fn(async () => readyDetail),
    graph: vi.fn(async () => degradedGraph),
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

async function openGraphAndChooseCenter(): Promise<void> {
  await page.getByRole("link", { name: /Graph/u }).click();
  await expect.element(page.getByRole("heading", { name: "选择一个真实 revision" })).toBeVisible();
  const text = currentMemory.content.status === "available"
    ? currentMemory.content.text
    : "";
  await page.getByRole("button", { name: new RegExp(text, "u") }).click();
  await expect.element(page.getByText("Graph 处于降级解释模式；canonical 记忆仍可独立查看。")).toBeVisible();
}

describe("bounded accessible Graph explorer", () => {
  it("selects a governed center, renders a read-only canvas, and mirrors it semantically", async () => {
    const workbenchApi = api();
    render(workbenchApi);
    await openGraphAndChooseCenter();

    expect(workbenchApi.graph).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: currentMemory.scope,
        center: {
          kind: "memory_revision",
          revision_id: currentMemory.revision_id,
        },
        max_nodes: 80,
        max_edges: 120,
      }),
      expect.any(AbortSignal),
    );
    await expect.element(page.getByText("Projection").first()).toBeVisible();
    await expect.element(page.getByText("unavailable").first()).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "节点" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "关系", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /derived_from/u })).toBeVisible();
    await expect.poll(() => document.querySelector(".graph-canvas canvas")).not.toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(window.location.search).toContain("graph_revision_id=revision_current");
  });

  it("re-centers a projection with a structural deep link and keeps free text out of it", async () => {
    const workbenchApi = api();
    render(workbenchApi);
    await page.getByRole("link", { name: /Graph/u }).click();
    const secret = "graph-private@example.test";
    await page.getByRole("searchbox", { name: "查找 Graph 中心记忆" }).fill(secret);
    await page.getByRole("button", { name: "查找中心" }).click();
    await expect.poll(() => vi.mocked(workbenchApi.listMemories).mock.calls.length).toBeGreaterThan(1);
    expect(window.location.href).not.toContain("graph-private");

    const text = currentMemory.content.status === "available" ? currentMemory.content.text : "";
    await page.getByRole("button", { name: new RegExp(text, "u") }).click();
    await page.getByRole("button", { name: "topic projection 启动入口治理" }).click();
    await page.getByRole("button", { name: "以此节点为中心" }).click();
    await expect.poll(() => vi.mocked(workbenchApi.graph).mock.calls.length).toBeGreaterThan(1);
    expect(workbenchApi.graph).toHaveBeenLastCalledWith(
      expect.objectContaining({
        center: {
          kind: "projection_revision",
          revision_id: "projection_revision_workbench_topic",
        },
      }),
      expect.any(AbortSignal),
    );
    expect(window.location.search).toContain("graph_center_kind=projection_revision");
  });

  it("follows a canonical node to its exact read-only memory detail", async () => {
    const workbenchApi = api();
    render(workbenchApi);
    await openGraphAndChooseCenter();
    await page.getByRole("button", { name: /Canonical memory/u }).click();
    await page.getByRole("button", { name: "在记忆中查看" }).click();

    await expect.element(page.getByRole("heading", { level: 1, name: "记忆" })).toBeVisible();
    expect(workbenchApi.memoryDetail).toHaveBeenCalledWith(
      currentMemory.memory_id,
      currentMemory.revision_id,
      expect.any(AbortSignal),
    );
    expect(window.location.search).toContain("memory_id=memory_current");
    expect(window.location.search).not.toContain("graph_revision_id");
  });
});

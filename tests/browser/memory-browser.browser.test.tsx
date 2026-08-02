import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryWorkbenchApi } from "../../apps/memory-workbench-web/src/features/memories/api.js";
import { mountWorkbench } from "../../apps/memory-workbench-web/src/mount.js";
import {
  currentMemory,
  historicalDetail,
  historicalMemory,
  readyConfirmation,
  readyDetail,
  readyList,
  readyPreview,
  topicMemory,
} from "./helpers/workbench-fixtures.js";

const mounted: { unmount(): void }[] = [];

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

describe("governed memory browser", () => {
  it("browses peer exact-scope groups and composes history with provenance gaps", async () => {
    const workbenchApi = api();
    render(workbenchApi);

    await expect.element(page.getByRole("heading", { name: "项目 / 工作区 · memo_graph" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "主题 · memory_governance" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(currentMemory.content.status === "available" ? currentMemory.content.text : "", "u") }).click();

    await expect.element(page.getByRole("heading", { name: currentMemory.content.status === "available" ? currentMemory.content.text : "" })).toBeVisible();
    await expect.element(page.getByText("旧的启动入口描述")).toBeVisible();
    await expect.element(page.getByText("用户确认启动入口应为记忆工作台")).toBeVisible();
    await expect.element(page.getByText("缺口 · SOURCE_REDACTED")).toBeVisible();
    expect(window.location.search).toContain("memory_id=memory_current");
    expect(workbenchApi.memoryDetail).toHaveBeenCalledWith(
      "memory_current",
      "revision_current",
      expect.any(AbortSignal),
    );
  });

  it("keeps free-text search out of structural URLs", async () => {
    const workbenchApi = api();
    render(workbenchApi);
    await expect.element(page.getByRole("heading", { name: "项目 / 工作区 · memo_graph" })).toBeVisible();

    const secret = "private+token@example.test";
    await page.getByRole("searchbox", { name: "搜索记忆内容" }).fill(secret);
    await page.getByRole("button", { name: "搜索" }).click();
    await expect.poll(() => vi.mocked(workbenchApi.listMemories).mock.calls.length).toBeGreaterThan(1);
    expect(workbenchApi.listMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: secret }),
      expect.any(AbortSignal),
    );
    expect(window.location.href).not.toContain("private");
    expect(window.location.href).not.toContain("token");
  });

  it("keeps previously observed peer scopes available after exact-scope filtering", async () => {
    const listMemories = vi.fn(async (request) =>
      request.scope === null
        ? readyList
        : {
            ...readyList,
            items: [currentMemory],
            page: { ...readyList.page, retained_count: 1 },
          },
    );
    render(api({ listMemories }));
    const scope = page.getByRole("combobox", { name: "精确 scope" });
    await expect.element(page.getByRole("option", { name: "主题 · memory_governance" })).toBeInTheDocument();

    await scope.selectOptions("workspace:memo_graph");
    await expect.poll(() => listMemories.mock.calls.length).toBeGreaterThan(1);
    await expect.element(page.getByRole("option", { name: "主题 · memory_governance" })).toBeInTheDocument();
  });

  it("opens an explicit historical revision as read-only authority", async () => {
    const historicalList = {
      ...readyList,
      items: [historicalMemory],
      page: { ...readyList.page, retained_count: 1 },
    };
    const workbenchApi = api({
      listMemories: vi.fn(async () => historicalList),
      memoryDetail: vi.fn(async () => historicalDetail),
    });
    render(workbenchApi);

    await page.getByRole("button", { name: /旧的启动入口描述/u }).click();
    await expect.element(page.getByText("只有当前、active、内容可用且属于本实例权限范围的记忆可以纠正。历史、证据与派生节点保持只读。")).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "替换内容" })).not.toBeInTheDocument();
    expect(workbenchApi.memoryDetail).toHaveBeenCalledWith(
      historicalMemory.memory_id,
      historicalMemory.revision_id,
      expect.any(AbortSignal),
    );
    expect(window.location.search).toContain("revision_id=revision_historical");
  });

  it("ignores a superseded list response after a new search wins", async () => {
    let resolveInitial: ((value: typeof readyList) => void) | undefined;
    const initial = new Promise<typeof readyList>((resolve) => {
      resolveInitial = resolve;
    });
    const topicOnly = {
      ...readyList,
      items: [topicMemory],
      page: { ...readyList.page, retained_count: 1 },
    };
    const listMemories = vi.fn()
      .mockImplementationOnce(async () => initial)
      .mockImplementationOnce(async () => topicOnly);
    render(api({ listMemories }));

    await page.getByRole("searchbox", { name: "搜索记忆内容" }).fill("topic");
    await page.getByRole("button", { name: "搜索" }).click();
    await expect.element(page.getByText("主题记忆保持独立 scope，不伪造 workspace 父节点。")).toBeVisible();
    resolveInitial?.(readyList);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect.element(page.getByText("启动后先进入记忆工作台，Graph 与运行仪表盘保持同级。")).not.toBeInTheDocument();
  });

  it("renders memory markup as text and cannot create executable nodes", async () => {
    const markup = '<img src=x onerror="globalThis.compromised=true">';
    const unsafeLooking = {
      ...readyList,
      items: [
        {
          ...currentMemory,
          content: {
            ...currentMemory.content,
            status: "available" as const,
            text: markup,
          },
        },
      ],
      page: { ...readyList.page, retained_count: 1 },
    };
    render(api({ listMemories: vi.fn(async () => unsafeLooking) }));

    await expect.element(page.getByText(markup)).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
    expect((globalThis as { compromised?: boolean }).compromised).not.toBe(true);
  });
});

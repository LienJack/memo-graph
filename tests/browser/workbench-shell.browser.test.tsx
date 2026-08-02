import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";

import { mountWorkbench } from "../../apps/memory-workbench-web/src/mount.js";
import type { RecoveryKind } from "../../apps/memory-workbench-web/src/app/recovery-state.js";

const mounted: { unmount(): void }[] = [];

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    root.unmount();
  }
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  await page.viewport(1280, 800);
});

function render(initialRecoveryKind: RecoveryKind = "ready"): void {
  const container = document.createElement("div");
  document.body.append(container);
  mounted.push(mountWorkbench(container, { initialRecoveryKind }));
}

describe("Memory Workbench shell", () => {
  it("opens Memory by default and exposes all peer views to keyboard users", async () => {
    render();
    const heading = page.getByRole("heading", { level: 1, name: "记忆" });
    await expect.element(heading).toBeVisible();
    await expect.element(page.getByRole("link", { name: /记忆 浏览与治理/u })).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: /Graph 关系视图/u }).click();
    await expect.element(page.getByRole("heading", { level: 1, name: "Graph" })).toBeVisible();
    await page.getByRole("link", { name: /运行仪表盘 只读健康状态/u }).click();
    await expect.element(page.getByRole("heading", { level: 1, name: "运行仪表盘" })).toBeVisible();
    await expect.element(page.getByText(/不提供 retry、rebuild/u)).toBeVisible();
  });

  it.each<RecoveryKind>([
    "ready-empty",
    "filtered-empty",
    "governance-excluded",
    "degraded",
    "blocked",
    "disconnected",
    "failed",
  ])("renders a distinct %s recovery state", async (kind) => {
    render(kind);
    await expect.element(page.getByTestId(`recovery-${kind}`)).toBeVisible();
    if (["blocked", "disconnected", "failed"].includes(kind)) {
      await expect.element(page.getByText("Authority unavailable")).toBeVisible();
      await expect.element(page.getByText("当前实例已验证")).not.toBeInTheDocument();
    }
  });

  it("traps dialog focus, closes with Escape, and restores the trigger", async () => {
    render();
    const trigger = page.getByRole("button", { name: "视图说明" });
    await trigger.click();
    await expect.element(page.getByRole("dialog", { name: /记忆的权威边界/u })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  });

  it("removes free text URL state and never interprets markup as DOM", async () => {
    window.history.replaceState(
      null,
      "",
      "/?query=sk-secret%40example.test&draft=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
    );
    render();
    await expect.element(page.getByRole("heading", { level: 1, name: "记忆" })).toBeVisible();
    expect(window.location.search).toBe("");
    expect(document.querySelector("img")).toBeNull();

    const search = page.getByRole("searchbox", { name: "在当前页面搜索" });
    await search.fill("private@example.test");
    expect(window.location.href).not.toContain("private");
  });

  it("reflows without horizontal overflow at a narrow 200%-zoom-equivalent viewport", async () => {
    await page.viewport(560, 720);
    render();
    await expect.element(page.getByRole("heading", { level: 1, name: "记忆" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const targets = document.querySelectorAll<HTMLElement>("nav a, button, input");
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });
});

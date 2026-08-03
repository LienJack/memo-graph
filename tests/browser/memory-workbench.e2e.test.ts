import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { launchOrReuseWorkbench } from "../../apps/memory-workbench-host/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const roots: string[] = [];
const processIds = new Set<number>();
const browsers: Browser[] = [];
const HOST_ENTRY = resolve("apps/memory-workbench-host/dist/cli.js");
const scope = { kind: "workspace", id: "workspace_local" } as const;

async function waitUntilStopped(processId: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      process.kill(processId, 0);
    } catch {
      return;
    }
    await new Promise((resolve_) => setTimeout(resolve_, 20));
  }
}

afterEach(async () => {
  await Promise.allSettled(browsers.splice(0).map((browser) => browser.close()));
  for (const processId of processIds) {
    try {
      process.kill(processId, "SIGTERM");
    } catch {
      // The real child process already completed shutdown.
    }
  }
  await Promise.all([...processIds].map(waitUntilStopped));
  processIds.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged memory workbench", () => {
  it("launches one built SPA, corrects memory, inspects Graph and Health, and shuts down cleanly", async () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-workbench-e2e-")),
    );
    roots.push(root);
    const dataRoot = join(root, "data");
    const recovery = mcpRecoveryFixture(dataRoot);
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: recovery.provider,
    });
    await storage.commitEpisode(inlineEpisode({}));
    const original = "E2E memory before governed correction";
    const corrected = "E2E memory after governed correction";
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_workbench_e2e",
          logicalKey: "workbench.e2e",
          scope,
          text: original,
        }),
        idempotencyKey: "workbench-e2e-source-0001",
        requestId: "request_workbench_e2e_source",
      }),
      evaluation: {
        decision: "activate",
        reason: "real browser fixture starts from one governed memory",
      },
    });
    await storage.close();

    const opened: string[] = [];
    const launched = await launchOrReuseWorkbench({
      config: {
        data_root: dataRoot,
        principal_id: "user_local",
        allowed_scopes: [scope],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: true,
        recovery_head: recovery.config,
      },
      runtimeDirectory: join(root, "runtime"),
      hostEntry: HOST_ENTRY,
      detach: false,
      browserOpener: async (url) => {
        opened.push(url);
      },
    });
    processIds.add(launched.processId);
    expect(launched.result).toMatchObject({
      status: "started",
      runtime_state: "ready",
      browser: "opened",
    });
    expect(opened).toHaveLength(1);

    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    const browserEvents: string[] = [];
    page.on("console", (message) => browserEvents.push(`console:${message.type()}:${message.text()}`));
    page.on("pageerror", (error) => browserEvents.push(`pageerror:${error.message}`));
    page.on("requestfailed", (request) =>
      browserEvents.push(`requestfailed:${request.url()}:${request.failure()?.errorText ?? "unknown"}`)
    );
    page.on("response", (response) => {
      if (response.url().includes("/api/")) {
        browserEvents.push(`response:${response.status()}:${response.url()}`);
      }
    });
    await page.goto(opened[0] ?? "", { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1, name: "记忆", exact: true }).waitFor();
    expect(page.url()).not.toContain("ticket=");
    expect(page.url()).not.toContain("#");

    const memoryButton = page.getByRole("button", { name: new RegExp(original, "u") });
    try {
      await memoryButton.waitFor({ timeout: 10_000 });
    } catch {
      throw new Error(JSON.stringify({
        url: page.url(),
        body: (await page.locator("body").innerText()).slice(0, 4_000),
        browserEvents,
      }));
    }
    await memoryButton.click();
    await page.getByRole("heading", { name: "纠正当前记忆" }).waitFor();
    await page.getByLabel("替换内容").fill(corrected);
    await page.getByLabel("纠正理由（必填）").fill(
      "E2E verifies the packaged browser mutation boundary",
    );
    await page.getByRole("button", { name: "生成纠正预览" }).click();
    await page.getByRole("heading", { name: "封存预览" }).waitFor();
    await page.getByRole("button", { name: "确认应用纠正" }).click();
    await page.getByRole("dialog").getByRole("button", {
      name: "确认并创建新修订",
    }).click();
    await page.getByRole("heading", { name: "新修订已发布" }).waitFor();

    await page.getByRole("link", { name: /Graph/u }).click();
    await page.getByRole("heading", { name: "节点" }).waitFor();
    expect(await page.locator(".semantic-graph").isVisible()).toBe(true);

    await page.getByRole("link", { name: /运行仪表盘/u }).click();
    await page.getByRole("heading", { name: "Canonical authority" }).waitFor();
    expect(await page.getByText("writer_lease").isVisible()).toBe(true);
    expect(
      await page.locator(
        ".runtime-dashboard button, .runtime-dashboard input, .runtime-dashboard select, .runtime-dashboard textarea",
      ).count(),
    ).toBe(0);
    const screenshotPath = process.env.MEMO_WORKBENCH_SCREENSHOT;
    if (screenshotPath !== undefined) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    await browser.close();
    browsers.splice(browsers.indexOf(browser), 1);
    process.kill(launched.processId, "SIGTERM");
    await waitUntilStopped(launched.processId);
    processIds.delete(launched.processId);
    expect(existsSync(join(dataRoot, ".memo-graph-writer.lock"))).toBe(false);

    const reopened = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: recovery.provider,
    });
    try {
      const detail = await reopened.getWorkbenchMemoryDetail({
        principal_id: "user_local",
        allowed_scopes: [scope],
        as_of: new Date().toISOString(),
        include_sensitive: false,
        context_scope: null,
        max_history: 20,
        max_provenance_nodes: 40,
        request: {
          memory_id: admitted.memory_id,
          revision_id: null,
        },
      });
      expect(detail.status).toBe("ready");
      if (detail.status !== "ready") {
        throw new Error("expected the corrected memory after clean shutdown");
      }
      expect(detail.memory.content).toMatchObject({
        status: "available",
        text: corrected,
      });
    } finally {
      await reopened.close();
    }
  }, 60_000);
});

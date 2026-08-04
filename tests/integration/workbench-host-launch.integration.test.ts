import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  launchOrReuseWorkbench,
} from "../../apps/memory-workbench-host/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";

const cleanupPaths: string[] = [];
const activeProcessIds = new Set<number>();
const HOST_ENTRY = resolve(
  "apps/memory-workbench-host/dist/cli.js",
);

async function fixture() {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-workbench-launch-")),
  );
  cleanupPaths.push(root);
  const dataRoot = join(root, "data");
  const recovery = mcpRecoveryFixture(dataRoot);
  const storage = await SqliteStorageClient.open({
    dataRoot,
    recoveryHeadProvider: recovery.provider,
  });
  await storage.close();
  return {
    root,
    runtimeDirectory: join(root, "runtime"),
    config: {
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [
        { kind: "workspace", id: "workspace_local" },
      ],
      allowed_authorities: ["user_stated"],
      recovery_head: recovery.config,
    } as const,
  };
}

async function waitUntilStopped(processId: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(processId, 0);
    } catch {
      return;
    }
    await new Promise((resolve_) => setTimeout(resolve_, 20));
  }
}

afterEach(async () => {
  for (const processId of activeProcessIds) {
    try {
      process.kill(processId, "SIGTERM");
    } catch {
      // The process already stopped.
    }
  }
  await Promise.all([...activeProcessIds].map(waitUntilStopped));
  activeProcessIds.clear();
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("memory workbench management launcher", () => {
  it("opens one authenticated tab and returns a launch URL when opening is suppressed or fails", async () => {
    const current = await fixture();
    const openedUrls: string[] = [];
    const started = await launchOrReuseWorkbench({
      config: current.config,
      runtimeDirectory: current.runtimeDirectory,
      hostEntry: HOST_ENTRY,
      detach: false,
      browserOpener: async (url) => {
        openedUrls.push(url);
      },
    });
    activeProcessIds.add(started.processId);

    expect(started.result).toMatchObject({
      status: "started",
      runtime_state: "ready",
      browser: "opened",
      recovery: "none",
    });
    expect(started.launchUrl).toBeNull();
    expect(openedUrls).toHaveLength(1);
    expect(JSON.stringify(started.result)).not.toContain("ticket");
    expect(JSON.stringify(started.result)).not.toContain("pairing");

    const opened = new URL(openedUrls[0] ?? "");
    const fragment = new URLSearchParams(opened.hash.slice(1));
    const ticket = fragment.get("ticket");
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const exchange = async () =>
      fetch(`${started.result.origin}/api/session/exchange`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: started.result.origin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          instance_id: started.result.instance_id,
          ticket,
        }),
      });
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(401);

    let unexpectedOpens = 0;
    const reused = await launchOrReuseWorkbench({
      config: current.config,
      runtimeDirectory: current.runtimeDirectory,
      hostEntry: HOST_ENTRY,
      noOpen: true,
      detach: false,
      browserOpener: async () => {
        unexpectedOpens += 1;
      },
    });
    expect(reused.result.status).toBe("reused");
    expect(reused.processId).toBe(started.processId);
    expect(reused.result.browser).toBe("suppressed");
    expect(reused.result.recovery).toBe("open_launch_url");
    expect(reused.launchUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]{43}&instance=workbench:/u,
    );
    expect(unexpectedOpens).toBe(0);

    const failedOpen = await launchOrReuseWorkbench({
      config: current.config,
      runtimeDirectory: current.runtimeDirectory,
      hostEntry: HOST_ENTRY,
      detach: false,
      browserOpener: async () => {
        throw new Error("injected opener failure");
      },
    });
    expect(failedOpen.result).toMatchObject({
      status: "reused",
      browser: "failed",
      recovery: "open_launch_url",
    });
    expect(failedOpen.launchUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]{43}&instance=workbench:/u,
    );
    const baseOnly = await fetch(`${started.result.origin}/api/health`);
    expect(baseOnly.status).toBe(401);
  }, 30_000);

  it("arbitrates concurrent launchers to exactly one Runtime owner", async () => {
    const current = await fixture();
    let openCalls = 0;
    const launch = () =>
      launchOrReuseWorkbench({
        config: current.config,
        runtimeDirectory: current.runtimeDirectory,
        hostEntry: HOST_ENTRY,
        noOpen: true,
        detach: false,
        browserOpener: async () => {
          openCalls += 1;
        },
      });

    const outcomes = await Promise.all([launch(), launch()]);
    for (const outcome of outcomes) {
      activeProcessIds.add(outcome.processId);
    }
    expect(outcomes.map(({ result }) => result.status).sort()).toEqual([
      "reused",
      "started",
    ]);
    expect(new Set(outcomes.map(({ processId }) => processId)).size).toBe(1);
    expect(new Set(outcomes.map(({ result }) => result.instance_id)).size)
      .toBe(1);
    expect(outcomes.every(({ launchUrl }) => launchUrl !== null)).toBe(true);
    expect(openCalls).toBe(0);
  }, 30_000);
});

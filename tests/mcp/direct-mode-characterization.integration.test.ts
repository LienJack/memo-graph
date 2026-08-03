import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryServerConfigSchema,
  openMemoryRuntime,
  preflightMemoryRuntime,
} from "../../packages/mcp-server/src/index.js";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-direct-mode-")),
  );
  cleanupPaths.push(root);
  return root;
}

function configFixture(dataRoot: string) {
  return {
    data_root: dataRoot,
    principal_id: "user_local",
    allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
    allowed_authorities: ["user_stated"],
  } as const;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("direct MCP runtime characterization", () => {
  it("keeps direct defaults, one writer, and close-then-reopen ownership", async () => {
    const dataRoot = temporaryRoot();
    const config = configFixture(dataRoot);
    const parsed = MemoryServerConfigSchema.parse(config);

    expect(parsed).toMatchObject({
      destructive_tools_enabled: false,
      default_token_budget: 1_800,
      graph: { enabled: false },
      vector: { enabled: false },
      recovery_head: { enabled: false },
      lane_policy: { allowed_lanes: ["recent_l1"] },
    });

    const first = await openMemoryRuntime(config);
    try {
      const contender = await preflightMemoryRuntime(config, {
        observedAt: "2026-08-02T08:00:00.000Z",
      });
      expect(contender.state).toBe("blocked");
      if (contender.state !== "blocked") {
        await contender.opened.close();
        throw new Error("a second direct writer must not open");
      }
      expect(contender.status.readiness).toBe("blocked");
      expect((await first.storage.health()).root_lease).not.toBeNull();
    } finally {
      await first.close();
    }

    const reopened = await openMemoryRuntime(config);
    await reopened.close();
  });
});

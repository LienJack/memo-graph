import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  seedLayeredProjectionSources,
} from "../helpers/projection-examples.js";

const cleanupPaths: string[] = [];
const NOW = "2026-07-28T12:12:00.000Z";
const SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g3-runtime-")),
  );
  cleanupPaths.push(root);
  return root;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("G3 layered runtime regression", () => {
  it("keeps the operator-default path on governed L1 semantics", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot(),
    });
    await seedLayeredProjectionSources(storage);
    const runtime = new MemoryRuntime({
      storage,
      clock: () => NOW,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: [SCOPE],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: false,
        },
        default_token_budget: 1_800,
      },
    });
    const result = await runtime.memoryContextCompile({
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_g3_l1_runtime_regression",
        tool: "memory_context_compile",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [SCOPE],
        purpose: "verify the accepted lower-layer fallback",
        reason: "G3 must not silently enable projection lanes",
        requested_at: NOW,
        safety_class: "read_only",
      },
      recall: {
        schema_version: "1.0.0",
        request_id: "request_g3_l1_runtime_regression",
        goal: "recall governed memory",
        query: "agent memory",
        scopes: [SCOPE],
        as_of: NOW,
        token_budget: 1_800,
        include_sensitive: false,
      },
    });

    expect(["OK", "DEGRADED"]).toContain(result.status);
    if (result.status !== "OK" && result.status !== "DEGRADED") {
      throw new Error("default L1 regression fixture must return Context");
    }
    if (result.status === "DEGRADED") {
      expect(result.fallback_lane).toBe("partial_sqlite_fts");
    }
    const context = (
      result.data as {
        context_slice: {
          items: Array<{
            abstraction: string;
            lane?: string;
            projection?: unknown;
          }>;
        };
      }
    ).context_slice;
    expect(
      context.items.every(
        (item) =>
          item.abstraction === "l1_memory" &&
          item.projection === undefined,
      ),
    ).toBe(true);
    await storage.close();
  });
});

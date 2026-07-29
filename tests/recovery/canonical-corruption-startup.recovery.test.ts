import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../apps/operator-cli/src/commands/doctor.js";
import {
  preflightMemoryRuntime,
} from "../../packages/mcp-server/src/index.js";
import {
  SqliteStorageClient,
  StorageError,
} from "@memo-graph/storage-sqlite";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-corrupt-startup-")),
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

function serverConfig(dataRoot: string) {
  return {
    data_root: dataRoot,
    principal_id: "user_local",
    allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
    allowed_authorities: ["user_stated"],
    destructive_tools_enabled: false,
  };
}

async function initializedDataRoot(): Promise<string> {
  const dataRoot = join(temporaryRoot(), "data");
  const storage = await SqliteStorageClient.open({ dataRoot });
  await storage.close();
  return dataRoot;
}

describe("canonical corruption startup", () => {
  it("returns blocked health instead of a serveable runtime", async () => {
    const dataRoot = join(temporaryRoot(), "data");
    const status = await runDoctor(
      {
        dataRoot,
        qualification: {
          status: "pending",
          tested_envelope_digest: null,
        },
      },
      {
        now: () => "2026-07-30T09:00:00.000Z",
        inspectStorage: async () => {
          throw new StorageError("CORRUPTION");
        },
      },
    );
    expect(status).toMatchObject({
      readiness: "blocked",
      exit_class: "operator_action_required",
    });
    expect(JSON.stringify(status)).not.toContain("canonical-plaintext-marker");
  });

  it("classifies unsafe roots and migration drift through MCP preflight", async () => {
    const unsafe = await preflightMemoryRuntime(
      serverConfig("/Volumes/unsupported-memory-root"),
      { observedAt: "2026-07-30T09:00:00.000Z" },
    );
    expect(unsafe).toMatchObject({
      state: "blocked",
      status: {
        primary_reason: "DATA_ROOT_UNSAFE",
        readiness: "blocked",
      },
    });

    const dataRoot = await initializedDataRoot();
    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    database
      .prepare(
        `INSERT INTO schema_migrations (version, name, hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "9999",
        "9999-drift.sql",
        `sha256:${"f".repeat(64)}`,
        "2026-07-30T09:00:00.000Z",
      );
    database.close();
    const drift = await preflightMemoryRuntime(serverConfig(dataRoot), {
      observedAt: "2026-07-30T09:00:00.000Z",
    });
    expect(drift).toMatchObject({
      state: "blocked",
      status: {
        primary_reason: "MIGRATION_DRIFT",
        readiness: "blocked",
      },
    });
  });

  it("classifies a corrupt canonical database through MCP preflight", async () => {
    const dataRoot = await initializedDataRoot();
    writeFileSync(join(dataRoot, "ledger", "memory.db"), "not-a-sqlite-db");
    const result = await preflightMemoryRuntime(serverConfig(dataRoot), {
      observedAt: "2026-07-30T09:00:00.000Z",
    });
    expect(result).toMatchObject({
      state: "blocked",
      status: {
        primary_reason: "CANONICAL_CORRUPTION",
        readiness: "blocked",
      },
    });
  });
});

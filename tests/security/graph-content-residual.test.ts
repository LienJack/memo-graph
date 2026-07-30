import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ScopeSchema,
} from "../../packages/contracts/src/index.js";
import {
  ExactScopeGraphProjector,
  GraphProcessHost,
  type GraphProcessDiagnostic,
} from "../../packages/graph-projection/src/index.js";
import {
  ConsolidationService,
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import { testRecoveryHeadProvider } from "../helpers/recovery.js";

import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  applyCompleteGraphProjectionFixture,
  installedGraphBackendIdentity,
} from "../helpers/graph-runtime-examples.js";
import {
  PURGE_NOW,
  deleteRequest,
} from "../helpers/purge-examples.js";

const roots: string[] = [];
const hosts: GraphProcessHost[] = [];
const SECRET = "SQLite is the canonical memory authority.";
const SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_local",
});

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-u6-residual-")),
  );
  roots.push(root);
  return root;
}

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const nativeIt =
  process.platform === "darwin" && process.arch === "arm64"
    ? it
    : it.skip;

describe("graph content residual security", () => {
  nativeIt("keeps purged plaintext out of graph-derived and diagnostic surfaces", async () => {
    const dataRoot = temporaryRoot();
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:graph-residual",
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider,
    });
    const diagnostics: GraphProcessDiagnostic[] = [];
    const graph = await GraphProcessHost.open({
      dataRoot,
      expectedIdentity: await installedGraphBackendIdentity(),
      childEntry: new URL(
        "../../packages/graph-projection/dist/ladybug-process.js",
        import.meta.url,
      ),
      requestTimeoutMs: 250,
      writeTimeoutMs: 10_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    hosts.push(graph);
    try {
      const fixture = await applyCompleteGraphProjectionFixture(storage);
      const projector = new ExactScopeGraphProjector({
        storage,
        store: graph,
        workerId: "graph_u6_residual_initial",
        clock: () => new Date("2026-07-29T10:20:00.000Z"),
      });
      await expect(projector.drain()).resolves.toMatchObject({
        claimed: 1,
        applied: 1,
      });

      const source = fixture.sources[0];
      const approvals = new TestApprovalRegistry();
      const kernel = new MemoryRuntime({
        storage,
        approvalRegistry: approvals,
        clock: () => PURGE_NOW,
        policy: {
          principal: {
            principal_id: "user_local",
            allowed_scopes: [SCOPE],
            allowed_authorities: ["user_stated"],
            destructive_tools_enabled: true,
          },
          default_token_budget: 1_800,
        },
      });
      const request = deleteRequest({
        memoryId: source.memory_id,
        revisionId: source.revision_id,
        idempotencyKey: "graph-u6-residual-delete-0001",
        approvalId: "approval_graph_u6_residual_delete",
      });
      approvals.approve(request);
      const deleted = await kernel.memoryDelete(request);
      if (deleted.status !== "OK") {
        throw new Error("graph residual deletion failed");
      }
      const purgeJobId = (
        deleted.data as { purge_job_id: string }
      ).purge_job_id;
      await expect(
        storage.runPurge({ purge_job_id: purgeJobId }),
      ).resolves.toMatchObject({
        completed: true,
        residual_hashes: [],
      });

      await new ConsolidationService({ storage }).drain({
        worker_id: "graph_u6_residual_projection",
        claimed_at: "2026-07-28T13:01:00.000Z",
        lease_expires_at: "2026-07-28T13:02:00.000Z",
      });
      await expect(
        new ExactScopeGraphProjector({
          storage,
          store: graph,
          workerId: "graph_u6_residual_replacement",
          clock: () => new Date("2026-07-29T10:21:00.000Z"),
        }).drain(),
      ).resolves.toMatchObject({ failed: 0, stale: 0 });

      const graphSnapshot = await graph.readScopeSnapshot({
        principal_id: "user_local",
        scope: SCOPE,
      });
      const checkpoint = await storage.graphProjectionCheckpoint({
        principal_id: "user_local",
        scope: SCOPE,
      });
      const status = await storage.graphProjectionStatus();
      const backup = await storage.createBackup();
      for (const surface of [
        graphSnapshot,
        checkpoint,
        status,
        diagnostics,
        backup,
      ]) {
        expect(JSON.stringify(surface)).not.toContain(SECRET);
      }
    } finally {
      await graph.close();
      hosts.splice(hosts.indexOf(graph), 1);
      await storage.close();
    }

    for (const path of filesUnder(dataRoot)) {
      expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false);
    }
  }, 30_000);
});

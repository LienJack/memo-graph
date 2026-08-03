import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ScopeSchema,
} from "../../packages/contracts/src/index.js";
import {
  ConsolidationService,
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  applyCompleteGraphProjectionFixture,
} from "../helpers/graph-runtime-examples.js";
import {
  InMemoryGraphStore,
  projectAllReady,
} from "../helpers/in-memory-graph-store.js";
import {
  PURGE_NOW,
  deleteRequest,
} from "../helpers/purge-examples.js";

const roots: string[] = [];
const SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_local",
});

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-u6-${prefix}-`)),
  );
  roots.push(root);
  return root;
}

function runtime(
  storage: SqliteStorageClient,
  approvals: TestApprovalRegistry,
): MemoryRuntime {
  return new MemoryRuntime({
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
}

function envelope(options: {
  tool: "memory_demote" | "memory_usage_set" | "memory_revoke";
  revisionId: string;
  suffix: string;
}) {
  return {
    schema_version: "1.0.0",
    request_id: `request_graph_u6_${options.suffix}`,
    tool: options.tool,
    safety_class: "important_mutation" as const,
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated" as const,
    },
    scopes: [SCOPE],
    purpose: "Prove graph governance propagation",
    reason: "Exercise one exact governed control",
    requested_at: PURGE_NOW,
    idempotency_key: `graph-u6-${options.suffix}-0001`,
    expected_revision_id: options.revisionId,
    approval_id: `approval_graph_u6_${options.suffix}`,
    dry_run: false,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("graph purge and lifecycle propagation", () => {
  for (const control of [
    "usage_block",
    "demote",
    "revoke",
    "delete_and_purge",
  ] as const) {
    it(`${control} suppresses the source node and relation descendants`, async () => {
      const storage = await SqliteStorageClient.open({
        dataRoot: temporaryRoot(control),
      });
      const store = new InMemoryGraphStore();
      try {
        const fixture = await applyCompleteGraphProjectionFixture(storage);
        await projectAllReady({
          storage,
          store,
          workerId: `graph_u6_${control}_initial`,
        });
        const source = fixture.sources[0];
        const relation = fixture.projections.find(
          (projection) => projection.projection_type === "relation",
        );
        if (relation === undefined) {
          throw new Error("graph governance fixture relation is missing");
        }
        const approvals = new TestApprovalRegistry();
        const kernel = runtime(storage, approvals);

        if (control === "delete_and_purge") {
          const request = deleteRequest({
            memoryId: source.memory_id,
            revisionId: source.revision_id,
            idempotencyKey: "graph-u6-delete-purge-0001",
            approvalId: "approval_graph_u6_delete_purge",
          });
          approvals.approve(request);
          const deleted = await kernel.memoryDelete(request);
          if (deleted.status !== "OK") {
            throw new Error("graph purge fixture deletion failed");
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
        } else {
          const tool =
            control === "usage_block"
              ? "memory_usage_set"
              : control === "demote"
                ? "memory_demote"
                : "memory_revoke";
          const request = {
            envelope: envelope({
              tool,
              revisionId: source.revision_id,
              suffix: control,
            }),
            memory_id: source.memory_id,
            ...(control === "usage_block"
              ? { effect: "block" as const, context_scope: SCOPE }
              : {}),
          };
          approvals.approve(request);
          const response =
            control === "usage_block"
              ? await kernel.memoryUsageSet(request)
              : control === "demote"
                ? await kernel.memoryDemote(request)
                : await kernel.memoryRevoke(request);
          expect(response.status).toBe("OK");
        }

        await expect(
          storage.graphProjectionCheckpoint({
            principal_id: "user_local",
            scope: SCOPE,
          }),
        ).resolves.toMatchObject({
          status: "pending",
          frontier: null,
          logical_digest: null,
          backend_identity: null,
        });

        await new ConsolidationService({ storage }).drain({
          worker_id: `graph_u6_${control}_projection`,
          claimed_at: "2026-07-28T13:01:00.000Z",
          lease_expires_at: "2026-07-28T13:02:00.000Z",
        });
        const canonical = (
          await storage.graphScopeSnapshot({
            principal_id: "user_local",
            scope: SCOPE,
          })
        ).snapshot;
        expect(
          canonical.nodes.map((node) => node.revision_id),
        ).not.toContain(source.revision_id);
        expect(
          canonical.edges.map((edge) => edge.relation_revision_id),
        ).not.toContain(relation.projection_revision_id);

        await expect(
          projectAllReady({
            storage,
            store,
            workerId: `graph_u6_${control}_replacement`,
            completedAt: "2026-07-28T13:03:00.000Z",
          }),
        ).resolves.toMatchObject({ failed: 0, stale: 0 });
        const delivered = await store.readScopeSnapshot({
          principal_id: "user_local",
          scope: SCOPE,
        });
        expect(delivered).toEqual(canonical);
      } finally {
        await store.close();
        await storage.close();
      }
    });
  }
});

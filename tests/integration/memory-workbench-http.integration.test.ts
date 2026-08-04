import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  startMemoryWorkbenchHost,
  type MemoryWorkbenchHost,
} from "../../apps/memory-workbench-host/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const NOW = "2026-08-02T12:00:00.000Z";
const INSTANCE = "workbench:http-integration";
const scope = { kind: "workspace", id: "workspace_local" } as const;
const cleanupPaths: string[] = [];
const hosts: MemoryWorkbenchHost[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-workbench-http-")),
  );
  cleanupPaths.push(root);
  return root;
}

async function exchange(
  host: MemoryWorkbenchHost,
  ticket: string,
): Promise<{ bearer: string }> {
  const response = await fetch(`${host.http.origin}/api/session/exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: host.http.origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ instance_id: INSTANCE, ticket }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { bearer: string };
}

async function post(
  host: MemoryWorkbenchHost,
  bearer: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${host.http.origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      origin: host.http.origin,
      "sec-fetch-site": "same-origin",
      "x-memo-graph-instance": INSTANCE,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("memory workbench authenticated HTTP workflow", () => {
  it("reads SQLite authority, previews without writes, and commits one successor idempotently", async () => {
    const root = temporaryRoot();
    const dataRoot = join(root, "data");
    const recovery = mcpRecoveryFixture(dataRoot);
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: recovery.provider,
    });
    await storage.commitEpisode(inlineEpisode({}));
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_workbench_http_source",
          logicalKey: "workbench.http.source",
          scope,
          text: "Original authenticated workbench memory",
        }),
        idempotencyKey: "workbench-http-source-0001",
        requestId: "request_workbench_http_source",
      }),
      evaluation: {
        decision: "activate",
        reason: "exact-scope user evidence is eligible",
      },
    });
    await storage.close();

    const host = await startMemoryWorkbenchHost({
      config: {
        data_root: dataRoot,
        principal_id: "user_local",
        allowed_scopes: [scope],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: true,
        recovery_head: recovery.config,
      },
      runtimeDirectory: join(root, "runtime"),
      instanceId: INSTANCE,
      clock: () => NOW,
    });
    hosts.push(host);
    expect(host.endpoint.runtime_state).toBe("ready");
    expect(host.initialBootstrap.ticket).not.toBeNull();

    const application = await fetch(`${host.http.origin}/`);
    const applicationHtml = await application.text();
    expect(application).toMatchObject({ status: 200 });
    expect(applicationHtml).toContain(`data-instance="${INSTANCE}"`);
    expect(applicationHtml).not.toContain("bootstrap.js");
    expect(applicationHtml).not.toContain(host.initialBootstrap.ticket);
    const mainAsset = applicationHtml.match(/src="(\/assets\/[^"]+\.js)"/u)?.[1];
    expect(mainAsset).toBeTypeOf("string");
    const asset = await fetch(`${host.http.origin}${mainAsset ?? ""}`);
    expect(asset).toMatchObject({ status: 200 });
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    const applicationScript = await asset.text();
    expect(applicationScript).not.toContain("/api/session/pair");
    expect(applicationScript).not.toContain("配对码");

    const authority = await exchange(
      host,
      host.initialBootstrap.ticket ?? "",
    );

    const healthResponse = await fetch(`${host.http.origin}/api/health`, {
      headers: {
        authorization: `Bearer ${authority.bearer}`,
        "x-memo-graph-instance": INSTANCE,
        "sec-fetch-site": "same-origin",
      },
    });
    const health = await healthResponse.json() as Record<string, unknown>;
    expect(healthResponse.status).toBe(200);
    expect(health).toMatchObject({
      status: "ready",
      runtime_state: "ready",
      canonical: {
        component: "canonical_storage",
        authority_plane: "canonical",
        observation_scope: "canonical_root",
        state: "healthy",
      },
      runtime: {
        component: "runtime_owner",
        observation_scope: "runtime_instance",
        state: "healthy",
      },
      projections: expect.arrayContaining([
        expect.objectContaining({
          component: "fts_projection",
          observation_scope: "configured_scopes",
        }),
        expect.objectContaining({
          component: "layered_projection",
          observation_scope: "configured_scopes",
        }),
        expect.objectContaining({
          component: "graph_projection",
          observation_scope: "configured_scopes",
          state: "unavailable",
        }),
      ]),
      lanes: expect.arrayContaining([
        expect.objectContaining({ lane: "writer_lease" }),
        expect.objectContaining({ lane: "consolidation" }),
      ]),
    });
    expect(JSON.stringify(health)).not.toContain(
      "Original authenticated workbench memory",
    );
    expect(JSON.stringify(health)).not.toContain(authority.bearer);

    const listed = await post(
      host,
      authority.bearer,
      "/api/workbench/memories/query",
      { limit: 20 },
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      status: "ready",
      items: [
        {
          memory_id: admitted.memory_id,
          revision_id: admitted.current_revision_id,
          is_current: true,
          writable: true,
        },
      ],
    });

    const detailed = await post(
      host,
      authority.bearer,
      "/api/workbench/memories/detail",
      { memory_id: admitted.memory_id, revision_id: null },
    );
    expect(detailed.body).toMatchObject({
      status: "ready",
      memory: {
        memory_id: admitted.memory_id,
        revision_id: admitted.current_revision_id,
      },
    });

    const graph = await post(
      host,
      authority.bearer,
      "/api/workbench/graph/query",
      {
        scope,
        center: {
          kind: "memory_revision",
          revision_id: admitted.current_revision_id,
        },
        max_depth: 1,
        max_fanout: 10,
        max_nodes: 20,
        max_edges: 30,
      },
    );
    expect(graph.body).toEqual(
      expect.objectContaining({
        status: "degraded",
        center_node_id: admitted.current_revision_id,
        nodes: expect.arrayContaining([
          expect.objectContaining({
            node_id: admitted.current_revision_id,
            authority_plane: "canonical",
          }),
        ]),
        projection_state: "pending",
      }),
    );

    const beforePreview = await host.runtime?.runtime.storage.health();
    const preview = await post(
      host,
      authority.bearer,
      "/api/workbench/corrections/preview",
      {
        memory_id: admitted.memory_id,
        expected_revision_id: admitted.current_revision_id,
        replacement: { text: "Corrected authenticated workbench memory" },
        reason: "The operator explicitly corrected the current memory",
      },
    );
    expect(preview.body).toMatchObject({
      status: "ready",
      memory_id: admitted.memory_id,
      expected_revision_id: admitted.current_revision_id,
    });
    const afterPreview = await host.runtime?.runtime.storage.health();
    expect(afterPreview).toMatchObject({
      ledger_epoch: beforePreview?.ledger_epoch,
      counts: {
        evidence_events: beforePreview?.counts.evidence_events,
        memory_revisions: beforePreview?.counts.memory_revisions,
        approval_consumptions: beforePreview?.counts.approval_consumptions,
      },
    });

    const previewId = String(preview.body.preview_id);
    const confirmed = await post(
      host,
      authority.bearer,
      "/api/workbench/corrections/confirm",
      { preview_id: previewId, confirmed: true },
    );
    expect(confirmed.body).toMatchObject({
      status: "ready",
      replayed: false,
      memory_id: admitted.memory_id,
      previous_revision_id: admitted.current_revision_id,
    });
    expect(confirmed.body.current_revision_id).not.toBe(
      admitted.current_revision_id,
    );

    const replayed = await post(
      host,
      authority.bearer,
      "/api/workbench/corrections/confirm",
      { preview_id: previewId, confirmed: true },
    );
    expect(replayed.body).toMatchObject({
      status: "ready",
      replayed: true,
      receipt: confirmed.body.receipt,
    });

    const successor = await post(
      host,
      authority.bearer,
      "/api/workbench/memories/detail",
      { memory_id: admitted.memory_id, revision_id: null },
    );
    expect(successor.body).toMatchObject({
      status: "ready",
      memory: {
        memory_id: admitted.memory_id,
        revision_id: confirmed.body.current_revision_id,
        is_current: true,
      },
      history: expect.arrayContaining([
        expect.objectContaining({
          revision_id: admitted.current_revision_id,
          is_current: false,
        }),
      ]),
    });
    expect(JSON.stringify(successor.body)).toContain(
      "The operator explicitly corrected the current memory",
    );

    const secondTicket = host.http.sessions.issueTicket();
    const secondAuthority = await exchange(host, secondTicket.ticket);
    const stale = await post(
      host,
      secondAuthority.bearer,
      "/api/workbench/corrections/preview",
      {
        memory_id: admitted.memory_id,
        expected_revision_id: admitted.current_revision_id,
        replacement: { text: "Stale competing correction" },
        reason: "This preview started from the superseded revision",
      },
    );
    expect(stale.body).toMatchObject({
      status: "stale",
      reason_code: "STALE_REVISION",
    });
  }, 30_000);
});

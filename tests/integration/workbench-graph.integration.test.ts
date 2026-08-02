import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { NOW } from "../helpers/examples.js";
import { applyCompleteGraphProjectionFixture } from "../helpers/graph-runtime-examples.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const scope = { kind: "workspace", id: "workspace_local" } as const;

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-workbench-graph-")),
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

describe("workbench bounded Graph reader", () => {
  it("composes governed relations and projection lineage around a real revision", async () => {
    const storage = await SqliteStorageClient.open({ dataRoot: temporaryRoot() });
    const fixture = await applyCompleteGraphProjectionFixture(storage);
    const center = fixture.sources[0];

    const graph = await storage.getWorkbenchGraph({
      principal_id: "user_local",
      allowed_scopes: [scope],
      as_of: NOW,
      include_sensitive: false,
      context_scope: null,
      request: {
        scope,
        center: {
          kind: "memory_revision",
          revision_id: center.revision_id,
        },
        max_depth: 2,
        max_fanout: 20,
        max_nodes: 40,
        max_edges: 80,
      },
    });
    expect(["ready", "degraded"]).toContain(graph.status);
    if (graph.status !== "ready" && graph.status !== "degraded") {
      throw new Error("expected graph content");
    }
    expect(graph.center_node_id).toBe(center.revision_id);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node_id: center.revision_id,
          kind: "memory_revision",
          authority_plane: "canonical",
        }),
        expect.objectContaining({ kind: "topic", authority_plane: "projection" }),
        expect.objectContaining({ kind: "scenario", authority_plane: "projection" }),
        expect.objectContaining({ kind: "procedure", authority_plane: "projection" }),
        expect.objectContaining({ kind: "core", authority_plane: "projection" }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "derived_from",
          authority_plane: "projection_lineage",
        }),
        expect.objectContaining({
          relation: "supports",
          authority_plane: "governed_relation",
        }),
      ]),
    );
    expect(graph.nodes.every((node) => node.scope.id === scope.id)).toBe(true);
    await storage.close();
  });

  it("reports exact retained bounds instead of expanding the complete graph", async () => {
    const storage = await SqliteStorageClient.open({ dataRoot: temporaryRoot() });
    const fixture = await applyCompleteGraphProjectionFixture(storage);
    const graph = await storage.getWorkbenchGraph({
      principal_id: "user_local",
      allowed_scopes: [scope],
      as_of: NOW,
      include_sensitive: false,
      context_scope: null,
      request: {
        scope,
        center: {
          kind: "memory_revision",
          revision_id: fixture.sources[0].revision_id,
        },
        max_depth: 1,
        max_fanout: 2,
        max_nodes: 2,
        max_edges: 1,
      },
    });
    expect(graph.status).toBe("degraded");
    if (graph.status !== "degraded") {
      throw new Error("expected a bounded degraded graph");
    }
    expect(graph.nodes.length).toBeLessThanOrEqual(2);
    expect(graph.edges.length).toBeLessThanOrEqual(1);
    expect(graph.truncated).toBe(true);
    expect(graph.omitted_node_count + graph.omitted_edge_count).toBeGreaterThan(0);
    await storage.close();
  });

  it("does not disclose a sensitive center when the session excludes sensitive memory", async () => {
    const storage = await SqliteStorageClient.open({ dataRoot: temporaryRoot() });
    const episode = inlineEpisode({});
    await storage.commitEpisode({
      ...episode,
      evidence: episode.evidence.map((evidence) => ({
        ...evidence,
        sensitivity: "sensitive" as const,
      })),
    });
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_workbench_graph_sensitive",
          logicalKey: "workbench.graph.sensitive",
          scope,
          sensitivity: "sensitive",
          text: "Sensitive graph content must not cross the browser boundary",
        }),
        idempotencyKey: "workbench-graph-sensitive-0001",
        requestId: "request_workbench_graph_sensitive",
      }),
      evaluation: {
        decision: "quarantine",
        reason: "fixture verifies the browser sensitivity boundary",
      },
    });

    const graph = await storage.getWorkbenchGraph({
      principal_id: "user_local",
      allowed_scopes: [scope],
      as_of: NOW,
      include_sensitive: false,
      context_scope: null,
      request: {
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
    });

    expect(graph).toEqual({
      status: "not_found",
      reason_code: "GRAPH_CENTER_NOT_FOUND",
      retryable: false,
      warnings: [],
    });
    expect(JSON.stringify(graph)).not.toContain("Sensitive graph content");
    await storage.close();
  });
});

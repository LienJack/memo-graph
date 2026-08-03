import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  GraphBackendIdentitySchema,
  ProjectionRevisionSchema,
  canonicalJson,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  projectionFrontier,
  seedProjectionSources,
} from "./projection-examples.js";
import { NOW } from "./examples.js";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";

export async function installedGraphBackendIdentity() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@ladybugdb/core");
  const binary = await readFile(join(dirname(entry), "lbugjs.node"));
  const lockfile = await readFile(
    new URL("../../pnpm-lock.yaml", import.meta.url),
  );
  return GraphBackendIdentitySchema.parse({
    schema_version: "1.0.0",
    backend: "ladybugdb",
    package_name: "@ladybugdb/core",
    package_version: "0.18.3",
    storage_version: "42",
    platform: process.platform,
    architecture: process.arch,
    native_binary_hash:
      `sha256:${createHash("sha256").update(binary).digest("hex")}`,
    dependency_lock_hash:
      `sha256:${createHash("sha256").update(lockfile).digest("hex")}`,
  });
}

export async function applyCompleteGraphProjectionFixture(
  storage: SqliteStorageClient,
  options: {
    relationSensitivity?: "personal" | "sensitive";
    relationDescription?: string;
  } = {},
) {
  const sources = await seedProjectionSources(storage);
  const health = await storage.health();
  const frontier = projectionFrontier({
    ledgerEpoch: health.ledger_epoch,
    tombstoneEpoch: health.tombstone_epoch,
    projectionEpoch: health.projection_frontier.projection_epoch + 1,
  });
  const definitions = [
    {
      projection_type: "topic",
      abstraction: "l2_topic",
      payload: {
        kind: "topic",
        key: "governed memory",
        summary: "SQLite remains authoritative.",
        open_items: ["Measure structural utility."],
      },
    },
    {
      projection_type: "scenario",
      abstraction: "l2_scenario",
      payload: {
        kind: "scenario",
        key: "stale graph",
        trigger: "A canonical frontier changes.",
        preconditions: ["A graph projection exists."],
        outcomes: ["The stale graph is excluded."],
      },
    },
    {
      projection_type: "procedure",
      abstraction: "l2_scenario",
      payload: {
        kind: "procedure",
        key: "rebuild graph",
        goal: "Rebuild from canonical SQLite.",
        preconditions: ["SQLite verification passes."],
        steps: ["Create a fresh graph generation.", "Compare digests."],
        exceptions: [],
        failure_modes: ["Digest mismatch."],
        recovery_steps: ["Quarantine the generation."],
      },
    },
    {
      projection_type: "relation",
      abstraction: "l2_relation",
      payload: {
        kind: "relation",
        source_revision_id: sources[0].revision_id,
        target_revision_id: sources[1].revision_id,
        relation_type: "supports",
        direction: "directed",
        description:
          options.relationDescription ??
          "Authority supports exact revalidation.",
      },
    },
    {
      projection_type: "core",
      abstraction: "l3_core",
      payload: {
        kind: "core",
        statement: "Canonical state outranks derived graph state.",
        applicability: ["Local governed memory runtime."],
        constraints: ["No graph-owned lifecycle authority."],
        confidence: 1,
        promotion_basis: ["Exact source lineage."],
      },
    },
  ] as const;
  const projections = definitions.map((definition, index) => {
    const identity = `graph_fixture_${definition.projection_type}`;
    const content = {
      storage: "inline",
      text: canonicalJson(definition.payload),
      media_type: "application/json",
    } as const;
    return ProjectionRevisionSchema.parse({
      schema_version: "1.0.0",
      projection_id: `projection_${identity}`,
      projection_revision_id: `projection_revision_${identity}_1`,
      revision: 1,
      projection_type: definition.projection_type,
      abstraction: definition.abstraction,
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      lifecycle: "active",
      authority: "derived",
      sensitivity:
        definition.projection_type === "relation"
          ? options.relationSensitivity ?? "personal"
          : "personal",
      validity: {
        valid_from: NOW,
        valid_to: null,
        recorded_at: NOW,
      },
      payload: definition.payload,
      content,
      content_hash: canonicalSha256(content),
      source_revisions: sources,
      evidence_ids: sources.flatMap((source) => source.evidence_ids),
      supersedes_projection_revision_id: null,
      transform: frontier.transform,
      frontier,
      created_at: new Date(
        Date.parse(NOW) + index,
      ).toISOString(),
      invalidated_at: null,
      invalidation_reason: null,
    });
  });
  await storage.applyProjectionBatch({
    principal_id: "user_local",
    scope: { kind: "workspace", id: "workspace_local" },
    idempotency_key: "graph-complete-projection-fixture-0001",
    expected_projection_epoch:
      health.projection_frontier.projection_epoch,
    frontier,
    projections,
    applied_at: "2026-07-29T05:00:00.000Z",
  });
  return { frontier, projections, sources };
}

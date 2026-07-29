import {
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  G4ACaseBodySchema,
  G4AOverlayManifestSchema,
  canonicalJson,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  GraphProcessHost,
  g4aQueryForCase,
  materializeG4AExpectedProfile,
  materializeG4ACaseSnapshot,
  outcomeFromGraphResult,
  queryGraphSnapshotReference,
  scoreG4AOutcome,
} from "../../packages/graph-projection/src/index.js";
import {
  installedGraphBackendIdentity,
} from "../helpers/graph-runtime-examples.js";

const roots: string[] = [];
const hosts: GraphProcessHost[] = [];
const ROOT = resolve("fixtures/g4a");

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "memo-graph-u7-replay-"),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

const nativeIt =
  process.platform === "darwin" && process.arch === "arm64"
    ? it
    : it.skip;

describe("G4A graph benchmark protocol", () => {
  it("materializes the complete declared Expected logical profile without content", async () => {
    const manifest = G4AOverlayManifestSchema.parse(
      JSON.parse(
        await readFile(resolve(ROOT, "manifest.json"), "utf8"),
      ),
    );
    const snapshots = materializeG4AExpectedProfile(
      manifest.expected_profile,
    );
    expect(snapshots).toHaveLength(100);
    expect(
      snapshots.reduce(
        (count, snapshot) =>
          count +
          snapshot.nodes.filter(
            (node) => node.projection_revision_id === null,
          ).length,
        0,
      ),
    ).toBe(manifest.expected_profile.active_l1_memories);
    expect(
      snapshots.reduce(
        (count, snapshot) =>
          count +
          snapshot.nodes.filter(
            (node) => node.projection_revision_id !== null,
          ).length,
        0,
      ),
    ).toBe(manifest.expected_profile.l2_l3_projections);
    expect(
      snapshots.reduce(
        (count, snapshot) => count + snapshot.edges.length,
        0,
      ),
    ).toBe(manifest.expected_profile.relations);
    expect(JSON.stringify(snapshots)).not.toContain("memory content");
  }, 30_000);

  nativeIt("runs graph-free B and LadybugDB C over identical frozen governed slices", async () => {
    const manifest = G4AOverlayManifestSchema.parse(
      JSON.parse(
        await readFile(resolve(ROOT, "manifest.json"), "utf8"),
      ),
    );
    const graph = await GraphProcessHost.open({
      dataRoot: await temporaryRoot(),
      expectedIdentity: await installedGraphBackendIdentity(),
      childEntry: new URL(
        "../../packages/graph-projection/dist/ladybug-process.js",
        import.meta.url,
      ),
      requestTimeoutMs: 250,
      writeTimeoutMs: 10_000,
    });
    hosts.push(graph);
    const scores = [];
    for (const descriptor of manifest.cases) {
      const body = G4ACaseBodySchema.parse(
        JSON.parse(
          await readFile(resolve(ROOT, descriptor.body_file), "utf8"),
        ),
      );
      expect(canonicalSha256(body)).toBe(descriptor.content_hash);
      const snapshot = materializeG4ACaseSnapshot(body);
      const query = g4aQueryForCase({ body, snapshot });
      await graph.replaceScope(snapshot);

      const reference = outcomeFromGraphResult({
        body,
        snapshot,
        result: queryGraphSnapshotReference({ snapshot, query }),
      });
      const native = outcomeFromGraphResult({
        body,
        snapshot,
        result: await graph.queryPaths(query),
      });
      expect(canonicalJson(native)).toBe(canonicalJson(reference));
      scores.push({
        case_id: body.case_id,
        partition: body.partition,
        score: scoreG4AOutcome(body.expected, native),
      });
    }

    expect(scores.filter((entry) => entry.score.passed)).toHaveLength(5);
    expect(
      scores.find(
        (entry) => entry.case_id ===
          "g4a_transfer_cycle_fanout_pressure",
      )?.score,
    ).toMatchObject({
      passed: false,
      completeness: true,
      abstention: false,
      reason_codes: false,
    });
    expect(
      new Set(
        scores
          .filter((entry) => entry.score.passed)
          .map((entry) => entry.partition),
      ),
    ).toEqual(new Set(["calibration", "holdout", "transfer"]));
  }, 30_000);
});

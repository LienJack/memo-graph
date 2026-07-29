import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  G4ACaseBodySchema,
  G4AOverlayManifestSchema,
  G4AProtocolIdentitySchema,
  GraphBackendIdentitySchema,
  assertG4APartitionAccess,
  buildGraphPathEvidence,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  acceptedG3RStructuralOutcome,
  assertComparableG4AIdentities,
  g4aQueryForCase,
  materializeG4ACaseSnapshot,
  outcomeFromGraphResult,
  queryGraphSnapshotReference,
  scoreG4AOutcome,
} from "../../packages/graph-projection/src/index.js";

const ROOT = resolve("fixtures/g4a");
const LOCK_HASH = `sha256:${"1".repeat(64)}`;
const NATIVE_HASH = `sha256:${"2".repeat(64)}`;
const CANDIDATE = "7b95743f7b95743f7b95743f7b95743f7b95743f";
const BASELINE = "6224f782c86712488d416d8101ef7c9fa477c0ae";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function loadedCases() {
  const manifest = G4AOverlayManifestSchema.parse(
    await readJson(resolve(ROOT, "manifest.json")),
  );
  return {
    manifest,
    cases: await Promise.all(
      manifest.cases.map(async (descriptor) => {
        const body = G4ACaseBodySchema.parse(
          await readJson(resolve(ROOT, descriptor.body_file)),
        );
        expect(canonicalSha256(body)).toBe(descriptor.content_hash);
        return body;
      }),
    ),
  };
}

describe("G4A structural replay", () => {
  it("keeps calibration tuning unable to read holdout or transfer bodies", () => {
    expect(() =>
      assertG4APartitionAccess("calibration_tuning", "calibration")
    ).not.toThrow();
    expect(() =>
      assertG4APartitionAccess("calibration_tuning", "holdout")
    ).toThrow();
    expect(() =>
      assertG4APartitionAccess("calibration_tuning", "transfer")
    ).toThrow();
  });

  it("materializes one content-free governed slice per frozen case", async () => {
    const { cases } = await loadedCases();
    for (const body of cases) {
      const snapshot = materializeG4ACaseSnapshot(body);
      expect(snapshot.principal_id).toBe(body.principal_id);
      expect(snapshot.scope).toEqual(body.scope);
      expect(
        snapshot.nodes.some((node) =>
          body.prohibited_revision_ids.includes(node.revision_id)
        ),
      ).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain(body.description);
      expect(
        new Set(snapshot.edges.map((edge) => edge.relation_revision_id)),
      ).toEqual(
        new Set(
          body.input_relation_revision_ids.filter((relationId) =>
            snapshot.edges.some(
              (edge) => edge.relation_revision_id === relationId,
            )
          ),
        ),
      );
    }
  });

  it("returns only terminal typed proof paths and deterministic shortest tie-breaks", async () => {
    const { cases } = await loadedCases();
    for (const family of [
      "typed_explanatory_path",
      "shortest_valid_proof",
    ] as const) {
      const body = cases.find((entry) => entry.family === family);
      if (body === undefined) {
        throw new Error(`missing G4A ${family} case`);
      }
      const snapshot = materializeG4ACaseSnapshot(body);
      const query = g4aQueryForCase({ body, snapshot });
      const result = queryGraphSnapshotReference({ snapshot, query });
      const actual = outcomeFromGraphResult({ body, snapshot, result });
      expect(scoreG4AOutcome(body.expected, actual)).toMatchObject({
        exact_revision_set: true,
        ordered_proof_paths: true,
        exact_evidence: true,
        completeness: true,
        abstention: true,
        passed: true,
      });
    }
  });

  it("does not count ordering, candidate count, or latency as structural gain", () => {
    const path = buildGraphPathEvidence({
      node_revision_ids: ["revision_a", "revision_b"],
      relation_revision_ids: ["relation_1"],
      relation_types: ["supports"],
      depth: 1,
    });
    const expected = {
      status: "complete",
      revision_ids: ["revision_a", "revision_b"],
      ordered_paths: [path],
      evidence_ids: ["evidence_1"],
      complete: true,
      abstain: false,
      reason_codes: [],
    } as const;
    expect(
      scoreG4AOutcome(expected, {
        ...expected,
        ordered_paths: [],
        revision_ids: [],
        evidence_ids: [],
        abstain: true,
      }).passed,
    ).toBe(false);
    expect(
      scoreG4AOutcome(expected, {
        ...expected,
        revision_ids: [...expected.revision_ids].reverse(),
      }).passed,
    ).toBe(true);
  });

  it("rejects baseline, candidate, lock, or common protocol drift", async () => {
    const { manifest, cases } = await loadedCases();
    const body = cases[0];
    if (body === undefined) {
      throw new Error("G4A identity fixture missing");
    }
    expect(manifest.baseline_commit).toBe(BASELINE);
    const snapshot = materializeG4ACaseSnapshot(body);
    const query = g4aQueryForCase({ body, snapshot });
    const common = {
      protocol_version: "1.0.0" as const,
      case_id: body.case_id,
      partition: body.partition,
      manifest_hash: canonicalSha256(manifest),
      case_hash: canonicalSha256(body),
      query_hash: canonicalSha256(query),
      policy_hash: canonicalSha256({
        query: body.query,
        exact_scope: body.scope,
      }),
      frontier_hash: canonicalSha256(snapshot.frontier),
      thresholds_hash: canonicalSha256(manifest.thresholds),
    };
    const identities = [
      G4AProtocolIdentitySchema.parse({
        ...common,
        arm: "accepted_g3r",
        candidate_commit: BASELINE,
        dependency_lock_hash: LOCK_HASH,
        native_binary_hash: null,
      }),
      G4AProtocolIdentitySchema.parse({
        ...common,
        arm: "m4a_graph_disabled_reference",
        candidate_commit: CANDIDATE,
        dependency_lock_hash: LOCK_HASH,
        native_binary_hash: null,
      }),
      G4AProtocolIdentitySchema.parse({
        ...common,
        arm: "m4a_graph_enabled",
        candidate_commit: CANDIDATE,
        dependency_lock_hash: LOCK_HASH,
        native_binary_hash: NATIVE_HASH,
      }),
    ] as const;
    expect(() => assertComparableG4AIdentities(identities)).not.toThrow();
    expect(() =>
      assertComparableG4AIdentities([
        identities[0],
        identities[1],
        G4AProtocolIdentitySchema.parse({
          ...identities[2],
          policy_hash: canonicalSha256("drift"),
        }),
      ])
    ).toThrow(/identity drift/u);
    expect(
      scoreG4AOutcome(
        body.expected,
        acceptedG3RStructuralOutcome(),
      ).passed,
    ).toBe(false);
    expect(
      GraphBackendIdentitySchema.safeParse({
        schema_version: "1.0.0",
        backend: "ladybugdb",
        package_name: "@ladybugdb/core",
        package_version: "0.18.3",
        storage_version: "42",
        platform: process.platform,
        architecture: process.arch,
        native_binary_hash: NATIVE_HASH,
        dependency_lock_hash: LOCK_HASH,
      }).success,
    ).toBe(true);
  });
});

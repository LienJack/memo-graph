import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  InMemoryVectorRuntimeFactory,
} from "../helpers/in-memory-vector-runtime.js";
import {
  G4B_MANIFEST_HASH,
  calibrateG4B,
  loadG4BManifest,
  materializeG4BExpectedProfile,
  runG4BReplay,
} from "../helpers/g4b-replay.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), `memo-graph-${prefix}-`),
  );
  roots.push(root);
  return root;
}

function lockHash(): string {
  return `sha256:${createHash("sha256")
    .update(execFileSync("git", ["show", "HEAD:pnpm-lock.yaml"]))
    .digest("hex")}`;
}

describe("frozen G4B four-arm semantic replay", () => {
  it("binds all nine immutable case hashes and rejects manifest drift", async () => {
    const manifest = await loadG4BManifest();
    expect(canonicalSha256(manifest)).toBe(G4B_MANIFEST_HASH);
    expect(
      Object.fromEntries(
        manifest.cases.map((entry) => [
          entry.case_id,
          canonicalSha256(entry),
        ]),
      ),
    ).toEqual({
      g4b_cal_exact_scope_isolation:
        "sha256:65d514b5e8a9667377e6e3f8d981880f48092eb5b968a5ebfd1dd9d2773430cd",
      g4b_cal_irrecoverable_forgetting:
        "sha256:f06276b0ff23579597e2aa3ffa351a86003104302a5f4fe04804175b81ad4a85",
      g4b_cal_learning_pause_zh_en:
        "sha256:482768a3e16479cfd3a15caba81093976dbefc523c0e793e8ab8e9d61aad3a2d",
      g4b_hold_correction_zh_en:
        "sha256:7544b6a4abd201acd9fcd46e73be7f7e0cef7a42154785effd688819c654db68",
      g4b_hold_projection_fallback:
        "sha256:425e64acb2baf06ecf3a378a0a5f0c0d76937ec6d35bf32b8cac63f84f45e40c",
      g4b_hold_revoked_similarity_trap:
        "sha256:af449c1ad208688f801231a2499ea05b85aeeb2bae21612461b951042aad96df",
      g4b_transfer_context_pollution:
        "sha256:9e3f5ab2a8b8325678f6d7479af8697bb174fbd15608d4c21bd304a97d9101dd",
      g4b_transfer_offline_operation:
        "sha256:89bdc01c1963e9de689627dfffeb9ab19c2f37fac33dd59c61cc473b6210e6ec",
      g4b_transfer_temporal_abstention:
        "sha256:e58a21290ca7342066ace49d0c7e89e044ce5ea1af714d8b30e088a0e39ed6b3",
    });
  });

  it("seals calibration before evaluator access and never exposes evaluation payloads to tuning", async () => {
    const { manifest, gate, receipt, tuner_payload: tunerPayload } =
      await calibrateG4B();
    expect(tunerPayload.cases).toHaveLength(3);
    expect(
      new Set(tunerPayload.cases.map((entry) => entry.partition)),
    ).toEqual(new Set(["calibration"]));
    const rendered = canonicalJson(tunerPayload);
    for (const entry of manifest.cases.filter(
      (candidate) => candidate.partition !== "calibration",
    )) {
      expect(rendered).not.toContain(entry.case_id);
      expect(rendered).not.toContain(entry.query);
    }
    expect(() => gate.calibrationPayload()).toThrow(
      "already sealed",
    );
    expect(() =>
      gate.evaluationCases({
        ...receipt,
        configuration: {
          ...receipt.configuration,
          vector_top_k: 4 as never,
        },
      }),
    ).toThrow("sealed calibration");
    expect(gate.evaluationCases(receipt)).toHaveLength(9);
  });

  it("runs identical canonical inputs across four arms and both budgets deterministically", async () => {
    const { receipt } = await calibrateG4B();
    const implementationCommit = execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const run = async (prefix: string) =>
      runG4BReplay({
        data_root: await temporaryRoot(prefix),
        model_root: "/g4b/in-memory-model",
        implementation_commit: implementationCommit,
        dependency_lock_hash: lockHash(),
        receipt,
        recorded_at: "2026-07-29T08:00:00.000Z",
        runtime_factory: () => {
          const runtime = new InMemoryVectorRuntimeFactory();
          return {
            projection: runtime.runtimeFactory(),
            query: runtime.queryRuntimeFactory(),
          };
        },
      });
    const first = await run("g4b-replay-first");
    const second = await run("g4b-replay-second");

    expect(first.cases).toHaveLength(9);
    expect(
      first.cases.every((entry) => entry.budgets.length === 2),
    ).toBe(true);
    for (const entry of first.cases) {
      for (const budget of entry.budgets) {
        const identities = Object.values(
          budget.observations,
        ).map((observation) =>
          canonicalJson(observation.common_identity)
        );
        expect(new Set(identities).size).toBe(1);
        for (const score of Object.values(budget.scores)) {
          expect(score.prohibited_revision_ids).toEqual([]);
        }
      }
    }
    expect(first.summary.critical_regressions).toEqual([]);
    expect(first.summary.positive_cases_solved).toBe(6);
    expect(first.summary.strict_case_gains).toBeGreaterThanOrEqual(4);
    expect(first.threshold_results.context_pollution).toBe(false);
    expect(first.utility_gate).toBe(false);
    expect(first.logical_results_hash).toBe(
      second.logical_results_hash,
    );
  }, 30_000);

  it("materializes the M0 expected profile deterministically without changing its declared totals", async () => {
    const manifest = await loadG4BManifest();
    const first = materializeG4BExpectedProfile(
      manifest.expected_profile,
    );
    const second = materializeG4BExpectedProfile(
      manifest.expected_profile,
    );
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.scope_count).toBe(100);
    expect(
      first.scopes.reduce(
        (sum, entry) => sum + entry.evidence_events,
        0,
      ),
    ).toBe(250_000);
    expect(
      first.scopes.reduce(
        (sum, entry) => sum + entry.active_l1_memories,
        0,
      ),
    ).toBe(25_000);
    expect(
      first.scopes.reduce(
        (sum, entry) => sum + entry.l2_l3_projections,
        0,
      ),
    ).toBe(6_000);
    expect(
      first.scopes.reduce(
        (sum, entry) => sum + entry.relations,
        0,
      ),
    ).toBe(50_000);
  });
});

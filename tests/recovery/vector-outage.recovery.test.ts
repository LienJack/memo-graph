import { performance } from "node:perf_hooks";
import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  VectorRuntimeError,
} from "../../packages/vector-retrieval/src/index.js";
import type {
  VectorFailureCategory,
} from "../../packages/contracts/src/index.js";

import {
  openGovernedVectorHarness,
} from "../helpers/governed-vector-harness.js";
import { VECTOR_SCOPE } from "../helpers/vector-examples.js";

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
    join(
      await realpath(tmpdir()),
      `memo-graph-vector-outage-${prefix}-`,
    ),
  );
  roots.push(root);
  return root;
}

function percentile(
  values: number[],
  percentileValue: number,
): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.ceil(ordered.length * percentileValue) - 1,
  );
  return ordered[index] ?? 0;
}

describe("semantic vector outage recovery", () => {
  for (const category of [
    "MODEL_MISSING",
    "DEPENDENCY_UNAVAILABLE",
    "INDEX_MISSING",
    "INDEX_LOCKED",
    "INDEX_CORRUPT",
    "REBUILDING",
    "PROCESS_TIMEOUT",
    "PROCESS_EXIT",
  ] satisfies VectorFailureCategory[]) {
    it(`${category} preserves exact vector-free fallback and enters cooldown`, async () => {
      let opens = 0;
      const harness = await openGovernedVectorHarness({
        dataRoot: await temporaryRoot(category.toLowerCase()),
        queryFactory: () => ({
          open: async () => {
            opens += 1;
            throw new VectorRuntimeError(category, {
              retryable: true,
            });
          },
        }),
      });
      try {
        const durations: number[] = [];
        const baselineDurations: number[] = [];
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const baselineStartedAt = performance.now();
          const baseline = await harness.recall(["recent_l1"]);
          baselineDurations.push(
            performance.now() - baselineStartedAt,
          );
          const startedAt = performance.now();
          const result = await harness.recall([
            "recent_l1",
            "semantic_vector",
          ]);
          durations.push(performance.now() - startedAt);
          expect(result.status).toBe("DEGRADED");
          expect(result.candidates).toEqual(baseline.candidates);
          expect(
            result.telemetry.find(
              (item) => item.lane === "semantic_vector",
            ),
          ).toMatchObject({
            status: "degraded",
            reason_codes: [`VECTOR_${category}`],
          });
        }

        expect(opens).toBe(1);
        const baselineP95 = percentile(baselineDurations, 0.95);
        const fallbackP95 = percentile(durations, 0.95);
        expect(fallbackP95).toBeLessThanOrEqual(
          Math.max(100, baselineP95 + 60),
        );
        await expect(harness.storage.health()).resolves.toMatchObject({
          schema_version: "0019",
          journal_mode: "wal",
          foreign_keys: true,
        });
      } finally {
        await harness.storage.close();
      }
    });
  }

  it("marks a restored vector generation degraded until one clean rebuild publishes", async () => {
    const harness = await openGovernedVectorHarness({
      dataRoot: await temporaryRoot("restore"),
    });
    try {
      await harness.storage.markVectorRestoreDegraded({
        restored_at: "2026-07-29T06:35:00.000Z",
      });
      const degraded = await harness.recall();
      expect(degraded.status).toBe("DEGRADED");
      expect(degraded.candidates).toEqual([]);
      expect(
        degraded.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        status: "degraded",
        reason_codes: ["VECTOR_SCOPE_PENDING"],
      });

      const recovered = await harness.projector.drain({
        worker_id: "vector_restore_recovery",
        claimed_at: "2026-07-29T06:35:01.000Z",
        lease_expires_at: "2026-07-29T06:36:00.000Z",
        completed_at: "2026-07-29T06:35:05.000Z",
        retry_at: "2026-07-29T06:36:05.000Z",
      });
      expect(recovered).toMatchObject({
        claimed: 1,
        published: 1,
        stale: 0,
        failed: 0,
      });
      await expect(
        harness.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        }),
      ).resolves.toMatchObject({
        state: "published",
        failure_category: null,
      });
      expect((await harness.recall()).status).toBe("OK");
    } finally {
      await harness.storage.close();
    }
  });
});

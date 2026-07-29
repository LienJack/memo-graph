import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildVectorScopeSnapshot,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  VectorProcessHost,
} from "../../packages/vector-retrieval/src/index.js";
import {
  G4B_VECTOR_EPOCH,
  evaluateG4BResourceMetrics,
  loadG4BManifest,
  materializeG4BExpectedProfile,
  percentile,
} from "../helpers/g4b-replay.js";

const roots: string[] = [];
const MODEL_ROOT = process.env.MEMO_GRAPH_G4B_MODEL_ROOT;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "memo-graph-g4b-benchmark-"),
  );
  roots.push(root);
  return root;
}

describe("G4B resource gate", () => {
  it("requires the complete frozen sample count and physical expected-profile measurements", async () => {
    const manifest = await loadG4BManifest();
    const result = evaluateG4BResourceMetrics({
      thresholds: manifest.thresholds,
      samples: {
        warmups: manifest.thresholds.warmup_samples - 1,
        measured: manifest.thresholds.measured_samples,
      },
      outcomes: {
        direct_complete: manifest.thresholds.measured_samples,
        governed_complete: manifest.thresholds.measured_samples,
        context_ok: manifest.thresholds.measured_samples,
        fallback_typed_degraded:
          manifest.thresholds.measured_samples,
      },
      latency_ms: {
        governed_recall_p50: 1,
        governed_recall_p95: 1,
        governed_recall_p99: 1,
        context_compile_p50: 1,
        context_compile_p95: 1,
        context_compile_p99: 1,
        fallback_p95: 1,
        cold_ready: 1,
        scope_rebuild: 1,
        full_rebuild: null,
        epoch_migration: null,
      },
      expected_profile: {
        logical_materialized: true,
        native_physical_materialized: false,
        full_rebuild_measured: false,
        epoch_migration_measured: false,
      },
    });
    expect(result).toMatchObject({
      warmups: false,
      measured_samples: true,
      expected_logical_profile: true,
      expected_native_profile: false,
      expected_full_rebuild: false,
      expected_epoch_migration: false,
    });
  });

  it("keeps the logical M0 population deterministic and exactly distributed", async () => {
    const manifest = await loadG4BManifest();
    const profile = materializeG4BExpectedProfile(
      manifest.expected_profile,
    );
    expect(profile.scope_count).toBe(100);
    expect(profile.scopes).toHaveLength(100);
    expect(
      profile.scopes.reduce(
        (sum, entry) => sum + entry.active_l1_memories,
        0,
      ),
    ).toBe(25_000);
    expect(profile.logical_digest).toBe(
      materializeG4BExpectedProfile(
        manifest.expected_profile,
      ).logical_digest,
    );
  });

  it.runIf(MODEL_ROOT !== undefined)(
    "measures 20 warmups and 100 real warm-child queries against the pinned offline candidate",
    async () => {
      const manifest = await loadG4BManifest();
      const root = await temporaryRoot();
      const principalId = "g4b_benchmark_principal";
      const scope = {
        kind: "workspace" as const,
        id: "g4b_benchmark_scope",
      };
      const host = await VectorProcessHost.open({
        dataRoot: root,
        modelRoot: MODEL_ROOT ?? "",
        principalId,
        scope,
        expectedEpoch: G4B_VECTOR_EPOCH,
        childEntry: new URL(
          "../../packages/vector-retrieval/dist/vector-process.js",
          import.meta.url,
        ),
        startupTimeoutMs: 30_000,
        requestTimeoutMs: 75,
        writeTimeoutMs: 30_000,
      });
      try {
        const [vector] = await host.embedPassages([
          "SQLite authority and governed semantic recall",
        ]);
        if (vector === undefined) {
          throw new Error("G4B benchmark embedding is missing");
        }
        const snapshot = buildVectorScopeSnapshot({
          schema_version: "1.0.0",
          principal_id: principalId,
          scope,
          embedding_epoch_id: G4B_VECTOR_EPOCH.epoch_id,
          generation_id: "g4b_benchmark_generation",
          frontier: {
            ledger_epoch: 1,
            tombstone_epoch: 0,
            source_frontier_hash: canonicalSha256({
              corpus: "g4b benchmark",
            }),
            next_validity_transition_at: null,
          },
          records: [
            {
              schema_version: "1.0.0",
              revision_id: "g4b_benchmark_revision",
              source_content_hash: canonicalSha256({
                content: "SQLite authority",
              }),
              vector,
            },
          ],
        });
        await host.replaceScope(snapshot);
        const query = (sampleId: string) =>
          host.query({
            schema_version: "1.0.0",
            request_id: `g4b_benchmark_${sampleId}`,
            principal_id: principalId,
            scope,
            query: "governed authoritative memory",
            embedding_epoch_id: G4B_VECTOR_EPOCH.epoch_id,
            generation_id: snapshot.generation_id,
            source_frontier_hash:
              snapshot.frontier.source_frontier_hash,
            top_k: 1,
            parent_deadline_ms: 75,
            max_response_bytes: 65_536,
          });
        for (
          let index = 0;
          index < manifest.thresholds.warmup_samples;
          index += 1
        ) {
          expect(
            (await query(`warmup_${index}`)).complete,
          ).toBe(true);
        }
        const samples: number[] = [];
        for (
          let index = 0;
          index < manifest.thresholds.measured_samples;
          index += 1
        ) {
          const started = performance.now();
          const result = await query(`measured_${index}`);
          samples.push(performance.now() - started);
          expect(result.complete).toBe(true);
        }
        expect(samples).toHaveLength(100);
        expect(percentile(samples, 0.5)).toBeLessThanOrEqual(
          manifest.thresholds.governed_recall_p50_ms,
        );
        expect(percentile(samples, 0.95)).toBeLessThanOrEqual(
          manifest.thresholds.governed_recall_p95_ms,
        );
      } finally {
        await host.close();
      }
    },
    120_000,
  );
});

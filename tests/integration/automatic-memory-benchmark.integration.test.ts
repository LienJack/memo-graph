import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { inlineEpisode } from "../helpers/storage-examples.js";
import { percentile95 } from "../helpers/automatic-memory-replay.js";

const cleanup: string[] = [];
const NOW = "2026-08-03T08:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `memo-auto-${prefix}-`)));
  cleanup.push(root);
  return root;
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("automatic memory local hot path", () => {
  it("keeps canonical capture p95 within 100 ms without provider work", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("capture-benchmark"),
      automaticMemoryPrincipalId: "user_local",
    });
    try {
      const projectRoot = temporaryRoot("capture-project");
      const project = await storage.registerAutomaticMemoryProject({
        principal_id: "user_local",
        cwd: projectRoot,
        registered_at: NOW,
      });
      for (let index = 0; index < 24; index += 1) {
        await storage.commitEpisode(inlineEpisode({
          episodeId: `episode_capture_benchmark_${index}`,
          evidenceId: `evidence_capture_benchmark_${index}`,
          idempotencyKey: `commit:capture:benchmark:${index}`,
          principalId: "user_local",
          scopeId: project.scope.id,
          text: `Capture benchmark turn ${index}`,
        }));
      }

      const durations: number[] = [];
      for (let index = 0; index < 24; index += 1) {
        const started = performance.now();
        await storage.captureAutomaticMemoryEvent({
          schema_version: "1.0.0",
          idempotency_key: `automatic-capture-benchmark-${index}`,
          principal_id: "user_local",
          project_id: project.project_id,
          evidence_id: `evidence_capture_benchmark_${index}`,
          source: "direct",
          captured_at: NOW,
          stabilization_delay_ms: 1_000,
          event: {
            schema_version: "1.0.0",
            event_kind: "user_prompt_submit",
            event_id: `event:capture-benchmark-${index}`,
            session_id: "session_capture_benchmark",
            turn_id: `turn_capture_benchmark_${index}`,
            cwd: projectRoot,
            occurred_at: NOW,
            model: "fake-model",
            generation: 1,
            prompt: `Capture benchmark turn ${index}`,
          },
        });
        durations.push(performance.now() - started);
      }
      expect(percentile95(durations)).toBeLessThanOrEqual(100);
      await expect(storage.automaticMemoryStatus()).resolves.toMatchObject({
        events: 24,
        turns: 24,
        provider_attempts: 0,
      });
    } finally {
      await storage.close();
    }
  });
});

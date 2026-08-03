import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
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

async function seedClaimableTurn(storage: SqliteStorageClient, cwd: string) {
  const project = await storage.registerAutomaticMemoryProject({
    principal_id: "user_local",
    cwd,
    registered_at: "2026-08-03T09:00:00.000Z",
  });
  for (const side of ["user", "assistant"] as const) {
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: `episode_recovery_${side}`,
        evidenceId: `evidence_recovery_${side}`,
        idempotencyKey: `commit:automatic:recovery:${side}`,
        principalId: "user_local",
        scopeId: project.scope.id,
        text: side === "user" ? "Prefer concise answers." : "Understood.",
      }),
    );
  }
  await storage.captureAutomaticMemoryEvent({
    schema_version: "1.0.0",
    idempotency_key: "automatic-recovery-user-0001",
    principal_id: "user_local",
    project_id: project.project_id,
    evidence_id: "evidence_recovery_user",
    source: "direct",
    captured_at: "2026-08-03T09:00:00.000Z",
    stabilization_delay_ms: 0,
    event: {
      schema_version: "1.0.0",
      event_kind: "user_prompt_submit",
      event_id: "event-recovery-user-001",
      session_id: "thr_recovery_001",
      turn_id: "turn-recovery-001",
      cwd,
      occurred_at: "2026-08-03T09:00:00.000Z",
      model: "gpt-5",
      generation: 1,
      prompt: "Prefer concise answers.",
    },
  });
  await storage.captureAutomaticMemoryEvent({
    schema_version: "1.0.0",
    idempotency_key: "automatic-recovery-stop-0001",
    principal_id: "user_local",
    project_id: project.project_id,
    evidence_id: "evidence_recovery_assistant",
    source: "direct",
    captured_at: "2026-08-03T09:00:01.000Z",
    stabilization_delay_ms: 0,
    event: {
      schema_version: "1.0.0",
      event_kind: "assistant_stop",
      event_id: "event-recovery-stop-001",
      session_id: "thr_recovery_001",
      turn_id: "turn-recovery-001",
      cwd,
      occurred_at: "2026-08-03T09:00:01.000Z",
      model: "gpt-5",
      generation: 1,
      stop_hook_active: false,
      last_assistant_message: "Understood.",
    },
  });
}

describe("automatic memory inbox recovery", () => {
  it("reclaims an expired formation lease without duplicating the turn", async () => {
    const dataRoot = temporaryRoot("automatic-lease-recovery");
    const projectRoot = temporaryRoot("automatic-lease-project");
    let storage = await SqliteStorageClient.open({
      dataRoot,
      automaticMemoryPrincipalId: "user_local",
    });
    await seedClaimableTurn(storage, projectRoot);

    const first = await storage.claimAutomaticMemoryFormationJobs({
      worker_id: "formation-worker-before-crash",
      claimed_at: "2026-08-03T09:00:02.000Z",
      lease_expires_at: "2026-08-03T09:01:02.000Z",
      limit: 1,
    });
    expect(first.jobs[0]?.attempts).toBe(1);
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      automaticMemoryPrincipalId: "user_local",
    });
    expect(
      await storage.claimAutomaticMemoryFormationJobs({
        worker_id: "formation-worker-too-early",
        claimed_at: "2026-08-03T09:00:30.000Z",
        lease_expires_at: "2026-08-03T09:01:30.000Z",
        limit: 1,
      }),
    ).toMatchObject({ jobs: [] });

    const reclaimed = await storage.claimAutomaticMemoryFormationJobs({
      worker_id: "formation-worker-after-restart",
      claimed_at: "2026-08-03T09:01:03.000Z",
      lease_expires_at: "2026-08-03T09:02:03.000Z",
      limit: 1,
    });
    expect(reclaimed.jobs).toHaveLength(1);
    expect(reclaimed.jobs[0]?.attempts).toBe(2);

    const failed = await storage.failAutomaticMemoryFormationJob({
      job_id: reclaimed.jobs[0]?.job_id as string,
      generation: 1,
      worker_id: "formation-worker-after-restart",
      failed_at: "2026-08-03T09:01:04.000Z",
      next_available_at: "2026-08-03T09:02:04.000Z",
      error_code: "provider_unavailable",
      max_attempts: 2,
    });
    expect(failed.state).toBe("quarantined");
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      automaticMemoryPrincipalId: "user_local",
    });
    expect(await storage.automaticMemoryStatus()).toMatchObject({
      events: 2,
      turns: 1,
      jobs_quarantined: 1,
    });
    expect(
      await storage.claimAutomaticMemoryFormationJobs({
        worker_id: "formation-worker-terminal",
        claimed_at: "2026-08-03T10:00:00.000Z",
        lease_expires_at: "2026-08-03T10:01:00.000Z",
        limit: 1,
      }),
    ).toMatchObject({ jobs: [] });
    await storage.close();
  });
});

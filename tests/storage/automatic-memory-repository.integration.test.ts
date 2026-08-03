import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  RecordAutomaticMemoryFormationAuditCommandSchema,
  SqliteStorageClient,
  resolveAutomaticMemoryProjectIdentity,
} from "@memo-graph/storage-sqlite";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const NOW = "2026-08-03T08:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("automatic memory durable inbox", () => {
  it("shares project identity across symlinks and Git worktrees but isolates clones", () => {
    const fixtureRoot = temporaryRoot("project-identity");
    const repository = join(fixtureRoot, "repository");
    const worktree = join(fixtureRoot, "worktree");
    const clone = join(fixtureRoot, "clone");
    const symlink = join(fixtureRoot, "repository-link");

    execFileSync("git", ["init", repository]);
    git(repository, "config", "user.email", "memory@example.test");
    git(repository, "config", "user.name", "Memory Test");
    writeFileSync(join(repository, "README.md"), "fixture\n", "utf8");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "fixture");
    git(repository, "worktree", "add", worktree, "-b", "fixture-worktree");
    execFileSync("git", ["clone", repository, clone]);
    symlinkSync(repository, symlink);

    const mainIdentity = resolveAutomaticMemoryProjectIdentity(repository);
    const linkedIdentity = resolveAutomaticMemoryProjectIdentity(symlink);
    const worktreeIdentity = resolveAutomaticMemoryProjectIdentity(worktree);
    const cloneIdentity = resolveAutomaticMemoryProjectIdentity(clone);

    expect(linkedIdentity).toEqual(mainIdentity);
    expect(worktreeIdentity).toEqual(mainIdentity);
    expect(cloneIdentity.identity_hash).not.toBe(mainIdentity.identity_hash);
    expect(cloneIdentity.scope.id).not.toBe(mainIdentity.scope.id);
  });

  it("stores paired turn metadata once and creates one claimable job", async () => {
    const dataRoot = temporaryRoot("automatic-inbox");
    const projectRoot = temporaryRoot("automatic-project");
    const storage = await SqliteStorageClient.open({
      dataRoot,
      automaticMemoryPrincipalId: "user_local",
    });
    const project = await storage.registerAutomaticMemoryProject({
      principal_id: "user_local",
      cwd: projectRoot,
      registered_at: NOW,
    });
    const recallUse = {
      project_id: project.project_id,
      session_id: "thr_recall_audit",
      turn_id: "turn_recall_audit",
      request_hash: `sha256:${"c".repeat(64)}`,
      retrieval_receipt_id: "automatic_recall:audit",
      context_slice_id: "automatic_slice:audit",
      memory_count: 0,
      token_count: 0,
      used_at: NOW,
    } as const;
    await expect(storage.recordAutomaticMemoryRecallUse(recallUse)).resolves
      .toMatchObject({ replayed: false });
    await expect(storage.recordAutomaticMemoryRecallUse(recallUse)).resolves
      .toMatchObject({ replayed: true });
    await expect(storage.listWorkbenchMemories({
      principal_id: "user_local",
      allowed_scopes: [project.scope, { kind: "user", id: "user_local" }],
      as_of: NOW,
      include_sensitive: false,
      context_scope: project.scope,
      max_snapshot_members: 200,
      request: {
        query: null,
        scope: null,
        kinds: [],
        lifecycles: ["active"],
        authorities: [],
        sources: [],
        recorded_after: null,
        recorded_before: null,
        include_non_current: true,
        limit: 100,
        cursor: null,
      },
    })).resolves.toMatchObject({ items: [] });

    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_auto_user",
        evidenceId: "evidence_auto_user",
        idempotencyKey: "commit:auto:user:0001",
        principalId: "user_local",
        scopeId: project.scope.id,
        text: "Use contract-first changes in this repository.",
      }),
    );
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_auto_assistant",
        evidenceId: "evidence_auto_assistant",
        idempotencyKey: "commit:auto:assistant:0001",
        principalId: "user_local",
        scopeId: project.scope.id,
        text: "I will preserve that repository convention.",
      }),
    );

    const promptCommand = {
      schema_version: "1.0.0",
      idempotency_key: "automatic-capture-user-0001",
      principal_id: "user_local",
      project_id: project.project_id,
      evidence_id: "evidence_auto_user",
      source: "direct",
      captured_at: NOW,
      stabilization_delay_ms: 0,
      event: {
        schema_version: "1.0.0",
        event_kind: "user_prompt_submit",
        event_id: "event-auto-user-001",
        session_id: "thr_auto_001",
        turn_id: "turn-auto-001",
        cwd: projectRoot,
        occurred_at: NOW,
        model: "gpt-5",
        generation: 1,
        prompt: "Use contract-first changes in this repository.",
      },
    } as const;
    const promptReceipt = await storage.captureAutomaticMemoryEvent(
      promptCommand,
    );
    const replayReceipt = await storage.captureAutomaticMemoryEvent({
      ...promptCommand,
      source: "spool",
    });
    expect(replayReceipt).toEqual(promptReceipt);

    const stopReceipt = await storage.captureAutomaticMemoryEvent({
      schema_version: "1.0.0",
      idempotency_key: "automatic-capture-stop-0001",
      principal_id: "user_local",
      project_id: project.project_id,
      evidence_id: "evidence_auto_assistant",
      source: "direct",
      captured_at: "2026-08-03T08:00:01.000Z",
      stabilization_delay_ms: 0,
      event: {
        schema_version: "1.0.0",
        event_kind: "assistant_stop",
        event_id: "event-auto-stop-001",
        session_id: "thr_auto_001",
        turn_id: "turn-auto-001",
        cwd: projectRoot,
        occurred_at: "2026-08-03T08:00:01.000Z",
        model: "gpt-5",
        generation: 1,
        stop_hook_active: false,
        last_assistant_message:
          "I will preserve that repository convention.",
      },
    });
    expect(stopReceipt.formation_job_id).not.toBeNull();

    const claimed = await storage.claimAutomaticMemoryFormationJobs({
      worker_id: "formation-worker-001",
      claimed_at: "2026-08-03T08:00:02.000Z",
      lease_expires_at: "2026-08-03T08:01:02.000Z",
      limit: 5,
    });
    expect(claimed.jobs).toHaveLength(1);
    expect(claimed.jobs[0]).toMatchObject({
      generation: 1,
      user_evidence_id: "evidence_auto_user",
      assistant_evidence_id: "evidence_auto_assistant",
      status: "processing",
    });

    const claimedJob = claimed.jobs[0];
    if (claimedJob === undefined) throw new Error("expected claimed job");
    const audit = RecordAutomaticMemoryFormationAuditCommandSchema.parse({
      job_id: claimedJob.job_id,
      generation: 1,
      attempt: 1,
      provider_id: "fake_provider",
      model: "fake-model",
      prompt_version: "1.0.0",
      policy_version: "1.0.0",
      schema_revision: "1.0.0",
      request_hash: `sha256:${"a".repeat(64)}`,
      result_hash: `sha256:${"b".repeat(64)}`,
      redaction: {
        schema_version: "1.0.0",
        policy_version: "1.0.0",
        original_hash: `sha256:${"d".repeat(64)}`,
        redacted_hash: `sha256:${"e".repeat(64)}`,
        action: "accepted",
        finding_categories: [],
        egress_safe: true,
      },
      input_tokens: 24,
      output_tokens: 12,
      latency_ms: 1_000,
      cost_microusd: null,
      started_at: "2026-08-03T08:00:02.000Z",
      completed_at: "2026-08-03T08:00:03.000Z",
      decisions: [{
        decision: {
          schema_version: "1.0.0",
          decision_id: "automatic_decision:repository-convention",
          proposal_id: "proposal:repository-convention",
          mode: "balanced",
          disposition: "activate",
          memory_kind: "procedural",
          reason_codes: ["eligible_for_activation"],
          requires_user_confirmation: false,
          decided_at: "2026-08-03T08:00:03.000Z",
          policy_version: "1.0.0",
        },
        admission: {
          candidate_id: "automatic_candidate:repository-convention",
          memory_id: "memory:repository-convention",
          revision_id: "revision:repository-convention",
          receipt_id: "receipt:repository-convention",
        },
      }],
    });
    await expect(storage.recordAutomaticMemoryFormationAudit(audit)).resolves
      .toMatchObject({
        policy_decisions: 1,
        admission_links: 1,
        replayed: false,
      });
    await expect(storage.recordAutomaticMemoryFormationAudit(audit)).resolves
      .toMatchObject({ replayed: true });

    const status = await storage.automaticMemoryStatus();
    expect(status).toMatchObject({
      projects: 1,
      events: 2,
      turns: 1,
      jobs_pending: 0,
      jobs_processing: 1,
      provider_attempts: 1,
      policy_decisions: 1,
      admission_links: 1,
    });
    await storage.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    const orchestrationRows = database
      .prepare("SELECT * FROM automatic_memory_events ORDER BY event_id")
      .all();
    expect(JSON.stringify(orchestrationRows)).not.toContain(
      "Use contract-first changes in this repository.",
    );
    expect(
      database
        .prepare("PRAGMA table_info(automatic_memory_events)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).not.toContain("payload_text");
    database.close();
  });

  it("adds empty orchestration tables without backfilling historical evidence", async () => {
    const dataRoot = temporaryRoot("automatic-migration");
    const migrationsRoot = temporaryRoot("automatic-migrations");
    const { cpSync, readdirSync } = await import("node:fs");
    for (const name of readdirSync(join(process.cwd(), "migrations"))) {
      if (/^00(0[1-9]|1[0-9])-.+\.sql$/u.test(name)) {
        cpSync(join(process.cwd(), "migrations", name), join(migrationsRoot, name));
      }
    }
    let storage = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationsRoot,
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_before_automatic_memory",
        evidenceId: "evidence_before_automatic_memory",
        idempotencyKey: "commit:before:automatic:0001",
      }),
    );
    await storage.close();

    cpSync(
      join(process.cwd(), "migrations", "0020-automatic-memory.sql"),
      join(migrationsRoot, "0020-automatic-memory.sql"),
    );
    storage = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationsRoot,
      automaticMemoryPrincipalId: "user_local",
    });
    expect((await storage.health()).schema_version).toBe("0020");
    expect(await storage.automaticMemoryStatus()).toMatchObject({
      projects: 0,
      events: 0,
      turns: 0,
      jobs_pending: 0,
    });
    await storage.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    expect(
      database.prepare("SELECT count(*) AS count FROM evidence_events").get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("rejects secret-bearing capture before any orchestration bytes are stored", async () => {
    const dataRoot = temporaryRoot("automatic-secret-screen");
    const projectRoot = temporaryRoot("automatic-secret-project");
    const storage = await SqliteStorageClient.open({
      dataRoot,
      automaticMemoryPrincipalId: "user_local",
    });
    const project = await storage.registerAutomaticMemoryProject({
      principal_id: "user_local",
      cwd: projectRoot,
      registered_at: NOW,
    });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";

    await expect(
      storage.captureAutomaticMemoryEvent({
        schema_version: "1.0.0",
        idempotency_key: "automatic-secret-capture-0001",
        principal_id: "user_local",
        project_id: project.project_id,
        evidence_id: "evidence_secret_must_not_exist",
        source: "spool",
        captured_at: NOW,
        stabilization_delay_ms: 0,
        event: {
          schema_version: "1.0.0",
          event_kind: "user_prompt_submit",
          event_id: "event-secret-rejected-001",
          session_id: "thr_secret_001",
          turn_id: "turn-secret-001",
          cwd: projectRoot,
          occurred_at: NOW,
          model: "gpt-5",
          generation: 1,
          prompt: `Do not retain ${secret}`,
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await storage.automaticMemoryStatus()).events).toBe(0);
    await storage.close();

    expect(
      new TextDecoder().decode(
        readFileSync(join(dataRoot, "ledger", "memory.db")),
      ),
    ).not.toContain(secret);
  });

  it("supersedes an in-flight Stop generation and rejects the stale result", async () => {
    const dataRoot = temporaryRoot("automatic-generation");
    const projectRoot = temporaryRoot("automatic-generation-project");
    const storage = await SqliteStorageClient.open({
      dataRoot,
      automaticMemoryPrincipalId: "user_local",
    });
    const project = await storage.registerAutomaticMemoryProject({
      principal_id: "user_local",
      cwd: projectRoot,
      registered_at: NOW,
    });
    for (const [suffix, text] of [
      ["user", "Prefer concise answers."],
      ["assistant_1", "First interim answer."],
      ["assistant_2", "Final stabilized answer."],
    ] as const) {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: `episode_generation_${suffix}`,
          evidenceId: `evidence_generation_${suffix}`,
          idempotencyKey: `commit:automatic:generation:${suffix}`,
          principalId: "user_local",
          scopeId: project.scope.id,
          text,
        }),
      );
    }
    await storage.captureAutomaticMemoryEvent({
      schema_version: "1.0.0",
      idempotency_key: "automatic-generation-user-0001",
      principal_id: "user_local",
      project_id: project.project_id,
      evidence_id: "evidence_generation_user",
      source: "direct",
      captured_at: NOW,
      stabilization_delay_ms: 0,
      event: {
        schema_version: "1.0.0",
        event_kind: "user_prompt_submit",
        event_id: "event-generation-user-001",
        session_id: "thr_generation_001",
        turn_id: "turn-generation-001",
        cwd: projectRoot,
        occurred_at: NOW,
        model: "gpt-5",
        generation: 1,
        prompt: "Prefer concise answers.",
      },
    });
    await storage.captureAutomaticMemoryEvent({
      schema_version: "1.0.0",
      idempotency_key: "automatic-generation-stop-0001",
      principal_id: "user_local",
      project_id: project.project_id,
      evidence_id: "evidence_generation_assistant_1",
      source: "direct",
      captured_at: "2026-08-03T08:00:01.000Z",
      stabilization_delay_ms: 0,
      event: {
        schema_version: "1.0.0",
        event_kind: "assistant_stop",
        event_id: "event-generation-stop-001",
        session_id: "thr_generation_001",
        turn_id: "turn-generation-001",
        cwd: projectRoot,
        occurred_at: "2026-08-03T08:00:01.000Z",
        model: "gpt-5",
        generation: 1,
        stop_hook_active: false,
        last_assistant_message: "First interim answer.",
      },
    });
    const oldClaim = await storage.claimAutomaticMemoryFormationJobs({
      worker_id: "generation-worker-old",
      claimed_at: "2026-08-03T08:00:02.000Z",
      lease_expires_at: "2026-08-03T08:01:02.000Z",
      limit: 1,
    });

    await storage.captureAutomaticMemoryEvent({
      schema_version: "1.0.0",
      idempotency_key: "automatic-generation-stop-0002",
      principal_id: "user_local",
      project_id: project.project_id,
      evidence_id: "evidence_generation_assistant_2",
      source: "direct",
      captured_at: "2026-08-03T08:00:03.000Z",
      stabilization_delay_ms: 0,
      event: {
        schema_version: "1.0.0",
        event_kind: "assistant_stop",
        event_id: "event-generation-stop-002",
        session_id: "thr_generation_001",
        turn_id: "turn-generation-001",
        cwd: projectRoot,
        occurred_at: "2026-08-03T08:00:03.000Z",
        model: "gpt-5",
        generation: 2,
        stop_hook_active: false,
        last_assistant_message: "Final stabilized answer.",
      },
    });
    await expect(
      storage.completeAutomaticMemoryFormationJob({
        job_id: oldClaim.jobs[0]?.job_id as string,
        generation: 1,
        worker_id: "generation-worker-old",
        completed_at: "2026-08-03T08:00:04.000Z",
        result_hash: `sha256:${"c".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const newClaim = await storage.claimAutomaticMemoryFormationJobs({
      worker_id: "generation-worker-new",
      claimed_at: "2026-08-03T08:00:04.000Z",
      lease_expires_at: "2026-08-03T08:01:04.000Z",
      limit: 1,
    });
    expect(newClaim.jobs[0]).toMatchObject({
      generation: 2,
      attempts: 1,
      assistant_evidence_id: "evidence_generation_assistant_2",
    });
    const completion = {
      job_id: newClaim.jobs[0]?.job_id as string,
      generation: 2,
      worker_id: "generation-worker-new",
      completed_at: "2026-08-03T08:00:05.000Z",
      result_hash: `sha256:${"d".repeat(64)}`,
    } as const;
    const first = await storage.completeAutomaticMemoryFormationJob(completion);
    const replay = await storage.completeAutomaticMemoryFormationJob(completion);
    expect(replay).toEqual(first);
    await storage.close();
  });

  it("rejects project registration outside a managed runtime", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("automatic-authority"),
    });
    await expect(
      storage.registerAutomaticMemoryProject({
        principal_id: "user_local",
        cwd: temporaryRoot("automatic-unmanaged-project"),
        registered_at: NOW,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await storage.close();

    const managed = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("automatic-principal-authority"),
      automaticMemoryPrincipalId: "user_local",
    });
    await expect(
      managed.registerAutomaticMemoryProject({
        principal_id: "another_user",
        cwd: temporaryRoot("automatic-wrong-principal-project"),
        registered_at: NOW,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await managed.close();
  });
});

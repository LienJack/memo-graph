import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adaptEvidenceFastL0 } from "../../packages/evidence-adapter/src/index.js";
import { MemoryRuntime } from "../../packages/memory-kernel/dist/index.js";
import {
  startMemoryWorkbenchHost,
  workbenchArtifactPaths,
  type MemoryWorkbenchHost,
} from "../../apps/memory-workbench-host/src/index.js";
import {
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
} from "../../packages/runtime-host/src/index.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";

const cleanup: string[] = [];
const hosts: MemoryWorkbenchHost[] = [];

function regularFilesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    const metadata = statSync(path);
    if (metadata.isDirectory()) return regularFilesUnder(path);
    return metadata.isFile() ? [path] : [];
  });
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Codex automatic-memory ingress", () => {
  it("seals paired turn evidence in L0 and schedules formation idempotently", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memo-hook-ingress-")));
    cleanup.push(root);
    const dataRoot = join(root, "data");
    const runtimeDirectory = join(root, "runtime");
    const recovery = mcpRecoveryFixture(dataRoot);
    const config = {
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: ["user_stated", "observed"],
      recovery_head: recovery.config,
      automatic_memory: {
        mode: "observe",
        provider: { enabled: false },
        sensitive_identifiers: [],
      },
    };
    const host = await startMemoryWorkbenchHost({
      config,
      runtimeDirectory,
      instanceId: "workbench:automatic-memory",
    });
    hosts.push(host);
    expect(host.runtime).not.toBeNull();

    const paths = workbenchArtifactPaths({
      runtimeDirectory,
      rootIdentity: memoryRuntimeRootIdentity(dataRoot),
      configIdentity: memoryRuntimeConfigIdentity(config),
    });
    const credential = readFileSync(paths.hookCredentialPath, "utf8").trim();
    const invoke = async (body: unknown) => {
      const response = await fetch(`${host.http.origin}/__hooks/capture`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { response, body: await response.json() as Record<string, unknown> };
    };
    const base = {
      schema_version: "1.0.0",
      source: "direct",
    } as const;
    const user = {
      ...base,
      idempotency_key: "hook-user-turn-0001",
      event: {
        schema_version: "1.0.0",
        event_id: "hook:user-turn-0001",
        event_kind: "user_prompt_submit",
        session_id: "thr_automatic",
        turn_id: "turn_automatic",
        generation: 1,
        cwd: root,
        occurred_at: "2026-08-03T08:00:00.000Z",
        model: "gpt-5.6",
        prompt: "Use pnpm for this repository.",
      },
    };
    const assistant = {
      ...base,
      idempotency_key: "hook-assistant-turn-0001",
      event: {
        schema_version: "1.0.0",
        event_id: "hook:assistant-turn-0001",
        event_kind: "assistant_stop",
        session_id: "thr_automatic",
        turn_id: "turn_automatic",
        generation: 1,
        cwd: root,
        occurred_at: "2026-08-03T08:00:01.000Z",
        model: "gpt-5.6",
        stop_hook_active: false,
        last_assistant_message: "Used pnpm and all checks passed.",
      },
    };

    expect(await invoke(user)).toMatchObject({
      response: { status: 200 },
      body: { status: "accepted", additional_context: null },
    });
    expect(await invoke(assistant)).toMatchObject({
      response: { status: 200 },
      body: { status: "accepted" },
    });
    expect(await invoke(assistant)).toMatchObject({
      response: { status: 200 },
      body: { status: "accepted" },
    });

    const openedRuntime = host.runtime;
    if (openedRuntime === null) throw new Error("expected managed runtime");
    const storage = openedRuntime.runtime.storage;
    const project = await storage.registerAutomaticMemoryProject({
      principal_id: "user_local",
      cwd: root,
      registered_at: "2026-08-03T08:00:02.000Z",
    });
    const recallEvidence = adaptEvidenceFastL0({
      idempotency_key: "hook-recall-seed-evidence-0001",
      principal_id: "user_local",
      recorded_at: "2026-08-03T08:00:02.000Z",
      batch: {
        scope: project.scope,
        outcome: "succeeded",
        items: [{
          kind: "conversation_turn",
          speaker: "user",
          text: "Use pnpm for this repository.",
          occurred_at: "2026-08-03T08:00:02.000Z",
          sensitivity: "internal",
        }],
      },
    });
    await storage.commitEpisode({
      idempotencyKey: "hook-recall-seed-evidence-0001",
      episode: recallEvidence.episode,
      evidence: recallEvidence.evidence,
      blobs: [],
    });
    const seedRuntime = new MemoryRuntime({
      storage,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: [project.scope],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: false,
        },
        default_token_budget: 1_800,
      },
    });
    await expect(seedRuntime.memoryPropose(memoryProposal({
      requestId: "request:hook-recall-seed",
      idempotencyKey: "hook-recall-seed-proposal-0001",
      scope: project.scope,
      candidate: memoryCandidate({
        candidateId: "candidate:hook-recall-seed",
        logicalKey: "repository.workflow.package-manager",
        scope: project.scope,
        text: "Use pnpm for this repository.",
        evidenceIds: recallEvidence.evidence.map((item) => item.evidence_id),
        sensitivity: "internal",
      }),
    }))).resolves.toMatchObject({ status: "OK" });
    expect(await invoke({
      ...base,
      idempotency_key: "hook-user-turn-recall-0002",
      event: {
        ...user.event,
        event_id: "hook:user-turn-recall-0002",
        turn_id: "turn_automatic_recall",
        occurred_at: "2026-08-03T08:00:03.000Z",
        prompt: "Please update this repository.",
      },
    })).toMatchObject({
      response: { status: 200 },
      body: {
        status: "accepted",
        additional_context: expect.stringContaining(
          "Use pnpm for this repository.",
        ),
      },
    });
    await expect(host.runtime?.runtime.storage.automaticMemoryStatus()).resolves.toMatchObject({
      projects: 1,
      events: 3,
      turns: 2,
      jobs_pending: 1,
      recall_uses: 2,
    });
  });

  it("rejects secret-shaped turn content before L0 persistence", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memo-hook-secret-")));
    cleanup.push(root);
    const dataRoot = join(root, "data");
    const runtimeDirectory = join(root, "runtime");
    const recovery = mcpRecoveryFixture(dataRoot);
    const config = {
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: ["user_stated", "observed"],
      recovery_head: recovery.config,
      automatic_memory: {
        mode: "observe",
        provider: { enabled: false },
        sensitive_identifiers: [],
      },
    };
    const host = await startMemoryWorkbenchHost({
      config,
      runtimeDirectory,
      instanceId: "workbench:automatic-secret",
    });
    hosts.push(host);
    const paths = workbenchArtifactPaths({
      runtimeDirectory,
      rootIdentity: memoryRuntimeRootIdentity(dataRoot),
      configIdentity: memoryRuntimeConfigIdentity(config),
    });
    const credential = readFileSync(paths.hookCredentialPath, "utf8").trim();
    const secretMarker = "github_pat_abcdefghijklmnopqrstuvwxyz";
    const response = await fetch(`${host.http.origin}/__hooks/capture`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: "1.0.0",
        source: "direct",
        idempotency_key: "hook-secret-event-0001",
        event: {
          schema_version: "1.0.0",
          event_id: "hook:secret-event-0001",
          event_kind: "user_prompt_submit",
          session_id: "thr_secret",
          turn_id: "turn_secret",
          generation: 1,
          cwd: root,
          occurred_at: "2026-08-03T08:00:00.000Z",
          model: null,
          prompt: `token is ${secretMarker}`,
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "rejected" });
    await expect(host.runtime?.runtime.storage.automaticMemoryStatus()).resolves.toMatchObject({
      projects: 0,
      events: 0,
    });
    for (const path of regularFilesUnder(root)) {
      expect(readFileSync(path).includes(Buffer.from(secretMarker))).toBe(false);
    }
  });
});

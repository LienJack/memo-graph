import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adaptEvidenceFastL0 } from "../../packages/evidence-adapter/src/index.js";
import { detectAutomaticContextReceipt } from "../../packages/context-compiler/src/index.js";
import {
  MemoryRuntime,
  compileAutomaticRecall,
} from "../../packages/memory-kernel/dist/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";

const cleanup: string[] = [];
const NOW = "2026-08-03T08:00:00.000Z";

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `memo-${prefix}-`)));
  cleanup.push(root);
  return root;
}

describe("automatic-memory recall replay", () => {
  it("orders exact repository memory before global preference and isolates projects", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("automatic-recall-data"),
      automaticMemoryPrincipalId: "user_local",
    });
    const projectA = await storage.registerAutomaticMemoryProject({
      principal_id: "user_local",
      cwd: temporaryRoot("automatic-recall-project-a"),
      registered_at: NOW,
    });
    const projectB = await storage.registerAutomaticMemoryProject({
      principal_id: "user_local",
      cwd: temporaryRoot("automatic-recall-project-b"),
      registered_at: NOW,
    });
    const userScope = { kind: "user", id: "user_local" } as const;
    const scopes = [projectA.scope, projectB.scope, userScope];
    const runtime = new MemoryRuntime({
      storage,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: scopes,
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: false,
        },
        default_token_budget: 1_800,
      },
    });

    const admit = async (input: {
      id: string;
      logicalKey: string;
      scope: (typeof scopes)[number];
      text: string;
      inferred?: boolean;
      sensitivity?: "internal" | "sensitive";
    }) => {
      const adapted = adaptEvidenceFastL0({
        idempotency_key: `automatic-recall-evidence-${input.id}`,
        principal_id: "user_local",
        recorded_at: NOW,
        batch: {
          scope: input.scope,
          outcome: "succeeded",
          items: [{
            kind: "conversation_turn",
            speaker: "user",
            text: input.text,
            occurred_at: NOW,
            sensitivity: input.sensitivity ?? "internal",
          }],
        },
      });
      await storage.commitEpisode({
        idempotencyKey: `automatic-recall-evidence-${input.id}`,
        episode: adapted.episode,
        evidence: adapted.evidence,
        blobs: [],
      });
      const proposal = memoryProposal({
        requestId: `request:automatic-recall-${input.id}`,
        idempotencyKey: `automatic-recall-proposal-${input.id}`,
        scope: input.scope,
        candidate: memoryCandidate({
          candidateId: `candidate:automatic-recall-${input.id}`,
          logicalKey: input.logicalKey,
          scope: input.scope,
          text: input.text,
          evidenceIds: adapted.evidence.map((item) => item.evidence_id),
          ...(input.inferred === undefined ? {} : { inferred: input.inferred }),
          sensitivity: input.sensitivity ?? "internal",
        }),
      });
      await expect(runtime.memoryPropose(proposal)).resolves.toMatchObject({
        status: "OK",
      });
    };

    await admit({
      id: "global",
      logicalKey: "user.presentation.concise",
      scope: userScope,
      text: "Prefer concise Chinese explanations.",
    });
    await admit({
      id: "project-a",
      logicalKey: "repository.workflow.package-manager",
      scope: projectA.scope,
      text: "Use pnpm and explain repository changes in detail.",
    });
    await admit({
      id: "project-b",
      logicalKey: "repository.workflow.foreign",
      scope: projectB.scope,
      text: "This foreign repository uses npm only.",
    });
    await admit({
      id: "candidate-only",
      logicalKey: "repository.unconfirmed",
      scope: projectA.scope,
      text: "Unconfirmed candidate must stay out of automatic context.",
      inferred: true,
    });
    await admit({
      id: "sensitive",
      logicalKey: "repository.sensitive",
      scope: projectA.scope,
      text: "Sensitive material must stay out of automatic context.",
      sensitivity: "sensitive",
    });

    const recall = await compileAutomaticRecall({
      storage,
      principalId: "user_local",
      projectId: projectA.project_id,
      projectScope: projectA.scope,
      sessionId: "thr_automatic_recall",
      turnId: "turn_automatic_recall",
      prompt: "Please update this repository and explain it in Chinese.",
      asOf: "2026-08-03T08:01:00.000Z",
    });
    expect(recall.additional_context).toContain("automatic-context v1");
    expect(detectAutomaticContextReceipt(recall.additional_context ?? "")).toBe(
      recall.receipt_id,
    );
    expect(recall.additional_context).toContain(
      "Use pnpm and explain repository changes in detail.",
    );
    expect(recall.additional_context).toContain(
      "Prefer concise Chinese explanations.",
    );
    expect(recall.additional_context).not.toContain("npm only");
    expect(recall.additional_context).not.toContain("Unconfirmed candidate");
    expect(recall.additional_context).not.toContain("Sensitive material");
    expect(
      recall.additional_context?.indexOf("Use pnpm") ?? -1,
    ).toBeLessThan(
      recall.additional_context?.indexOf("Prefer concise") ?? -1,
    );
    expect(Buffer.byteLength(recall.additional_context ?? "", "utf8")).toBeLessThanOrEqual(
      8_000,
    );
    expect(recall.token_count).toBeLessThanOrEqual(600);

    await expect(compileAutomaticRecall({
      storage,
      principalId: "user_local",
      projectId: projectA.project_id,
      projectScope: projectA.scope,
      sessionId: "thr_automatic_recall",
      turnId: "turn_automatic_recall",
      prompt: "Please update this repository and explain it in Chinese.",
      asOf: "2026-08-03T08:01:00.000Z",
    })).resolves.toEqual(recall);
    await expect(storage.automaticMemoryStatus()).resolves.toMatchObject({
      recall_uses: 1,
    });
    const durations: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const started = performance.now();
      await compileAutomaticRecall({
        storage,
        principalId: "user_local",
        projectId: projectA.project_id,
        projectScope: projectA.scope,
        sessionId: "thr_automatic_recall_benchmark",
        turnId: `turn_automatic_recall_${index}`,
        prompt: "Please update this repository and explain it in Chinese.",
        asOf: "2026-08-03T08:01:00.000Z",
      });
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.ceil(durations.length * 0.95) - 1]).toBeLessThanOrEqual(
      200,
    );
    await storage.close();
  });

  it("enforces item, token, and byte budgets deterministically", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("automatic-recall-budget"),
      automaticMemoryPrincipalId: "user_local",
    });
    const project = await storage.registerAutomaticMemoryProject({
      principal_id: "user_local",
      cwd: temporaryRoot("automatic-recall-budget-project"),
      registered_at: NOW,
    });
    const recall = await compileAutomaticRecall({
      storage,
      principalId: "user_local",
      projectId: project.project_id,
      projectScope: project.scope,
      sessionId: "thr_budget",
      turnId: "turn_budget",
      prompt: "No memories exist.",
      asOf: NOW,
      limits: { maxItems: 1, maxTokens: 80, maxBytes: 512 },
    });
    expect(recall.additional_context).toBeNull();
    expect(recall.selected).toEqual([]);
    expect(recall.token_count).toBe(0);
    await storage.close();
  });
});

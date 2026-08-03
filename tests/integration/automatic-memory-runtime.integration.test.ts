import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderFormationResultSchema,
  type ProviderFormationRequest,
} from "../../packages/contracts/src/index.js";
import { adaptEvidenceFastL0 } from "../../packages/evidence-adapter/src/index.js";
import type { MemoryFormationProvider } from "../../packages/memory-formation/src/index.js";
import { openMemoryRuntime } from "../../packages/runtime-host/src/index.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

class PreferenceProvider implements MemoryFormationProvider {
  readonly id = "fake_provider";

  async extract(request: ProviderFormationRequest) {
    const user = request.turns.find((turn) => turn.role === "user");
    if (user === undefined) {
      throw new Error("expected one user turn");
    }
    return ProviderFormationResultSchema.parse({
      schema_version: "1.0.0",
      request_id: request.request_id,
      provider_id: this.id,
      model: "fake-model",
      completed_at: new Date().toISOString(),
      proposals: [{
        schema_version: "1.0.0",
        proposal_id: "proposal:concise-chinese",
        category: "stable_user_preference",
        summary: "The user prefers concise Chinese explanations.",
        logical_key: "user.presentation.explanation_style",
        recommended_scope: "global_user",
        sensitivity: "internal",
        authority_basis: "user_explicit",
        temporariness: "durable",
        explicitness: 0.98,
        expected_reuse: 0.95,
        stability: 0.95,
        confidence: 0.98,
        conflict_likelihood: 0.01,
        evidence: [{
          evidence_id: user.evidence_id,
          speaker: "user",
          authority: "user_stated",
          content_hash: user.content_hash,
        }],
      }],
      usage: { input_tokens: 32, output_tokens: 24 },
    });
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 6_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("automatic-memory runtime did not converge");
}

describe("managed automatic-memory runtime", () => {
  it("forms and activates a durable preference without remember wording", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memo-runtime-auto-")));
    cleanup.push(root);
    const projectRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "memo-runtime-project-")),
    );
    cleanup.push(projectRoot);
    const dataRoot = join(root, "data");
    const recovery = mcpRecoveryFixture(dataRoot);
    const opened = await openMemoryRuntime({
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: [
        "user_stated",
        "observed",
        "tool_result",
        "inferred",
        "derived",
        "imported",
      ],
      automatic_memory: {
        mode: "balanced",
        provider: { enabled: false },
        sensitive_identifiers: [],
      },
      recovery_head: recovery.config,
    }, {
      mode: "managed",
      automaticMemoryProvider: {
        provider: new PreferenceProvider(),
        model: "fake-model",
      },
    });

    try {
      const now = new Date().toISOString();
      const project = await opened.storage.registerAutomaticMemoryProject({
        principal_id: "user_local",
        cwd: projectRoot,
        registered_at: now,
      });
      const adapted = adaptEvidenceFastL0({
        idempotency_key: "automatic-runtime-evidence-0001",
        principal_id: "user_local",
        recorded_at: now,
        batch: {
          scope: project.scope,
          outcome: "succeeded",
          items: [
            {
              kind: "conversation_turn",
              speaker: "user",
              text: "I consistently prefer concise Chinese explanations.",
              occurred_at: now,
              sensitivity: "internal",
            },
            {
              kind: "conversation_turn",
              speaker: "assistant",
              text: "Understood. I will keep explanations concise.",
              occurred_at: now,
              sensitivity: "internal",
            },
          ],
        },
      });
      await opened.storage.commitEpisode({
        idempotencyKey: "automatic-runtime-evidence-0001",
        episode: adapted.episode,
        evidence: adapted.evidence,
        blobs: [],
      });
      const [userEvidence, assistantEvidence] = adapted.evidence;
      if (userEvidence === undefined || assistantEvidence === undefined) {
        throw new Error("expected paired evidence");
      }
      await opened.storage.captureAutomaticMemoryEvent({
        schema_version: "1.0.0",
        idempotency_key: "automatic-runtime-user-0001",
        principal_id: "user_local",
        project_id: project.project_id,
        evidence_id: userEvidence.evidence_id,
        source: "direct",
        captured_at: now,
        stabilization_delay_ms: 0,
        event: {
          schema_version: "1.0.0",
          event_id: "hook:automatic-runtime-user-0001",
          event_kind: "user_prompt_submit",
          session_id: "thr_automatic_runtime",
          turn_id: "turn_automatic_runtime",
          generation: 1,
          cwd: projectRoot,
          occurred_at: now,
          model: "fake-model",
          prompt: userEvidence.payload.storage === "inline"
            ? userEvidence.payload.text
            : "",
        },
      });
      await opened.storage.captureAutomaticMemoryEvent({
        schema_version: "1.0.0",
        idempotency_key: "automatic-runtime-assistant-0001",
        principal_id: "user_local",
        project_id: project.project_id,
        evidence_id: assistantEvidence.evidence_id,
        source: "direct",
        captured_at: now,
        stabilization_delay_ms: 0,
        event: {
          schema_version: "1.0.0",
          event_id: "hook:automatic-runtime-assistant-0001",
          event_kind: "assistant_stop",
          session_id: "thr_automatic_runtime",
          turn_id: "turn_automatic_runtime",
          generation: 1,
          cwd: projectRoot,
          occurred_at: now,
          model: "fake-model",
          stop_hook_active: false,
          last_assistant_message:
            assistantEvidence.payload.storage === "inline"
              ? assistantEvidence.payload.text
              : null,
        },
      });

      await waitUntil(async () =>
        (await opened.storage.automaticMemoryStatus()).jobs_completed === 1
      );
      await expect(opened.storage.automaticMemoryStatus()).resolves.toMatchObject({
        provider_attempts: 1,
        policy_decisions: 1,
        admission_links: 1,
        failures: 0,
      });
      await expect(opened.storage.governanceStatus()).resolves.toMatchObject({
        governance: {
          memory_candidates: 1,
          memory_objects: 1,
          memory_revisions: 1,
        },
      });
      const activity = await opened.storage.listAutomaticMemoryActivity({
        principal_id: "user_local",
        allowed_scopes: [project.scope, { kind: "user", id: "user_local" }],
        limit: 10,
      });
      expect(activity.status).toBe("ready");
      if (activity.status !== "ready") {
        throw new Error("expected automatic memory activity");
      }
      const decision = activity.items[0]?.decisions[0];
      expect(decision).toMatchObject({
        disposition: "activate",
        memory_scope: { kind: "user", id: "user_local" },
      });
      if (decision?.memory_id === null || decision?.memory_id === undefined ||
        decision.revision_id === null || decision.revision_id === undefined) {
        throw new Error("expected linked automatic admission");
      }

      let sequence = 0;
      const workbench = opened.runtime.createWorkbenchService({
        create: () => {
          throw new Error("snapshot registry is not used by automatic undo");
        },
        read: () => ({ status: "stale", reason_code: "CURSOR_INVALID" }),
      }, {
        sessionId: "session_automatic_undo",
        idFactory: (prefix) => `${prefix}_${++sequence}`,
      });
      const preview = await workbench.previewAutomaticMemoryUndo({
        memory_id: decision.memory_id,
        expected_revision_id: decision.revision_id,
      });
      expect(preview).toMatchObject({
        status: "ready",
        effect: "demote_from_automatic_recall",
      });
      if (preview.status !== "ready") {
        throw new Error("expected automatic undo preview");
      }
      const confirmed = await workbench.confirmAutomaticMemoryUndo({
        preview_id: preview.preview_id,
        confirmed: true,
      });
      expect(confirmed).toMatchObject({
        status: "ready",
        lifecycle: "candidate",
        replayed: false,
      });
      const replay = await workbench.confirmAutomaticMemoryUndo({
        preview_id: preview.preview_id,
        confirmed: true,
      });
      expect(replay).toMatchObject({
        status: "ready",
        lifecycle: "candidate",
        replayed: true,
      });
      await expect(opened.storage.checkMemoryEligibility({
        memory_id: decision.memory_id,
        revision_id: decision.revision_id,
        principal_id: "user_local",
        scope: { kind: "user", id: "user_local" },
        as_of: new Date().toISOString(),
        include_sensitive: false,
        context_scope: null,
      })).resolves.toMatchObject({
        eligible: false,
        memory_id: decision.memory_id,
        revision_id: decision.revision_id,
        reason_code: "CANDIDATE_ONLY",
      });
    } finally {
      await opened.close();
    }
  });
});

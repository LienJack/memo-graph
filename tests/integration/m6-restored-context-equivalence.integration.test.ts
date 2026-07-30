import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { testRecoveryHeadProvider } from "../helpers/recovery.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const NOW = "2026-07-28T12:12:00.000Z";
const SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-m6-ae1-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function runtime(storage: SqliteStorageClient): MemoryRuntime {
  return new MemoryRuntime({
    storage,
    clock: () => NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: false,
      },
      default_token_budget: 800,
      lane_policy: {
        allowed_lanes: ["recent_l1"],
        limits: {
          max_candidates_per_lane: 20,
          relation_max_depth: 0,
          relation_max_fanout: 1,
          max_concurrent_lanes: 1,
        },
      },
    },
  });
}

function compileRequest(requestId: string) {
  return {
    envelope: {
      schema_version: "1.0.0",
      request_id: requestId,
      tool: "memory_context_compile",
      actor_claim: {
        principal_id: "user_local",
        authority: "user_stated",
      },
      scopes: [SCOPE],
      purpose: "restore accepted cross-session working context",
      reason: "prove backup restore preserves governed context semantics",
      requested_at: NOW,
      safety_class: "read_only",
    },
    recall: {
      schema_version: "1.0.0",
      request_id: requestId,
      goal: "apply the explanation preference and project constraint",
      query: "continuity",
      scopes: [SCOPE],
      as_of: NOW,
      token_budget: 800,
      include_sensitive: false,
      lane_overrides: {
        requested_lanes: ["recent_l1"],
        limits: {
          max_candidates_per_lane: 20,
          relation_max_depth: 0,
          relation_max_fanout: 1,
          max_concurrent_lanes: 1,
        },
      },
    },
  } as const;
}

function semanticItems(response: Awaited<
  ReturnType<MemoryRuntime["memoryContextCompile"]>
>) {
  if (response.status !== "OK" && response.status !== "DEGRADED") {
    throw new Error(`context compilation failed: ${JSON.stringify(response)}`);
  }
  const context = (response.data as {
    context_slice: {
      token_budget: number;
      token_used: number;
      items: Array<{
        memory_id: string;
        revision_id: string;
        content: unknown;
        evidence_ids: string[];
        selection_reason: string;
        uncertainty: string | null;
        token_estimate: number;
        lane?: string;
        decision_reason_codes?: string[];
      }>;
    };
  }).context_slice;
  return {
    token_budget: context.token_budget,
    token_used: context.token_used,
    items: context.items.map((item) => ({
      memory_id: item.memory_id,
      revision_id: item.revision_id,
      content: item.content,
      evidence_ids: item.evidence_ids,
      selection_reason: item.selection_reason,
      uncertainty: item.uncertainty,
      token_estimate: item.token_estimate,
      lane: item.lane,
      decision_reason_codes: item.decision_reason_codes,
    })),
    serialized: JSON.stringify(context),
  };
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("M6 restored context equivalence", () => {
  it("restores the same accepted preference and project constraint without replaying transcripts", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:m6-ae1",
    );
    const sourceRoot = temporaryRoot("source");
    const source = await SqliteStorageClient.open({
      dataRoot: sourceRoot,
      recoveryHeadProvider,
    });
    const fixtures = [
      {
        episodeId: "episode_m6_preference_session",
        evidenceId: "evidence_m6_preference_session",
        idempotencyKey: "commit:m6-preference-session:0001",
        transcript:
          "SESSION ONE RAW TRANSCRIPT 7391: the speaker explored several discarded writing styles before deciding.",
        candidateId: "candidate_m6_preference",
        logicalKey: "user.preference.m6_explanation_style",
        memory:
          "For continuity, prefer evidence-dense Chinese technical explanations.",
      },
      {
        episodeId: "episode_m6_constraint_session",
        evidenceId: "evidence_m6_constraint_session",
        idempotencyKey: "commit:m6-constraint-session:0001",
        transcript:
          "SESSION TWO RAW TRANSCRIPT 8426: a long deployment discussion contained unrelated operational chatter.",
        candidateId: "candidate_m6_project_constraint",
        logicalKey: "workspace.constraint.m6_migrations",
        memory:
          "For continuity, production migrations must be immutable and independently verified.",
      },
    ] as const;
    for (const fixture of fixtures) {
      await source.commitEpisode(
        inlineEpisode({
          episodeId: fixture.episodeId,
          evidenceId: fixture.evidenceId,
          idempotencyKey: fixture.idempotencyKey,
          text: fixture.transcript,
        }),
      );
      await runtime(source).memoryPropose(
        memoryProposal({
          candidate: memoryCandidate({
            candidateId: fixture.candidateId,
            logicalKey: fixture.logicalKey,
            scope: SCOPE,
            text: fixture.memory,
            evidenceIds: [fixture.evidenceId],
          }),
          idempotencyKey: `propose:${fixture.candidateId}:0001`,
          requestId: `request_${fixture.candidateId}`,
          scope: SCOPE,
        }),
      );
    }
    await source.drainFtsOutbox();
    const before = semanticItems(
      await runtime(source).memoryContextCompile(
        compileRequest("request_m6_context_before_restore"),
      ),
    );
    expect(before.items).toHaveLength(2);
    expect(before.token_used).toBeLessThanOrEqual(before.token_budget);
    for (const fixture of fixtures) {
      expect(before.serialized).not.toContain(fixture.transcript);
    }

    const backup = await source.createBackup();
    await source.close();
    const targetRoot = join(temporaryRoot("target-parent"), "target");
    await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: targetRoot,
      recoveryHeadProvider,
    });
    const restored = await SqliteStorageClient.open({
      dataRoot: targetRoot,
      recoveryHeadProvider,
    });
    try {
      const after = semanticItems(
        await runtime(restored).memoryContextCompile(
          compileRequest("request_m6_context_after_restore"),
        ),
      );
      expect(after.items).toEqual(before.items);
      expect(after.token_used).toBe(before.token_used);
      expect(after.token_used).toBeLessThanOrEqual(after.token_budget);
      for (const fixture of fixtures) {
        expect(after.serialized).not.toContain(fixture.transcript);
      }
    } finally {
      await restored.close();
    }
  });
});

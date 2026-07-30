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
  LearningCanaryRunner,
  LearningReleaseManager,
} from "../../packages/learning-lab/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import { NOW } from "../helpers/examples.js";
import {
  canaryInput,
  prepareApprovedCandidate,
} from "../helpers/g5-canary.js";
import {
  authorizeRelease,
  preparePassedCanary,
  releaseRequest,
  TestReleaseApprovalRegistry,
} from "../helpers/g5-release.js";
import { testRecoveryHeadProvider } from "../helpers/recovery.js";
import {
  learningCandidate,
} from "../helpers/learning-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-m6-ae7-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function runtime(
  storage: SqliteStorageClient,
  approvals: TestApprovalRegistry,
) {
  return new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    clock: () => NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: false,
      },
    },
  });
}

function readEnvelope<const Tool extends string>(
  tool: Tool,
  requestId: string,
) {
  return {
    schema_version: "1.0.0",
    request_id: requestId,
    tool,
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated",
    },
    scopes: [SCOPE],
    purpose: "verify restored paused-learning runtime continuity",
    reason: "ordinary governed memory remains available during pause",
    requested_at: NOW,
    safety_class: "read_only",
  } as const;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("paused learning snapshot recovery", () => {
  it("restores the paused frontier while recall and authorized writes remain available", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:m6-ae7",
    );
    const sourceRoot = temporaryRoot("source");
    const source = await SqliteStorageClient.open({
      dataRoot: sourceRoot,
      recoveryHeadProvider,
    });
    await source.commitEpisode(
      inlineEpisode({
        episodeId: "episode_m6_paused_snapshot",
        evidenceId: "evidence_m6_paused_snapshot",
        idempotencyKey: "commit:m6-paused-snapshot:0001",
        text: "Paused learning still serves governed memory.",
      }),
    );
    await source.drainFtsOutbox();
    const releaseApprovals = new TestReleaseApprovalRegistry();
    const releaseCandidate = learningCandidate({
      candidate_id: "candidate_m6_paused_release",
      trace_ids: ["trace_m6_paused_release"],
    });
    const prepared = await preparePassedCanary({
      storage: source,
      suffix: "m6-paused-snapshot",
      candidate: releaseCandidate,
    });
    const release = releaseRequest({
      suffix: "m6-paused-snapshot",
      candidateId: releaseCandidate.candidate_id,
    });
    authorizeRelease({
      request: release,
      prepared,
      approvals: releaseApprovals,
    });
    const approvedForCanary = await prepareApprovedCandidate({
      storage: source,
      runId: "run_m6_paused_restore_canary",
      evaluationKey: "evaluation:m6-paused-restore-canary:0001",
    });
    const pausedCanaryInput = await canaryInput({
      evaluation: approvedForCanary.evaluation,
      authorizationId: "authorization_m6_paused_restore_canary",
      controlEpoch: 1,
    });

    const controlApprovals = new TestApprovalRegistry();
    const sourceRuntime = runtime(source, controlApprovals);
    const frontier =
      (await sourceRuntime.learningInspection()).action_frontier;
    const pause = {
      envelope: {
        ...readEnvelope("learning_pause", "request_m6_pause_before_backup"),
        safety_class: "important_mutation",
        idempotency_key: "learning-pause-m6-before-backup-001",
        expected_revision_id: null,
        approval_id: "approval_m6_pause_before_backup",
        dry_run: false,
      },
      expected_control_epoch: frontier.expected_control_epoch,
      expected_frontier_hash: frontier.expected_frontier_hash,
      runtime_identity_hash: frontier.runtime_identity_hash,
      configuration_hash: frontier.configuration_hash,
      corpus_hash: frontier.corpus_hash,
    } as const;
    controlApprovals.approve(pause);
    expect(await sourceRuntime.learningPause(pause)).toMatchObject({
      status: "OK",
      data: { control: { status: "paused", control_epoch: 1 } },
    });
    const pausedFrontier = (await source.health()).learning_frontier;
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
      const restoredRuntime = runtime(restored, controlApprovals);
      expect((await restored.health()).learning_frontier).toEqual(
        pausedFrontier,
      );
      expect((await restoredRuntime.learningInspection()).control)
        .toMatchObject({ status: "paused", control_epoch: 1 });
      expect(
        await restoredRuntime.memorySearch({
          envelope: readEnvelope(
            "memory_search",
            "request_m6_paused_recall",
          ),
          query: "Paused learning governed memory",
          limit: 10,
          include_sensitive: false,
        }),
      ).toMatchObject({ status: "OK" });

      const additional = inlineEpisode({
        episodeId: "episode_m6_paused_authorized_write",
        evidenceId: "evidence_m6_paused_authorized_write",
        idempotencyKey: "commit:m6-paused-authorized-write:0001",
        text: "Authorized ordinary memory writes continue while paused.",
      });
      expect(
        await restoredRuntime.memoryEpisodeCommit({
          envelope: {
            ...readEnvelope(
              "memory_episode_commit",
              "request_m6_paused_write",
            ),
            safety_class: "proposal",
            idempotency_key: additional.idempotencyKey,
          },
          episode: additional.episode,
          evidence: additional.evidence,
          blobs: [],
        }),
      ).toMatchObject({ status: "OK" });

      expect(
        await restoredRuntime.memoryFeedback({
          envelope: {
            ...readEnvelope(
              "memory_feedback",
              "request_m6_paused_candidate",
            ),
            safety_class: "proposal",
            idempotency_key: "feedback:m6-paused-candidate:0001",
          },
          feedback: {
            task_id: "task_m6_paused_candidate",
            context_slice_id: "context_m6_paused_candidate",
            outcome: "partial",
            evidence_ids: ["evidence_m6_paused_snapshot"],
            error_codes: ["PAUSED_SNAPSHOT_PROBE"],
            gap_codes: [],
            observed_at: NOW,
          },
        }),
      ).toMatchObject({
        status: "OK",
        data: {
          reason_code: "LEARNING_PAUSED",
          candidate_published: false,
          pointer_changed: false,
        },
      });
      let canaryExposures = 0;
      await expect(
        new LearningCanaryRunner({
          storage: restored,
          partitions: {
            loadCanaryCases: async () => {
              throw new Error(
                "paused canary must not open sealed fixtures",
              );
            },
          },
          authorityRegistry: prepared.authority,
          executeCase: () => {
            canaryExposures += 1;
            throw new Error("paused canary must not expose cases");
          },
          stateProbe: () =>
            approvedForCanary.evaluation.identity.environment_hash,
          clock: () => NOW,
        }).run(pausedCanaryInput),
      ).rejects.toMatchObject({ code: "LEARNING_PAUSED" });
      expect(canaryExposures).toBe(0);
      await expect(
        new LearningReleaseManager({
          storage: restored,
          authorityRegistry: prepared.authority,
          approvalRegistry: releaseApprovals,
          clock: () => "2026-07-28T12:05:00.000Z",
        }).apply(release),
      ).rejects.toMatchObject({ code: "LEARNING_PAUSED" });
      expect((await restoredRuntime.learningInspection()).control)
        .toMatchObject({ status: "paused", control_epoch: 1 });
    } finally {
      await restored.close();
    }
  });
});

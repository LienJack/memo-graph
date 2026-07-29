import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LearningPauseInputSchema,
  MEMORY_TOOL_SAFETY_CLASS,
  MonitorReceiptSchema,
  MonitorResultSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import {
  MEMORY_RESOURCE_URIS,
  MEMORY_TOOL_METADATA,
} from "../../packages/mcp-server/src/index.js";
import type {
  LearningReleaseResult,
} from "../../packages/learning-lab/src/index.js";
import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import { NOW } from "../helpers/examples.js";
import {
  BASE_LANE_POLICY,
  RELEASE_CLOCK,
  RELEASE_SCOPES,
  TestReleaseApprovalRegistry,
  authorizeRelease,
  authorizeRollback,
  learnedPolicyFor,
  preparePassedCanary,
  releaseEffectManifest,
  releaseRequest,
  rollbackRequest,
} from "../helpers/g5-release.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const WORKSPACE_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const HASH_RUNTIME = `sha256:${"1".repeat(64)}` as const;
const HASH_CONFIGURATION = `sha256:${"2".repeat(64)}` as const;
const HASH_CORPUS = `sha256:${"3".repeat(64)}` as const;
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function mutationEnvelope(
  tool: "learning_pause" | "learning_resume",
  suffix: string,
) {
  return {
    schema_version: "1.0.0",
    request_id: `request_${suffix}`,
    tool,
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated",
    },
    scopes: [WORKSPACE_SCOPE],
    purpose: "govern the local learning loop",
    reason: "operator requested an exact learning control transition",
    requested_at: NOW,
    safety_class: "important_mutation",
    idempotency_key: `learning-control-${suffix}-001`,
    expected_revision_id: null,
    approval_id: `approval_${suffix}`,
    dry_run: false,
  } as const;
}

function proposalEnvelope(suffix: string) {
  return {
    schema_version: "1.0.0",
    request_id: `request_${suffix}`,
    tool: "memory_feedback",
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated",
    },
    scopes: [WORKSPACE_SCOPE],
    purpose: "record governed learning feedback",
    reason: "preserve outcome metadata without publishing a candidate",
    requested_at: NOW,
    safety_class: "proposal",
    idempotency_key: `memory-feedback-${suffix}-001`,
  } as const;
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
        allowed_scopes: [WORKSPACE_SCOPE],
        allowed_authorities: ["user_stated", "tool_result"],
        destructive_tools_enabled: false,
      },
    },
  });
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("governed MCP learning controls", () => {
  it("publishes complete metadata and rejects non-exact learning mutations", () => {
    expect(
      MEMORY_TOOL_METADATA.map((entry) => entry.name).sort(),
    ).toEqual(Object.keys(MEMORY_TOOL_SAFETY_CLASS).sort());
    expect(MEMORY_RESOURCE_URIS).toContain("memory://runtime/learning");

    const envelope = mutationEnvelope("learning_pause", "contract");
    const exact = {
      envelope,
      expected_control_epoch: 0,
      expected_frontier_hash: `sha256:${"0".repeat(64)}`,
      runtime_identity_hash: HASH_RUNTIME,
      configuration_hash: HASH_CONFIGURATION,
      corpus_hash: HASH_CORPUS,
    };
    expect(LearningPauseInputSchema.safeParse(exact).success).toBe(true);
    expect(
      LearningPauseInputSchema.safeParse({
        ...exact,
        envelope: { ...envelope, dry_run: true },
      }).success,
    ).toBe(false);
    expect(
      LearningPauseInputSchema.safeParse({
        ...exact,
        envelope: {
          ...envelope,
          expected_revision_id: "revision_not_allowed",
        },
      }).success,
    ).toBe(false);
  });

  it("records content-free feedback, pauses exactly, inspects, and resumes", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("mcp-learning-controls"),
    });
    try {
      const episode = inlineEpisode({
        evidenceId: "evidence_feedback_secret_marker",
        text: "PRIVATE_MARKER_MUST_NOT_APPEAR_IN_LEARNING_INSPECTION",
      });
      await storage.commitEpisode({
        idempotencyKey: episode.idempotencyKey,
        episode: episode.episode,
        evidence: episode.evidence,
        blobs: [],
      });
      const approvals = new TestApprovalRegistry();
      const memory = runtime(storage, approvals);

      const feedbackRequest = {
        envelope: proposalEnvelope("accepted"),
        feedback: {
          task_id: "task_feedback_1",
          context_slice_id: "context_feedback_1",
          outcome: "failed",
          evidence_ids: ["evidence_feedback_secret_marker"],
          error_codes: ["NO_RELEVANT_MEMORY"],
          gap_codes: ["RETRIEVAL_POLICY_TOO_BROAD"],
          observed_at: NOW,
        },
      } as const;
      const feedback = await memory.memoryFeedback(feedbackRequest);
      expect(feedback).toMatchObject({
        status: "OK",
        data: {
          reason_code: "FEEDBACK_RECORDED_PENDING_TRACE",
          candidate_published: false,
          pointer_changed: false,
        },
      });
      expect(await memory.memoryFeedback(feedbackRequest)).toEqual(feedback);

      const afterFeedback = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [WORKSPACE_SCOPE],
      });
      expect(afterFeedback.candidates).toEqual([]);
      expect(afterFeedback.pointers).toEqual([]);
      expect(afterFeedback.receipts).toEqual([
        expect.objectContaining({ kind: "learning_stop" }),
      ]);

      const pauseEnvelope = mutationEnvelope("learning_pause", "pause");
      const pauseRequest = {
        envelope: pauseEnvelope,
        expected_control_epoch: 0,
        expected_frontier_hash:
          (await storage.health()).learning_frontier.frontier_hash,
        runtime_identity_hash: HASH_RUNTIME,
        configuration_hash: HASH_CONFIGURATION,
        corpus_hash: HASH_CORPUS,
      } as const;
      approvals.approve(pauseRequest);
      const paused = await memory.learningPause(pauseRequest);
      expect(paused).toMatchObject({
        status: "OK",
        data: {
          control: {
            status: "paused",
            control_epoch: 1,
          },
          replayed: false,
        },
      });
      expect(await memory.learningPause(pauseRequest)).toMatchObject({
        status: "OK",
        receipt_id: paused.receipt_id,
        data: {
          replayed: true,
          control: {
            status: "paused",
            control_epoch: 1,
          },
        },
      });

      const changedPause = await memory.learningPause({
        ...pauseRequest,
        corpus_hash: `sha256:${"4".repeat(64)}`,
      });
      expect(changedPause).toMatchObject({
        status: "FAILED",
        error: { code: "CONFLICT" },
      });

      const inspection = await memory.learningInspection();
      expect(inspection.control).toMatchObject({
        status: "paused",
        control_epoch: 1,
      });
      expect(inspection.candidates).toEqual([]);
      expect(inspection.pointers).toEqual([]);
      expect(canonicalJson(inspection)).not.toContain(
        "PRIVATE_MARKER_MUST_NOT_APPEAR_IN_LEARNING_INSPECTION",
      );

      const resumeEnvelope = mutationEnvelope("learning_resume", "resume");
      const resumeRequest = {
        envelope: resumeEnvelope,
        expected_control_epoch: 1,
        expected_frontier_hash:
          (await storage.health()).learning_frontier.frontier_hash,
        runtime_identity_hash: HASH_RUNTIME,
        configuration_hash: HASH_CONFIGURATION,
        corpus_hash: HASH_CORPUS,
        abandon_in_flight: false,
      } as const;
      approvals.approve(resumeRequest);
      const resumed = await memory.learningResume(resumeRequest);
      expect(resumed).toMatchObject({
        status: "OK",
        data: {
          control: {
            status: "active",
            control_epoch: 2,
            reason_code: "EXACT_FRONTIER_RESUMED",
          },
        },
      });
    } finally {
      await storage.close();
    }
  });

  it("adapts exact public release and rollback requests to the governed manager", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("mcp-learning-release"),
    });
    try {
      const prepared = await preparePassedCanary({
        storage,
        suffix: "mcp-public",
      });
      if (prepared.candidate.release_slot === null) {
        throw new Error("release-capable fixture requires a slot");
      }
      const approvals = new TestReleaseApprovalRegistry();
      const memory = new MemoryRuntime({
        storage,
        approvalRegistry: approvals,
        learningAuthorityRegistry: prepared.authority,
        clock: () => RELEASE_CLOCK,
        policy: {
          principal: {
            principal_id: "user_local",
            allowed_scopes: RELEASE_SCOPES,
            allowed_authorities: ["user_stated"],
            destructive_tools_enabled: false,
          },
          lane_policy: BASE_LANE_POLICY,
        },
      });
      const internalRelease = releaseRequest({
        suffix: "mcp-public",
      });
      const releaseConfigurationHash = canonicalSha256(
        learnedPolicyFor(prepared.candidate),
      );
      const publicRelease = {
        envelope: {
          schema_version: "1.0.0",
          request_id: "request_mcp_public_release",
          tool: "learning_release",
          actor_claim: {
            principal_id: "user_local",
            authority: "user_stated",
          },
          scopes: RELEASE_SCOPES,
          purpose: "publish the exact evaluated candidate",
          reason: internalRelease.reason,
          requested_at: RELEASE_CLOCK,
          safety_class: "important_mutation",
          idempotency_key: internalRelease.idempotency_key,
          expected_revision_id: null,
          approval_id: internalRelease.approval_id,
          dry_run: false,
        },
        candidate_id: prepared.candidate.candidate_id,
        release_slot_hash: prepared.candidate.release_slot.slot_hash,
        evaluation_receipt_id:
          prepared.evaluation.receipt.receipt_id,
        canary_receipt_id: prepared.canary.receipt.receipt_id,
        expected_pointer_revision: 0,
        expected_control_epoch: 0,
        base_configuration_hash:
          internalRelease.base_configuration_hash,
        monitor_contract_hash:
          internalRelease.monitor_contract_hash,
        effect_manifest_hash: releaseEffectManifest({
          request: internalRelease,
          candidate: prepared.candidate,
          baseReleaseId: null,
          resultingConfigurationHash: releaseConfigurationHash,
        }),
      } as const;
      authorizeRelease({
        request: internalRelease,
        prepared,
        approvals,
        requestHash: canonicalSha256(publicRelease),
      });
      const released = await memory.learningRelease(publicRelease);
      expect(released).toMatchObject({
        status: "OK",
        data: {
          release: { action: "release" },
          pointer: {
            pointer_revision: 1,
          },
        },
      });
      if (released.status !== "OK") {
        throw new Error(canonicalJson(released));
      }
      const releasedData = released.data as LearningReleaseResult;
      const monitorInput = {
        schema_version: "1.0.0",
        monitor_id: "monitor_mcp_public",
        release_id: releasedData.release.release_id,
        pointer_revision: releasedData.pointer.pointer_revision,
        canary_receipt_id:
          prepared.canary.receipt.receipt_id,
        replayed_case_ids: [
          "canary_mcp_public_1",
          "canary_mcp_public_2",
          "canary_mcp_public_3",
        ],
        passed: false,
        failure_codes: ["REGRESSION_DETECTED"],
        rollback_required: true,
        monitored_at: "2026-07-28T12:05:30.000Z",
        monitor_hash: canonicalSha256("placeholder"),
      };
      const monitor = MonitorResultSchema.parse({
        ...monitorInput,
        monitor_hash: canonicalSha256Omitting(monitorInput, [
          "monitor_hash",
        ]),
      });
      const monitorReceipt = MonitorReceiptSchema.parse(
        sealReceipt({
          schema_version: "1.0.0",
          receipt_id: "receipt_monitor_mcp_public",
          created_at: monitor.monitored_at,
          state: "durable",
          request_hash: canonicalSha256({
            kind: "mcp_public_monitor",
            release_id: releasedData.release.release_id,
          }),
          kind: "learning_monitor",
          release_id: releasedData.release.release_id,
          pointer_revision: releasedData.pointer.pointer_revision,
          canary_receipt_id:
            prepared.canary.receipt.receipt_id,
          monitor_contract_hash:
            releasedData.release.monitor_contract_hash,
          replayed_case_ids: monitor.replayed_case_ids,
          passed: false,
          failure_codes: monitor.failure_codes,
          rollback_required: true,
        }),
      );
      const monitorCommand = {
        kind: "monitor" as const,
        idempotency_key: "learning-monitor-mcp-public-001",
        principal_id: "user_local",
        scopes: RELEASE_SCOPES,
        monitor,
        receipt: monitorReceipt,
      };
      await storage.writeLearningLedger({
        ...monitorCommand,
        request_hash: canonicalSha256Omitting(monitorCommand, [
          "request_hash",
        ]),
      });

      const internalRollback = rollbackRequest({
        suffix: "mcp-public",
        released: releasedData,
        monitorReceiptId: "receipt_monitor_mcp_public",
      });
      const publicRollback = {
        envelope: {
          schema_version: "1.0.0",
          request_id: "request_mcp_public_rollback",
          tool: "learning_rollback",
          actor_claim: {
            principal_id: "user_local",
            authority: "user_stated",
          },
          scopes: RELEASE_SCOPES,
          purpose: "restore the exact safe release pointer",
          reason: internalRollback.reason,
          requested_at: internalRollback.activated_at,
          safety_class: "important_mutation",
          idempotency_key: internalRollback.idempotency_key,
          expected_revision_id: null,
          approval_id: internalRollback.approval_id,
          dry_run: false,
        },
        release_id: releasedData.release.release_id,
        restore_release_id: null,
        monitor_receipt_id: "receipt_monitor_mcp_public",
        expected_pointer_revision:
          releasedData.pointer.pointer_revision,
        expected_control_epoch: 0,
        base_configuration_hash:
          internalRollback.base_configuration_hash,
        effect_manifest_hash: releaseEffectManifest({
          request: internalRollback,
          candidate: prepared.candidate,
          baseReleaseId: releasedData.release.release_id,
          resultingConfigurationHash:
            internalRollback.base_configuration_hash,
        }),
      } as const;
      authorizeRollback({
        request: internalRollback,
        prepared,
        released: releasedData,
        approvals,
        requestHash: canonicalSha256(publicRollback),
      });
      expect(await memory.learningRollback(publicRollback)).toMatchObject({
        status: "OK",
        data: {
          release: { action: "rollback" },
          pointer: {
            active_release_id: null,
            pointer_revision: 2,
          },
        },
      });
    } finally {
      await storage.close();
    }
  });
});

import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";

import {
  GovernedResponseSchema,
  MemoryFeedbackInputSchema,
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
  createMemoryMcpServer,
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
import {
  verifiedLearningApproval,
} from "../helpers/learning-examples.js";

const WORKSPACE_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
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

async function actionFrontier(memory: MemoryRuntime) {
  return (await memory.learningInspection()).action_frontier;
}

async function connectInMemory(
  memory: MemoryRuntime,
  storage: SqliteStorageClient,
) {
  const server = createMemoryMcpServer({ runtime: memory, storage });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({
    name: "learning-controls-in-memory-client",
    version: "0.1.0",
  });
  await client.connect(clientTransport);
  return { client, server };
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
      runtime_identity_hash: `sha256:${"1".repeat(64)}`,
      configuration_hash: `sha256:${"2".repeat(64)}`,
      corpus_hash: `sha256:${"3".repeat(64)}`,
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
    expect(
      MemoryFeedbackInputSchema.safeParse({
        envelope: proposalEnvelope("bounded"),
        feedback: {
          task_id: "task_feedback_bounded",
          context_slice_id: "context_feedback_bounded",
          outcome: "failed",
          evidence_ids: Array.from(
            { length: 101 },
            (_value, index) => `evidence_${index}`,
          ),
          error_codes: [],
          gap_codes: [],
          observed_at: NOW,
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
        expect.objectContaining({
          kind: "learning_stop",
          feedback: expect.objectContaining({
            task_id: "task_feedback_1",
            context_slice_id: "context_feedback_1",
            outcome: "failed",
            evidence_ids: ["evidence_feedback_secret_marker"],
            error_codes: ["NO_RELEVANT_MEMORY"],
            gap_codes: ["RETRIEVAL_POLICY_TOO_BROAD"],
          }),
        }),
      ]);

      const pauseEnvelope = mutationEnvelope("learning_pause", "pause");
      const pauseFrontier = await actionFrontier(memory);
      const pauseRequest = {
        envelope: pauseEnvelope,
        expected_control_epoch: pauseFrontier.expected_control_epoch,
        expected_frontier_hash:
          pauseFrontier.expected_frontier_hash,
        runtime_identity_hash:
          pauseFrontier.runtime_identity_hash,
        configuration_hash:
          pauseFrontier.configuration_hash,
        corpus_hash: pauseFrontier.corpus_hash,
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
      const pausedAfterRelease = await memory.learningPause(pauseRequest);
      expect(
        pausedAfterRelease,
        canonicalJson(pausedAfterRelease),
      ).toMatchObject({
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
      expect(inspection.action_frontier).toMatchObject({
        expected_control_epoch: 1,
        runtime_identity_hash: expect.stringMatching(
          /^sha256:[a-f0-9]{64}$/,
        ),
        configuration_hash: expect.stringMatching(
          /^sha256:[a-f0-9]{64}$/,
        ),
        corpus_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        learning_state_hash: expect.stringMatching(
          /^sha256:[a-f0-9]{64}$/,
        ),
      });
      expect(inspection.candidates).toEqual([]);
      expect(inspection.pointers).toEqual([]);
      expect(canonicalJson(inspection)).not.toContain(
        "PRIVATE_MARKER_MUST_NOT_APPEAR_IN_LEARNING_INSPECTION",
      );

      const resumeEnvelope = mutationEnvelope("learning_resume", "resume");
      const resumeFrontier = await actionFrontier(memory);
      const resumeRequest = {
        envelope: resumeEnvelope,
        expected_control_epoch: resumeFrontier.expected_control_epoch,
        expected_frontier_hash:
          resumeFrontier.expected_frontier_hash,
        runtime_identity_hash:
          resumeFrontier.runtime_identity_hash,
        configuration_hash:
          resumeFrontier.configuration_hash,
        corpus_hash: resumeFrontier.corpus_hash,
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

  it("round-trips feedback after restart and rejects foreign exact-scope evidence", async () => {
    const dataRoot = temporaryRoot("mcp-learning-feedback-restart");
    let storage = await SqliteStorageClient.open({ dataRoot });
    const evidence = inlineEpisode({
      evidenceId: "evidence_feedback_roundtrip",
      text: "RAW_FEEDBACK_SOURCE_MUST_STAY_OUT_OF_THE_LEARNING_RECEIPT",
    });
    await storage.commitEpisode({
      idempotencyKey: evidence.idempotencyKey,
      episode: evidence.episode,
      evidence: evidence.evidence,
      blobs: [],
    });
    const approvals = new TestApprovalRegistry();
    const memory = runtime(storage, approvals);
    const request = {
      envelope: proposalEnvelope("roundtrip"),
      feedback: {
        task_id: "task_feedback_roundtrip",
        context_slice_id: "context_feedback_roundtrip",
        outcome: "partial",
        evidence_ids: ["evidence_feedback_roundtrip"],
        error_codes: ["TASK_UNIT_INCOMPLETE"],
        gap_codes: ["MISSING_RELATION"],
        observed_at: NOW,
      },
    } as const;
    const recorded = await memory.memoryFeedback(request);
    expect(recorded).toMatchObject({ status: "OK" });
    const receiptId = recorded.receipt_id;
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    try {
      if (receiptId === null) {
        throw new Error("feedback receipt is required");
      }
      const receipt = await storage.getReceipt({
        receipt_id: receiptId,
        principal_id: "user_local",
        scopes: [WORKSPACE_SCOPE],
      });
      expect(receipt).toMatchObject({
        kind: "learning_stop",
        feedback: {
          task_id: "task_feedback_roundtrip",
          context_slice_id: "context_feedback_roundtrip",
          outcome: "partial",
          evidence_ids: ["evidence_feedback_roundtrip"],
          error_codes: ["TASK_UNIT_INCOMPLETE"],
          gap_codes: ["MISSING_RELATION"],
        },
      });
      expect(canonicalJson(receipt)).not.toContain(
        "RAW_FEEDBACK_SOURCE_MUST_STAY_OUT_OF_THE_LEARNING_RECEIPT",
      );

      const foreign = inlineEpisode({
        episodeId: "episode_feedback_foreign",
        evidenceId: "evidence_feedback_foreign",
        idempotencyKey: "commit:episode_feedback_foreign:0001",
        scopeId: "workspace_foreign",
      });
      await storage.commitEpisode({
        idempotencyKey: foreign.idempotencyKey,
        episode: foreign.episode,
        evidence: foreign.evidence,
        blobs: [],
      });
      const foreignRuntime = new MemoryRuntime({
        storage,
        approvalRegistry: approvals,
        clock: () => NOW,
        policy: {
          principal: {
            principal_id: "user_local",
            allowed_scopes: [
              WORKSPACE_SCOPE,
              { kind: "workspace", id: "workspace_foreign" },
            ],
            allowed_authorities: ["user_stated"],
            destructive_tools_enabled: false,
          },
        },
      });
      const before = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [WORKSPACE_SCOPE],
      });
      expect(
        await foreignRuntime.memoryFeedback({
          envelope: proposalEnvelope("foreign"),
          feedback: {
            ...request.feedback,
            evidence_ids: ["evidence_feedback_foreign"],
          },
        }),
      ).toMatchObject({
        status: "FAILED",
        error: { code: "PERMISSION_DENIED" },
      });
      const after = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [WORKSPACE_SCOPE],
      });
      expect(after.receipts).toEqual(before.receipts);
    } finally {
      await storage.close();
    }
  });

  it("requires the complete configured scope set for principal-wide controls", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("mcp-learning-control-complete-scope"),
    });
    try {
      const approvals = new TestApprovalRegistry();
      const memory = new MemoryRuntime({
        storage,
        approvalRegistry: approvals,
        clock: () => NOW,
        policy: {
          principal: {
            principal_id: "user_local",
            allowed_scopes: RELEASE_SCOPES,
            allowed_authorities: ["user_stated"],
            destructive_tools_enabled: false,
          },
        },
      });
      const frontier = await actionFrontier(memory);
      const subset = {
        envelope: mutationEnvelope(
          "learning_pause",
          "subset_scope",
        ),
        expected_control_epoch: frontier.expected_control_epoch,
        expected_frontier_hash: frontier.expected_frontier_hash,
        runtime_identity_hash: frontier.runtime_identity_hash,
        configuration_hash: frontier.configuration_hash,
        corpus_hash: frontier.corpus_hash,
      } as const;
      approvals.approve(subset);
      expect(await memory.learningPause(subset)).toMatchObject({
        status: "FAILED",
        error: { code: "PERMISSION_DENIED" },
      });
      expect(
        (await memory.learningInspection()).control,
      ).toBeNull();
    } finally {
      await storage.close();
    }
  });

  it("exposes all governed learning calls and failures through MCP semantics", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("mcp-learning-in-memory-transport"),
    });
    const approvals = new TestApprovalRegistry();
    const memory = runtime(storage, approvals);
    const { client, server } = await connectInMemory(memory, storage);
    try {
      const resource = await client.readResource({
        uri: "memory://runtime/learning",
      });
      const first = resource.contents[0];
      if (first === undefined || !("text" in first)) {
        throw new Error("learning resource must contain JSON text");
      }
      const inspection = JSON.parse(first.text) as Awaited<
        ReturnType<MemoryRuntime["learningInspection"]>
      >;
      const feedback = await client.callTool({
        name: "memory_feedback",
        arguments: {
          envelope: proposalEnvelope("transport"),
          feedback: {
            task_id: "task_feedback_transport",
            context_slice_id: "context_feedback_transport",
            outcome: "failed",
            evidence_ids: [],
            error_codes: ["NO_RELEVANT_MEMORY"],
            gap_codes: [],
            observed_at: NOW,
          },
        },
      });
      expect(feedback.isError).not.toBe(true);
      expect(
        GovernedResponseSchema.parse(feedback.structuredContent),
      ).toMatchObject({ status: "OK" });

      const pauseRequest = {
        envelope: mutationEnvelope("learning_pause", "transport_pause"),
        expected_control_epoch:
          inspection.action_frontier.expected_control_epoch,
        expected_frontier_hash:
          inspection.action_frontier.expected_frontier_hash,
        runtime_identity_hash:
          inspection.action_frontier.runtime_identity_hash,
        configuration_hash:
          inspection.action_frontier.configuration_hash,
        corpus_hash: inspection.action_frontier.corpus_hash,
      } as const;
      approvals.approve(pauseRequest);
      const paused = await client.callTool({
        name: "learning_pause",
        arguments: pauseRequest,
      });
      expect(paused.isError).not.toBe(true);
      expect(
        GovernedResponseSchema.parse(paused.structuredContent),
      ).toMatchObject({ status: "OK" });

      const pausedInspection = await memory.learningInspection();
      const resumeRequest = {
        envelope: mutationEnvelope(
          "learning_resume",
          "transport_resume",
        ),
        expected_control_epoch:
          pausedInspection.action_frontier.expected_control_epoch,
        expected_frontier_hash:
          pausedInspection.action_frontier.expected_frontier_hash,
        runtime_identity_hash:
          pausedInspection.action_frontier.runtime_identity_hash,
        configuration_hash:
          pausedInspection.action_frontier.configuration_hash,
        corpus_hash:
          pausedInspection.action_frontier.corpus_hash,
        abandon_in_flight: false,
      } as const;
      approvals.approve(resumeRequest);
      const resumed = await client.callTool({
        name: "learning_resume",
        arguments: resumeRequest,
      });
      expect(resumed.isError).not.toBe(true);
      expect(
        GovernedResponseSchema.parse(resumed.structuredContent),
      ).toMatchObject({ status: "OK" });

      const active = await memory.learningInspection();
      const missingRelease = await client.callTool({
        name: "learning_release",
        arguments: {
          envelope: {
            ...mutationEnvelope(
              "learning_pause",
              "transport_release",
            ),
            tool: "learning_release",
          },
          candidate_id: "candidate_missing_transport",
          release_slot_hash: canonicalSha256("missing-slot"),
          evaluation_receipt_id: "evaluation_missing_transport",
          canary_receipt_id: "canary_missing_transport",
          expected_pointer_revision: 0,
          expected_control_epoch:
            active.action_frontier.expected_control_epoch,
          base_configuration_hash:
            active.action_frontier.configuration_hash,
          monitor_contract_hash: canonicalSha256("missing-monitor"),
          effect_manifest_hash: canonicalSha256("missing-effect"),
        },
      });
      expect(missingRelease.isError).toBe(true);
      expect(
        GovernedResponseSchema.parse(
          missingRelease.structuredContent,
        ),
      ).toMatchObject({ status: "FAILED" });

      const missingRollback = await client.callTool({
        name: "learning_rollback",
        arguments: {
          envelope: {
            ...mutationEnvelope(
              "learning_pause",
              "transport_rollback",
            ),
            tool: "learning_rollback",
          },
          release_id: "release_missing_transport",
          restore_release_id: null,
          monitor_receipt_id: "monitor_missing_transport",
          expected_pointer_revision: 0,
          expected_control_epoch:
            active.action_frontier.expected_control_epoch,
          base_configuration_hash:
            active.action_frontier.configuration_hash,
          effect_manifest_hash: canonicalSha256("missing-effect"),
        },
      });
      expect(missingRollback.isError).toBe(true);
      expect(
        GovernedResponseSchema.parse(
          missingRollback.structuredContent,
        ),
      ).toMatchObject({ status: "FAILED" });
    } finally {
      await client.close();
      await server.close();
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
      const pauseFrontier = await actionFrontier(memory);
      const pauseRequest = {
        envelope: {
          schema_version: "1.0.0",
          request_id: "request_pause_after_public_release",
          tool: "learning_pause",
          actor_claim: {
            principal_id: "user_local",
            authority: "user_stated",
          },
          scopes: RELEASE_SCOPES,
          purpose: "freeze learning after a published regression",
          reason: "retain the release and permit exact safety rollback",
          requested_at: RELEASE_CLOCK,
          safety_class: "important_mutation",
          idempotency_key: "learning-pause-after-public-release-001",
          expected_revision_id: null,
          approval_id: "approval_learning_pause_storage_1",
          dry_run: false,
        },
        expected_control_epoch:
          pauseFrontier.expected_control_epoch,
        expected_release_revision:
          pauseFrontier.expected_release_revision,
        expected_frontier_hash:
          pauseFrontier.expected_frontier_hash,
        runtime_identity_hash:
          pauseFrontier.runtime_identity_hash,
        configuration_hash:
          pauseFrontier.configuration_hash,
        corpus_hash: pauseFrontier.corpus_hash,
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
      const pauseApproval = verifiedLearningApproval({
        tool: "learning_pause",
        requestHash: canonicalSha256(pauseRequest),
      });
      approvals.grants.set(
        pauseApproval.approval.grant.approval_id,
        pauseApproval.approval.grant,
      );
      const pausedAfterPublicRelease =
        await memory.learningPause(pauseRequest);
      expect(
        pausedAfterPublicRelease,
        canonicalJson(pausedAfterPublicRelease),
      ).toMatchObject({
        status: "OK",
        data: {
          control: {
            status: "paused",
            control_epoch: 1,
            reason_code: "RELEASE_COMPLETED_BEFORE_PAUSE",
          },
        },
      });
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
        expected_control_epoch: 1,
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
        controlEpoch: 1,
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

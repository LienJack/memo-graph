import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryRuntime,
  RecallOrchestrator,
} from "../../packages/memory-kernel/src/index.js";
import {
  MonitorReceiptSchema,
  MonitorResultSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import {
  LearningReleaseError,
  LearningReleaseManager,
  narrowLearnedLanePolicy,
} from "../../packages/learning-lab/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  authorizeRelease,
  authorizeRollback,
  BASE_LANE_POLICY,
  preparePassedCanary,
  releaseRequest,
  rollbackRequest,
  RELEASE_SCOPES,
  TestReleaseApprovalRegistry,
} from "../helpers/g5-release.js";
import {
  seedLayeredProjectionSources,
} from "../helpers/projection-examples.js";
import {
  EMPTY_LEARNING_FRONTIER_HASH,
  learningCandidate,
  learningControl,
  learningControlReceipt,
  verifiedLearningApproval,
} from "../helpers/learning-examples.js";

const cleanupPaths: string[] = [];
const NOW = "2026-07-28T12:12:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
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
      scopes: [...RELEASE_SCOPES].reverse(),
      purpose: "verify governed learned retrieval policy",
      reason: "seal the exact active release into frozen Context",
      requested_at: NOW,
      safety_class: "read_only",
    },
    recall: {
      schema_version: "1.0.0",
      request_id: requestId,
      goal: "restore governed agent memory",
      query: "agent memory",
      scopes: [...RELEASE_SCOPES].reverse(),
      as_of: NOW,
      token_budget: 1_800,
      include_sensitive: false,
      lane_overrides: {
        requested_lanes: [...BASE_LANE_POLICY.allowed_lanes],
        limits: {
          max_candidates_per_lane: 20,
          relation_max_depth: 2,
          relation_max_fanout: 5,
          max_concurrent_lanes: 2,
        },
      },
    },
  } as const;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("governed learning release", () => {
  it("publishes once, replays exactly, and moves one immutable pointer", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-release"),
    });
    try {
      const prepared = await preparePassedCanary({
        storage,
        suffix: "publish",
      });
      const request = releaseRequest({ suffix: "publish" });
      const approvals = new TestReleaseApprovalRegistry();
      authorizeRelease({ request, prepared, approvals });
      const manager = new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      });

      const released = await manager.apply(request);
      expect(released).toMatchObject({
        replayed: false,
        release: {
          action: "release",
          candidate_id: prepared.candidate.candidate_id,
          previous_release_id: null,
        },
        pointer: {
          pointer_revision: 1,
        },
        transition: {
          from_state: "canary",
          to_state: "released",
        },
        receipt: {
          kind: "release",
          resulting_pointer_revision: 1,
        },
      });
      expect((await manager.apply(request)).replayed).toBe(true);

      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [...RELEASE_SCOPES].reverse(),
        release_slot_hash:
          prepared.candidate.release_slot?.slot_hash,
      });
      expect(ledger.releases).toHaveLength(1);
      expect(ledger.pointers).toEqual([
        expect.objectContaining({
          active_release_id: released.release.release_id,
          pointer_revision: 1,
        }),
      ]);
      expect(ledger.candidate_states[0]?.state).toBe("released");
      expect(prepared.authority.verifyPostCanaryCalls).toBe(1);
      expect(prepared.authority.confirmPostCanaryCalls).toBe(1);
      expect(approvals.verifyCalls).toBe(1);
      expect(approvals.confirmCalls).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it("restores the exact named prior release and its configuration", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-release-named-prior"),
    });
    try {
      const approvals = new TestReleaseApprovalRegistry();
      const firstPrepared = await preparePassedCanary({
        storage,
        suffix: "named-prior-first",
      });
      const firstRequest = releaseRequest({
        suffix: "named-prior-first",
      });
      authorizeRelease({
        request: firstRequest,
        prepared: firstPrepared,
        approvals,
      });
      const first = await new LearningReleaseManager({
        storage,
        authorityRegistry: firstPrepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      }).apply(firstRequest);

      const secondCandidate = learningCandidate({
        candidate_id: "candidate_storage_named_prior_2",
        target: {
          kind: "retrieval_policy",
          requested_lanes: ["recent_l1"],
          limits: { max_candidates_per_lane: 5 },
        },
        base_release_ids: [first.release.release_id],
        active_base_release_id: first.release.release_id,
        trace_ids: ["trace_storage_named_prior_2"],
        rollback_target_release_id: first.release.release_id,
      });
      const secondPrepared = await preparePassedCanary({
        storage,
        suffix: "named-prior-second",
        candidate: secondCandidate,
      });
      const secondRequest = releaseRequest({
        suffix: "named-prior-second",
        candidateId: secondCandidate.candidate_id,
      });
      authorizeRelease({
        request: secondRequest,
        prepared: secondPrepared,
        approvals,
        baseReleaseId: first.release.release_id,
        expectedPointerRevision: first.pointer.pointer_revision,
      });
      const second = await new LearningReleaseManager({
        storage,
        authorityRegistry: secondPrepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:30.000Z",
      }).apply(secondRequest);
      expect(second).toMatchObject({
        release: {
          previous_release_id: first.release.release_id,
        },
        pointer: {
          active_release_id: second.release.release_id,
          pointer_revision: 2,
        },
      });

      const rollback = rollbackRequest({
        suffix: "named-prior-second",
        released: second,
        targetReleaseId: first.release.release_id,
      });
      authorizeRollback({
        request: rollback,
        prepared: secondPrepared,
        released: second,
        targetRelease: first,
        approvals,
      });
      const restored = await new LearningReleaseManager({
        storage,
        authorityRegistry: secondPrepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:06:00.000Z",
      }).apply(rollback);
      expect(restored).toMatchObject({
        release: {
          action: "rollback",
          previous_release_id: second.release.release_id,
          restored_release_id: first.release.release_id,
          configuration_hash: first.release.configuration_hash,
        },
        pointer: {
          active_release_id: first.release.release_id,
          pointer_revision: 3,
        },
        receipt: {
          restored_release_id: first.release.release_id,
          restored_configuration_hash:
            first.release.configuration_hash,
        },
      });

      const resolved = await new RecallOrchestrator({
        storage,
      }).resolveEffectiveConfiguration({
        principal_id: firstRequest.principal_id,
        scopes: [...firstRequest.scopes].reverse(),
        lane_policy: BASE_LANE_POLICY,
      });
      expect(resolved).toMatchObject({
        active_learning_release_id: first.release.release_id,
        active_learning_release_hash: first.release.release_hash,
        enabled_lanes: ["recent_l1"],
        limits: { max_candidates_per_lane: 10 },
        policy_hash: first.release.configuration_hash,
      });
    } finally {
      await storage.close();
    }
  });

  it("uses exact canonical scope sets and seals active policy identity into new Context only", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-release-runtime"),
    });
    try {
      await seedLayeredProjectionSources(storage);
      const runtime = () =>
        new MemoryRuntime({
          storage,
          clock: () => NOW,
          policy: {
            principal: {
              principal_id: "user_local",
              allowed_scopes: [...RELEASE_SCOPES],
              allowed_authorities: ["user_stated"],
              destructive_tools_enabled: false,
            },
            default_token_budget: 1_800,
            lane_policy: BASE_LANE_POLICY,
          },
        });
      const baseline = await runtime().memoryContextCompile(
        compileRequest("request_learning_release_baseline"),
      );
      if (baseline.status !== "OK" && baseline.status !== "DEGRADED") {
        throw new Error(JSON.stringify(baseline));
      }
      const baselineData = baseline.data as {
        context_slice: {
          frozen_hash: string;
          effective_lane_configuration: {
            active_learning_release_id?: string;
            enabled_lanes: string[];
          };
        };
      };
      expect(
        baselineData.context_slice.effective_lane_configuration
          .active_learning_release_id,
      ).toBeUndefined();

      const prepared = await preparePassedCanary({
        storage,
        suffix: "runtime",
      });
      const request = releaseRequest({ suffix: "runtime" });
      const approvals = new TestReleaseApprovalRegistry();
      authorizeRelease({ request, prepared, approvals });
      const released = await new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      }).apply(request);

      const orchestrator = new RecallOrchestrator({ storage });
      const resolved =
        await orchestrator.resolveEffectiveConfiguration({
          principal_id: "user_local",
          scopes: [...RELEASE_SCOPES].reverse(),
          lane_policy: BASE_LANE_POLICY,
          lane_overrides:
            compileRequest("request_learning_release_probe").recall
              .lane_overrides,
        });
      expect(resolved).toMatchObject({
        active_learning_release_id: released.release.release_id,
        active_learning_release_hash: released.release.release_hash,
        enabled_lanes: ["recent_l1"],
      });
      await orchestrator.recall({
        principal_id: "user_local",
        scope: RELEASE_SCOPES[1],
        query: "agent memory",
        as_of: NOW,
        include_sensitive: false,
        lane_policy: BASE_LANE_POLICY,
        lane_overrides: {
          requested_lanes: [
            ...compileRequest("request_learning_release_probe").recall
              .lane_overrides.requested_lanes,
          ],
          limits: {
            ...compileRequest("request_learning_release_probe").recall
              .lane_overrides.limits,
          },
        },
        resolved_effective_configuration: resolved,
      });
      for (const scopes of [
        [RELEASE_SCOPES[1]],
        [
          ...RELEASE_SCOPES,
          { kind: "topic" as const, id: "topic_foreign" },
        ],
        [
          { kind: "user" as const, id: "foreign_user" },
          RELEASE_SCOPES[1],
        ],
      ]) {
        const isolated =
          await orchestrator.resolveEffectiveConfiguration({
            principal_id: "user_local",
            scopes,
            lane_policy: BASE_LANE_POLICY,
          });
        expect(isolated).not.toHaveProperty(
          "active_learning_release_id",
        );
      }

      const active = await runtime().memoryContextCompile(
        compileRequest("request_learning_release_active"),
      );
      if (active.status !== "OK" && active.status !== "DEGRADED") {
        throw new Error(JSON.stringify(active));
      }
      const activeData = active.data as {
        context_slice: {
          frozen_hash: string;
          effective_lane_configuration: {
            active_learning_release_id: string;
            active_learning_release_hash: string;
            enabled_lanes: string[];
            limits: { max_candidates_per_lane: number };
          };
        };
        receipt: {
          active_learning_release_id: string;
          active_learning_release_hash: string;
        };
      };
      expect(
        activeData.context_slice.effective_lane_configuration,
      ).toMatchObject({
        active_learning_release_id: released.release.release_id,
        active_learning_release_hash: released.release.release_hash,
        enabled_lanes: ["recent_l1"],
        limits: { max_candidates_per_lane: 10 },
      });
      expect(activeData.receipt).toMatchObject({
        active_learning_release_id: released.release.release_id,
        active_learning_release_hash: released.release.release_hash,
      });

      const replay = await runtime().memoryContextCompile(
        compileRequest("request_learning_release_baseline"),
      );
      if (replay.status !== "OK" && replay.status !== "DEGRADED") {
        throw new Error("frozen Context replay must be materialized");
      }
      expect(replay.data).toMatchObject({
        replayed: true,
        context_slice: {
          frozen_hash: baselineData.context_slice.frozen_hash,
        },
      });
      expect(
        (
          replay.data as {
            context_slice: {
              effective_lane_configuration: object;
            };
          }
        ).context_slice.effective_lane_configuration,
      ).not.toHaveProperty("active_learning_release_id");

      const subsetLedger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [RELEASE_SCOPES[1]],
        release_slot_hash:
          prepared.candidate.release_slot?.slot_hash,
      });
      expect(subsetLedger.pointers).toEqual([]);

      const rollback = rollbackRequest({
        suffix: "runtime",
        released,
      });
      authorizeRollback({
        request: rollback,
        prepared,
        released,
        approvals,
      });
      const rolledBack = await new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:06:00.000Z",
      }).apply(rollback);
      expect(rolledBack).toMatchObject({
        release: {
          action: "rollback",
          previous_release_id: released.release.release_id,
          restored_release_id: null,
          configuration_hash: rollback.base_configuration_hash,
        },
        pointer: {
          active_release_id: null,
          pointer_revision: 2,
        },
        transition: {
          from_state: "released",
          to_state: "rolled_back",
        },
        receipt: {
          kind: "rollback",
          rolled_back_release_id: released.release.release_id,
          restored_release_id: null,
        },
      });
      const restored = await runtime().memoryContextCompile(
        compileRequest("request_learning_release_restored"),
      );
      if (
        restored.status !== "OK" &&
        restored.status !== "DEGRADED"
      ) {
        throw new Error("rollback must restore base Context behavior");
      }
      const restoredConfig = (
        restored.data as {
          context_slice: {
            effective_lane_configuration: object;
          };
        }
      ).context_slice.effective_lane_configuration;
      expect(restoredConfig).not.toHaveProperty(
        "active_learning_release_id",
      );
      expect(restoredConfig).toMatchObject({
        enabled_lanes: BASE_LANE_POLICY.allowed_lanes,
        policy_hash: rollback.base_configuration_hash,
      });
      expect(
        (
          await new LearningReleaseManager({
            storage,
            authorityRegistry: prepared.authority,
            approvalRegistry: approvals,
            clock: () => "2026-07-28T12:06:00.000Z",
          }).apply(rollback)
        ).replayed,
      ).toBe(true);
    } finally {
      await storage.close();
    }
  });

  it("rejects learned lane or limit widening and graph/vector activation", () => {
    expect(() =>
      narrowLearnedLanePolicy(
        {
          allowed_lanes: ["recent_l1"],
          limits: {
            max_candidates_per_lane: 10,
            relation_max_depth: 0,
            relation_max_fanout: 1,
            max_concurrent_lanes: 1,
          },
        },
        {
          kind: "retrieval_policy",
          requested_lanes: ["recent_l1", "core"],
          limits: {},
        },
      ),
    ).toThrowError(LearningReleaseError);
    expect(() =>
      narrowLearnedLanePolicy(BASE_LANE_POLICY, {
        kind: "retrieval_policy",
        requested_lanes: ["recent_l1"],
        limits: { max_candidates_per_lane: 21 },
      }),
    ).toThrowError(LearningReleaseError);
    for (const lane of ["relation_graph", "semantic_vector"] as const) {
      expect(() =>
        narrowLearnedLanePolicy(BASE_LANE_POLICY, {
          kind: "retrieval_policy",
          requested_lanes: [lane],
          limits: {},
        }),
      ).toThrowError();
    }
  });

  it("serializes pause-first publication without moving or consuming the release", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-release-pause-first"),
    });
    try {
      const prepared = await preparePassedCanary({
        storage,
        suffix: "pause-first",
      });
      const request = releaseRequest({ suffix: "pause-first" });
      const approvals = new TestReleaseApprovalRegistry();
      authorizeRelease({ request, prepared, approvals });
      const controlReceipt = learningControlReceipt();
      const controlAuthority = verifiedLearningApproval({
        tool: "learning_pause",
        requestHash: controlReceipt.request_hash,
      });
      await storage.writeLearningLedger({
        kind: "control",
        idempotency_key: "learning-pause-before-release-001",
        request_hash: controlReceipt.request_hash,
        expected_control_epoch: 0,
        expected_frontier_hash:
          controlReceipt.previous_frontier_hash,
        control: learningControl(),
        receipt: controlReceipt,
        approval_binding: controlAuthority.binding,
        approval: controlAuthority.approval,
      });

      await expect(
        new LearningReleaseManager({
          storage,
          authorityRegistry: prepared.authority,
          approvalRegistry: approvals,
          clock: () => "2026-07-28T12:05:00.000Z",
        }).apply(request),
      ).rejects.toMatchObject({ code: "LEARNING_PAUSED" });
      const ledger = await storage.readLearningLedger({
        principal_id: request.principal_id,
        scopes: request.scopes,
        candidate_id: request.candidate_id,
      });
      expect(ledger.controls[0]?.status).toBe("paused");
      expect(ledger.releases).toEqual([]);
      expect(ledger.pointers).toEqual([]);
      expect(ledger.candidate_states[0]?.state).toBe("canary");
      expect(prepared.authority.verifyPostCanaryCalls).toBe(0);
      expect(approvals.verifyCalls).toBe(0);
    } finally {
      await storage.close();
    }
  });

  it("permits an exactly authorized safety rollback while learning is paused", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-rollback-while-paused"),
    });
    try {
      const prepared = await preparePassedCanary({
        storage,
        suffix: "rollback-while-paused",
      });
      const release = releaseRequest({
        suffix: "rollback-while-paused",
      });
      const approvals = new TestReleaseApprovalRegistry();
      authorizeRelease({ request: release, prepared, approvals });
      const manager = new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      });
      const released = await manager.apply(release);
      const monitorInput = {
        schema_version: "1.0.0",
        monitor_id: "monitor_rollback_while_paused",
        release_id: released.release.release_id,
        pointer_revision: released.pointer.pointer_revision,
        canary_receipt_id: prepared.canary.receipt.receipt_id,
        replayed_case_ids: [
          "canary_rollback_paused_1",
          "canary_rollback_paused_2",
          "canary_rollback_paused_3",
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
          receipt_id: "receipt_monitor_rollback_while_paused",
          created_at: monitor.monitored_at,
          state: "durable",
          request_hash: canonicalSha256({
            monitor_id: monitor.monitor_id,
          }),
          kind: "learning_monitor",
          release_id: released.release.release_id,
          pointer_revision: released.pointer.pointer_revision,
          canary_receipt_id: prepared.canary.receipt.receipt_id,
          monitor_contract_hash:
            released.release.monitor_contract_hash,
          replayed_case_ids: monitor.replayed_case_ids,
          passed: false,
          failure_codes: monitor.failure_codes,
          rollback_required: true,
        }),
      );
      const monitorCommand = {
        kind: "monitor" as const,
        idempotency_key:
          "learning-monitor-rollback-while-paused-001",
        principal_id: release.principal_id,
        scopes: release.scopes,
        monitor,
        receipt: monitorReceipt,
      };
      await storage.writeLearningLedger({
        ...monitorCommand,
        request_hash: canonicalSha256Omitting(monitorCommand, [
          "request_hash",
        ]),
      });

      const liveFrontier =
        (await storage.health()).learning_frontier.frontier_hash;
      const pausedFrontier = canonicalSha256({
        candidate_id: prepared.candidate.candidate_id,
        release_id: released.release.release_id,
        pointer_hash: released.pointer.pointer_hash,
        monitor_hash: monitor.monitor_hash,
      });
      const pauseReceipt = learningControlReceipt("pause", {
        receipt_id: "receipt_pause_before_safety_rollback",
        previous_frontier_hash: liveFrontier,
        frontier_hash: pausedFrontier,
      });
      const pauseAuthority = verifiedLearningApproval({
        tool: "learning_pause",
        requestHash: pauseReceipt.request_hash,
      });
      await storage.writeLearningLedger({
        kind: "control",
        idempotency_key: "learning-pause-before-safety-rollback-001",
        request_hash: pauseReceipt.request_hash,
        expected_control_epoch: 0,
        expected_frontier_hash: liveFrontier,
        control: learningControl("paused", {
          frontier_hash: pausedFrontier,
        }),
        receipt: pauseReceipt,
        approval_binding: pauseAuthority.binding,
        approval: pauseAuthority.approval,
      });

      const rollback = rollbackRequest({
        suffix: "while-paused",
        released,
        monitorReceiptId: monitorReceipt.receipt_id,
      });
      authorizeRollback({
        request: rollback,
        prepared,
        released,
        approvals,
        controlEpoch: 1,
      });
      const rolledBack = await manager.apply(rollback);
      expect(rolledBack).toMatchObject({
        release: { action: "rollback" },
        pointer: {
          active_release_id: null,
          pointer_revision: 2,
        },
      });
    } finally {
      await storage.close();
    }
  });

  it("rejects a stale pause after publication and accepts an explicit retry from the live frontier", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-release-release-first"),
    });
    try {
      const prepared = await preparePassedCanary({
        storage,
        suffix: "release-first",
      });
      const request = releaseRequest({ suffix: "release-first" });
      const approvals = new TestReleaseApprovalRegistry();
      authorizeRelease({ request, prepared, approvals });
      await new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      }).apply(request);

      const staleFrontier = canonicalSha256({
        kind: "learning_control_frontier",
        attempt: "stale_pause_after_release",
      });
      const staleReceipt = learningControlReceipt("pause", {
        receipt_id: "receipt_control_pause_release_first_stale",
        frontier_hash: staleFrontier,
      });
      const staleAuthority = verifiedLearningApproval({
        tool: "learning_pause",
        requestHash: staleReceipt.request_hash,
      });
      await expect(
        storage.writeLearningLedger({
          kind: "control",
          idempotency_key: "learning-pause-release-first-stale-001",
          request_hash: staleReceipt.request_hash,
          expected_control_epoch: 0,
          expected_frontier_hash: EMPTY_LEARNING_FRONTIER_HASH,
          control: learningControl("paused", {
            frontier_hash: staleFrontier,
          }),
          receipt: staleReceipt,
          approval_binding: staleAuthority.binding,
          approval: staleAuthority.approval,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const liveFrontier = (await storage.health()).learning_frontier
        .frontier_hash;
      expect(liveFrontier).not.toBe(EMPTY_LEARNING_FRONTIER_HASH);
      const retryFrontier = canonicalSha256({
        kind: "learning_control_frontier",
        attempt: "explicit_pause_after_release",
        observed_frontier_hash: liveFrontier,
      });
      const retryReceipt = learningControlReceipt("pause", {
        receipt_id: "receipt_control_pause_release_first_retry",
        request_hash: canonicalSha256({
          kind: "learning_pause",
          observed_frontier_hash: liveFrontier,
        }),
        previous_frontier_hash: liveFrontier,
        frontier_hash: retryFrontier,
        reason_code: "RELEASE_COMPLETED_BEFORE_PAUSE",
      });
      const retryAuthority = verifiedLearningApproval({
        tool: "learning_pause",
        requestHash: retryReceipt.request_hash,
      });
      await storage.writeLearningLedger({
        kind: "control",
        idempotency_key: "learning-pause-release-first-retry-001",
        request_hash: retryReceipt.request_hash,
        expected_control_epoch: 0,
        expected_frontier_hash: liveFrontier,
        control: learningControl("paused", {
          frontier_hash: retryFrontier,
          reason_code: "RELEASE_COMPLETED_BEFORE_PAUSE",
        }),
        receipt: retryReceipt,
        approval_binding: retryAuthority.binding,
        approval: retryAuthority.approval,
      });

      const ledger = await storage.readLearningLedger({
        principal_id: request.principal_id,
        scopes: request.scopes,
        candidate_id: request.candidate_id,
      });
      expect(ledger.controls).toEqual([
        expect.objectContaining({
          status: "paused",
          reason_code: "RELEASE_COMPLETED_BEFORE_PAUSE",
          frontier_hash: retryFrontier,
        }),
      ]);
      expect(ledger.pointers[0]).toMatchObject({
        active_release_id: expect.any(String),
        pointer_revision: 1,
      });
    } finally {
      await storage.close();
    }
  });
});

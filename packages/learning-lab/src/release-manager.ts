import {
  ApprovalBindingSchema,
  CandidateTransitionSchema,
  CanonicalHashSchema,
  ContractVersionSchema,
  DEFAULT_LEARNED_RECALL_TARGET_KEY,
  IdentifierSchema,
  LanePolicySchema,
  LearningReleaseVersionSchema,
  PostCanaryApprovalSchema,
  ReleasePointerSchema,
  ReleaseReceiptSchema,
  RollbackReceiptSchema,
  ScopeSchema,
  UtcTimestampSchema,
  approvalGrantMatches,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  computeNarrowedLanePolicy,
  receiptHashIsValid,
  scopeKey,
  sealReceipt,
  type ApprovalBinding,
  type ApprovalGrant,
  type CandidateChange,
  type LanePolicy,
  type PostCanaryApproval,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  reduceCandidateState,
  type ReducedCandidateState,
} from "./lifecycle.js";
import type { LearningLabStorage } from "./storage-port.js";

const ReleaseFailurePointSchema = z.enum([
  "after_guard",
  "after_canonical_effect",
  "after_release",
  "after_pointer",
  "after_transition",
  "after_receipt",
  "after_approval",
  "after_idempotency",
]);

export const LearningReleaseInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    action: z.enum(["release", "rollback"]),
    idempotency_key: z.string().trim().min(8).max(200),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    candidate_id: IdentifierSchema,
    approval_id: IdentifierSchema,
    target_release_id: IdentifierSchema.nullable(),
    operator_lane_policy: LanePolicySchema.nullable().default(null),
    base_configuration_hash: CanonicalHashSchema,
    monitor_contract_hash: CanonicalHashSchema,
    monitor_receipt_id: IdentifierSchema.nullable(),
    reason: z.string().trim().min(1).max(2_000),
    activated_at: UtcTimestampSchema,
    test_failure_point: ReleaseFailurePointSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.scopes.map(scopeKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "learning release scopes must be unique",
      });
    }
    if (value.action === "release" && value.target_release_id !== null) {
      context.addIssue({
        code: "custom",
        path: ["target_release_id"],
        message: "release requests cannot name a rollback target",
      });
    }
  });

export const LearningReleaseResultSchema = z
  .object({
    request: LearningReleaseInputSchema,
    release: LearningReleaseVersionSchema,
    pointer: ReleasePointerSchema,
    transition: CandidateTransitionSchema,
    receipt: z.union([ReleaseReceiptSchema, RollbackReceiptSchema]),
    replayed: z.boolean(),
  })
  .strict();

export type LearningReleaseInput = z.input<
  typeof LearningReleaseInputSchema
>;
export type LearningReleaseResult = z.output<
  typeof LearningReleaseResultSchema
>;
type CanonicalHash = z.output<typeof CanonicalHashSchema>;

export type LearningReleaseExecutionOptions = {
  requestHash?: `sha256:${string}`;
  expected?: {
    release_slot_hash: CanonicalHash;
    evaluation_receipt_id: string;
    canary_receipt_id: string;
    pointer_revision: number;
    control_epoch: number;
    effect_manifest_hash: CanonicalHash;
    current_release_id?: string;
  };
};

type VerifiedPostCanaryAuthority = {
  approval: PostCanaryApproval;
  registry_hash: `sha256:${string}`;
  verified_at: string;
};

type VerifiedReleaseApproval = {
  grant: ApprovalGrant;
  registry_hash: `sha256:${string}`;
};

export interface ReleaseAuthorityRegistry {
  verifyPostCanaryApproval(
    approvalId: string,
  ): Promise<VerifiedPostCanaryAuthority>;
  confirmPostCanaryApprovalUnchanged(
    verified: VerifiedPostCanaryAuthority,
  ): Promise<void>;
}

export interface ReleaseApprovalRegistry {
  verify(binding: ApprovalBinding): Promise<VerifiedReleaseApproval>;
  confirmUnchanged(verified: VerifiedReleaseApproval): Promise<void>;
}

export class LearningReleaseError extends Error {
  readonly code:
    | "RELEASE_REPLAY_INCOMPLETE"
    | "CANDIDATE_INACCESSIBLE"
    | "CANDIDATE_NOT_CANARY"
    | "ROLLBACK_NOT_RELEASED"
    | "RELEASE_INELIGIBLE"
    | "LEARNING_PAUSED"
    | "CONTROL_FRONTIER_STALE"
    | "APPROVAL_INVALID"
    | "POINTER_CONFLICT"
    | "CONFIGURATION_WIDENING"
    | "ROLLBACK_TARGET_INVALID"
    | "MONITOR_INACCESSIBLE";

  constructor(code: LearningReleaseError["code"]) {
    super(code);
    this.name = "LearningReleaseError";
    this.code = code;
  }
}

function stableIdentifier(prefix: string, input: unknown): string {
  return `${prefix}:${canonicalSha256(input).slice("sha256:".length, 48)}`;
}

export function narrowLearnedLanePolicy(
  policyInput: unknown,
  learnedInput: unknown,
): LanePolicy {
  try {
    return computeNarrowedLanePolicy(policyInput, learnedInput);
  } catch {
    throw new LearningReleaseError("CONFIGURATION_WIDENING");
  }
}

export function learningReleaseEffectManifestHash(options: {
  schema_version: string;
  action: "release" | "rollback";
  candidate: CandidateChange;
  base_release_id: string | null;
  target_release_id: string | null;
  base_configuration_hash: CanonicalHash;
  resulting_configuration_hash: CanonicalHash;
}): CanonicalHash {
  return CanonicalHashSchema.parse(canonicalSha256({
    schema_version: options.schema_version,
    action: options.action,
    candidate_id: options.candidate.candidate_id,
    candidate_hash: options.candidate.candidate_hash,
    release_slot_hash: options.candidate.release_slot?.slot_hash,
    base_release_id: options.base_release_id,
    target_release_id: options.target_release_id,
    base_configuration_hash: options.base_configuration_hash,
    resulting_configuration_hash:
      options.resulting_configuration_hash,
    target: options.candidate.target,
  }));
}

function canonicalScopes(
  scopes: readonly unknown[],
) {
  return [...z.array(ScopeSchema).parse(scopes)].sort((left, right) =>
    scopeKey(left).localeCompare(scopeKey(right))
  );
}

function sameScopes(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return canonicalJson(canonicalScopes(left)) ===
    canonicalJson(canonicalScopes(right));
}

function approvalDetails(approval: PostCanaryApproval) {
  return {
    action: approval.action,
    candidate_id: approval.candidate_id,
    release_slot_hash: approval.release_slot_hash,
    base_release_id: approval.base_release_id,
    evaluation_receipt_id: approval.evaluation_receipt_id,
    evaluation_receipt_hash: approval.evaluation_receipt_hash,
    canary_receipt_id: approval.canary_receipt_id,
    canary_receipt_hash: approval.canary_receipt_hash,
    expected_pointer_revision: approval.expected_pointer_revision,
    target_release_id: approval.target_release_id,
    control_epoch: approval.control_epoch,
    effect_manifest_hash: approval.effect_manifest_hash,
  };
}

export class LearningReleaseManager {
  readonly #storage: LearningLabStorage;
  readonly #authorityRegistry: ReleaseAuthorityRegistry;
  readonly #approvalRegistry: ReleaseApprovalRegistry;
  readonly #clock: () => string;

  constructor(options: {
    storage: LearningLabStorage;
    authorityRegistry: ReleaseAuthorityRegistry;
    approvalRegistry: ReleaseApprovalRegistry;
    clock?: () => string;
  }) {
    this.#storage = options.storage;
    this.#authorityRegistry = options.authorityRegistry;
    this.#approvalRegistry = options.approvalRegistry;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async apply(
    input: unknown,
    execution: LearningReleaseExecutionOptions = {},
  ): Promise<LearningReleaseResult> {
    const parsed = LearningReleaseInputSchema.parse(input);
    const request = LearningReleaseInputSchema.parse({
      ...parsed,
      scopes: canonicalScopes(parsed.scopes),
    });
    const requestHash = CanonicalHashSchema.parse(
      execution.requestHash ?? canonicalSha256(request),
    );
    const replay = await this.#storage.replayLearningLedger({
      idempotency_key: request.idempotency_key,
      idempotency_hash: requestHash,
    });
    if (replay !== null) {
      if (
        replay.kind !== "release" &&
        replay.kind !== "rollback"
      ) {
        throw new LearningReleaseError(
          "RELEASE_REPLAY_INCOMPLETE",
        );
      }
      return this.#replayResult(request, requestHash);
    }

    const candidateLedger = await this.#storage.readLearningLedger({
      principal_id: request.principal_id,
      scopes: request.scopes,
      candidate_id: request.candidate_id,
    });
    const candidate = candidateLedger.candidates.find(
      (item) => item.candidate_id === request.candidate_id,
    );
    if (
      candidate === undefined ||
      candidateLedger.invalid_candidate_ids.includes(request.candidate_id)
    ) {
      throw new LearningReleaseError("CANDIDATE_INACCESSIBLE");
    }
    if (
      candidate.release_capability !== "release_capable" ||
      candidate.release_slot === null ||
      candidate.release_slot.principal_id !== request.principal_id ||
      (candidate.target.kind === "retrieval_policy" &&
        candidate.release_slot.target_key !==
          DEFAULT_LEARNED_RECALL_TARGET_KEY) ||
      !sameScopes(candidate.scopes, request.scopes) ||
      !sameScopes(candidate.release_slot.scopes, request.scopes)
    ) {
      throw new LearningReleaseError("RELEASE_INELIGIBLE");
    }
    const ledger = await this.#storage.readLearningLedger({
      principal_id: request.principal_id,
      scopes: request.scopes,
      release_slot_hash: candidate.release_slot.slot_hash,
    });

    const currentState = reduceCandidateState(
      candidate.candidate_id,
      ledger.transitions,
    );
    if (
      request.action === "release" &&
      currentState.state !== "canary"
    ) {
      throw new LearningReleaseError("CANDIDATE_NOT_CANARY");
    }
    if (
      request.action === "rollback" &&
      currentState.state !== "released"
    ) {
      throw new LearningReleaseError("ROLLBACK_NOT_RELEASED");
    }

    const control = ledger.controls.at(-1);
    if (control?.status === "paused") {
      throw new LearningReleaseError("LEARNING_PAUSED");
    }
    const controlEpoch = control?.control_epoch ?? 0;
    const currentPointer = ledger.pointers.find(
      (pointer) =>
        pointer.release_slot_hash === candidate.release_slot?.slot_hash,
    );
    const pointerRevision = currentPointer?.pointer_revision ?? 0;
    const activeReleaseId =
      currentPointer?.active_release_id ?? null;
    const currentRelease =
      activeReleaseId === null
        ? undefined
        : ledger.releases.find(
            (release) => release.release_id === activeReleaseId,
          );
    if (
      request.action === "rollback" &&
      (currentRelease === undefined ||
        currentRelease.candidate_id !== candidate.candidate_id)
    ) {
      throw new LearningReleaseError("POINTER_CONFLICT");
    }

    const evaluationReceipt =
      request.action === "rollback" && currentRelease !== undefined
        ? ledger.receipts.find(
            (receipt) =>
              receipt.kind === "evaluation" &&
              receipt.receipt_id ===
                currentRelease.evaluation_receipt_id,
          )
        : [...ledger.receipts].reverse().find(
            (receipt) =>
              receipt.kind === "evaluation" &&
              receipt.candidate_id === candidate.candidate_id &&
              receipt.passed &&
              !receipt.invalidated,
          );
    const canaryReceipt =
      request.action === "rollback" && currentRelease !== undefined
        ? ledger.receipts.find(
            (receipt) =>
              receipt.kind === "learning_canary" &&
              receipt.receipt_id === currentRelease.canary_receipt_id,
          )
        : [...ledger.receipts].reverse().find(
            (receipt) =>
              receipt.kind === "learning_canary" &&
              receipt.candidate_id === candidate.candidate_id &&
              receipt.passed,
          );
    if (
      evaluationReceipt?.kind !== "evaluation" ||
      !evaluationReceipt.passed ||
      evaluationReceipt.invalidated ||
      canaryReceipt?.kind !== "learning_canary" ||
      !canaryReceipt.passed
    ) {
      throw new LearningReleaseError("RELEASE_INELIGIBLE");
    }
    if (
      execution.expected !== undefined &&
      (execution.expected.release_slot_hash !==
          candidate.release_slot.slot_hash ||
        execution.expected.evaluation_receipt_id !==
          evaluationReceipt.receipt_id ||
        execution.expected.canary_receipt_id !==
          canaryReceipt.receipt_id)
    ) {
      throw new LearningReleaseError("RELEASE_INELIGIBLE");
    }
    if (
      execution.expected !== undefined &&
      execution.expected.pointer_revision !== pointerRevision
    ) {
      throw new LearningReleaseError("POINTER_CONFLICT");
    }
    if (
      execution.expected !== undefined &&
      execution.expected.control_epoch !== controlEpoch
    ) {
      throw new LearningReleaseError("CONTROL_FRONTIER_STALE");
    }
    if (
      request.action === "rollback" &&
      execution.expected?.current_release_id !== undefined &&
      execution.expected.current_release_id !== activeReleaseId
    ) {
      throw new LearningReleaseError("POINTER_CONFLICT");
    }

    const resultingConfigurationHash =
      this.#configurationHash({
        request,
        candidate,
        ledger,
      });
    const effectManifestHash = learningReleaseEffectManifestHash({
      schema_version: request.schema_version,
      action: request.action,
      candidate,
      base_release_id: activeReleaseId,
      target_release_id: request.target_release_id,
      base_configuration_hash: request.base_configuration_hash,
      resulting_configuration_hash: resultingConfigurationHash,
    });
    if (
      execution.expected !== undefined &&
      execution.expected.effect_manifest_hash !== effectManifestHash
    ) {
      throw new LearningReleaseError("APPROVAL_INVALID");
    }

    const verifiedAuthority =
      await this.#authorityRegistry.verifyPostCanaryApproval(
        request.approval_id,
      );
    let approval: PostCanaryApproval;
    try {
      approval = PostCanaryApprovalSchema.parse(
        verifiedAuthority.approval,
      );
    } catch {
      throw new LearningReleaseError("APPROVAL_INVALID");
    }
    if (
      approval.approval_id !== request.approval_id ||
      approval.principal_id !== request.principal_id ||
      approval.action !== request.action ||
      !sameScopes(approval.scopes, request.scopes) ||
      approval.candidate_id !== candidate.candidate_id ||
      approval.release_slot_hash !== candidate.release_slot.slot_hash ||
      approval.base_release_id !== activeReleaseId ||
      approval.evaluation_receipt_id !==
        evaluationReceipt.receipt_id ||
      approval.evaluation_receipt_hash !==
        evaluationReceipt.receipt_hash ||
      approval.canary_receipt_id !== canaryReceipt.receipt_id ||
      approval.canary_receipt_hash !== canaryReceipt.receipt_hash ||
      approval.expected_pointer_revision !== pointerRevision ||
      approval.target_release_id !== request.target_release_id ||
      approval.control_epoch !== controlEpoch ||
      approval.request_hash !== requestHash ||
      approval.effect_manifest_hash !== effectManifestHash ||
      Date.parse(approval.issued_at) >
        Date.parse(verifiedAuthority.verified_at) ||
      Date.parse(approval.expires_at) <=
        Date.parse(verifiedAuthority.verified_at)
    ) {
      throw new LearningReleaseError("APPROVAL_INVALID");
    }

    const binding = ApprovalBindingSchema.parse({
      approval_id: approval.approval_id,
      principal_id: approval.principal_id,
      tool:
        request.action === "release"
          ? "learning_release"
          : "learning_rollback",
      safety_class: "important_mutation",
      scopes: request.scopes,
      request_hash: requestHash,
      learning: approvalDetails(approval),
    });
    const verifiedApproval =
      await this.#approvalRegistry.verify(binding);
    const verifiedAt = UtcTimestampSchema.parse(this.#clock());
    if (
      !approvalGrantMatches(
        binding,
        verifiedApproval.grant,
        verifiedAt,
      )
    ) {
      throw new LearningReleaseError("APPROVAL_INVALID");
    }

    const releaseId = stableIdentifier(
      request.action === "release" ? "release" : "rollback",
      {
        idempotency_key: request.idempotency_key,
        request_hash: requestHash,
      },
    );
    const releaseInput = {
      schema_version: request.schema_version,
      release_id: releaseId,
      action: request.action,
      release_slot_hash: candidate.release_slot.slot_hash,
      candidate_id: candidate.candidate_id,
      previous_release_id: activeReleaseId,
      restored_release_id:
        request.action === "rollback"
          ? request.target_release_id
          : null,
      evaluation_receipt_id: evaluationReceipt.receipt_id,
      canary_receipt_id: canaryReceipt.receipt_id,
      approval_id: approval.approval_id,
      monitor_contract_hash:
        request.action === "rollback" && currentRelease !== undefined
          ? currentRelease.monitor_contract_hash
          : request.monitor_contract_hash,
      configuration_hash: resultingConfigurationHash,
      activated_at: request.activated_at,
      release_hash: canonicalSha256("placeholder"),
    };
    const release = LearningReleaseVersionSchema.parse({
      ...releaseInput,
      release_hash: canonicalSha256Omitting(releaseInput, [
        "release_hash",
      ]),
    });
    const pointerInput = {
      schema_version: request.schema_version,
      release_slot_hash: candidate.release_slot.slot_hash,
      active_release_id:
        request.action === "release"
          ? release.release_id
          : request.target_release_id,
      pointer_revision: pointerRevision + 1,
      updated_at: request.activated_at,
      pointer_hash: canonicalSha256("placeholder"),
    };
    const pointer = ReleasePointerSchema.parse({
      ...pointerInput,
      pointer_hash: canonicalSha256Omitting(pointerInput, [
        "pointer_hash",
      ]),
    });
    const transition = this.#transition({
      request,
      state: currentState,
      approval,
      evaluationReceiptId: evaluationReceipt.receipt_id,
      canaryReceiptId: canaryReceipt.receipt_id,
    });
    const receipt =
      request.action === "release"
        ? ReleaseReceiptSchema.parse(
            sealReceipt({
              schema_version: request.schema_version,
              receipt_id: stableIdentifier("release-receipt", {
                release_id: release.release_id,
                request_hash: requestHash,
              }),
              created_at: request.activated_at,
              state: "durable",
              request_hash: requestHash,
              kind: "release",
              release_id: release.release_id,
              release_slot_hash: release.release_slot_hash,
              candidate_id: release.candidate_id,
              previous_release_id: release.previous_release_id,
              evaluation_receipt_id:
                release.evaluation_receipt_id,
              canary_receipt_id: release.canary_receipt_id,
              approval_id: approval.approval_id,
              approval_hash: approval.approval_hash,
              resulting_pointer_revision: pointer.pointer_revision,
              control_epoch: controlEpoch,
              retrieval_configuration_hash:
                resultingConfigurationHash,
            }),
          )
        : RollbackReceiptSchema.parse(
            sealReceipt({
              schema_version: request.schema_version,
              receipt_id: stableIdentifier("rollback-receipt", {
                release_id: release.release_id,
                request_hash: requestHash,
              }),
              created_at: request.activated_at,
              state: "rolled_back",
              request_hash: requestHash,
              kind: "rollback",
              release_id: release.release_id,
              rolled_back_release_id: activeReleaseId as string,
              restored_release_id: request.target_release_id,
              approval_id: approval.approval_id,
              approval_hash: approval.approval_hash,
              monitor_receipt_id: request.monitor_receipt_id,
              resulting_pointer_revision: pointer.pointer_revision,
              control_epoch: controlEpoch,
              restored_configuration_hash:
                resultingConfigurationHash,
              reason: request.reason,
            }),
          );

    await this.#authorityRegistry
      .confirmPostCanaryApprovalUnchanged(verifiedAuthority);
    await this.#approvalRegistry.confirmUnchanged(verifiedApproval);
    await this.#storage.writeLearningLedger({
      kind: request.action,
      idempotency_key: request.idempotency_key,
      request_hash: requestHash,
      principal_id: request.principal_id,
      scopes: request.scopes,
      expected_control_epoch: controlEpoch,
      expected_pointer_revision: pointerRevision,
      approval_artifact: approval,
      approval_binding: binding,
      approval: {
        grant: verifiedApproval.grant,
        registry_hash: verifiedApproval.registry_hash,
        verified_at: verifiedAt,
      },
      effect: this.#releaseEffect(candidate),
      release,
      pointer,
      transition,
      receipt,
      ...(request.test_failure_point === undefined
        ? {}
        : { test_failure_point: request.test_failure_point }),
    });
    return LearningReleaseResultSchema.parse({
      request,
      release,
      pointer,
      transition,
      receipt,
      replayed: false,
    });
  }

  #configurationHash(options: {
    request: z.output<typeof LearningReleaseInputSchema>;
    candidate: CandidateChange;
    ledger: Awaited<
      ReturnType<LearningLabStorage["readLearningLedger"]>
    >;
  }): CanonicalHash {
    if (options.request.action === "rollback") {
      if (options.request.target_release_id === null) {
        return options.request.base_configuration_hash;
      }
      const restored = options.ledger.releases.find(
        (release) =>
          release.release_id === options.request.target_release_id,
      );
      if (restored === undefined) {
        throw new LearningReleaseError("ROLLBACK_TARGET_INVALID");
      }
      const restoredCandidate = options.ledger.candidates.find(
        (candidate) =>
          candidate.candidate_id === restored.candidate_id,
      );
      if (
        restoredCandidate === undefined ||
        options.ledger.invalid_candidate_ids.includes(
          restoredCandidate.candidate_id,
        )
      ) {
        throw new LearningReleaseError("ROLLBACK_TARGET_INVALID");
      }
      const recomputed = this.#candidateConfigurationHash(
        options.request,
        restoredCandidate,
      );
      if (recomputed !== restored.configuration_hash) {
        throw new LearningReleaseError("ROLLBACK_TARGET_INVALID");
      }
      return restored.configuration_hash;
    }
    return this.#candidateConfigurationHash(
      options.request,
      options.candidate,
    );
  }

  #candidateConfigurationHash(
    request: z.output<typeof LearningReleaseInputSchema>,
    candidate: CandidateChange,
  ): CanonicalHash {
    if (candidate.target.kind !== "retrieval_policy") {
      return CanonicalHashSchema.parse(
        canonicalSha256(candidate.target),
      );
    }
    if (
      request.operator_lane_policy === null ||
      canonicalSha256(request.operator_lane_policy) !==
        request.base_configuration_hash
    ) {
      throw new LearningReleaseError("CONFIGURATION_WIDENING");
    }
    return CanonicalHashSchema.parse(
      canonicalSha256(
        narrowLearnedLanePolicy(
          request.operator_lane_policy,
          candidate.target,
        ),
      ),
    );
  }

  #releaseEffect(candidate: CandidateChange) {
    switch (candidate.target.kind) {
      case "retrieval_policy":
        return { kind: "retrieval_policy" as const };
      case "memory":
      case "procedure":
        return {
          kind: "canonical_memory" as const,
          candidate_type: candidate.target.kind,
          memory_id: candidate.target.memory_id,
          revision_id: candidate.target.revision_id,
          content_hash: candidate.target.content_hash,
        };
      case "evaluation_only":
        throw new LearningReleaseError("RELEASE_INELIGIBLE");
    }
  }

  #transition(options: {
    request: z.output<typeof LearningReleaseInputSchema>;
    state: ReducedCandidateState;
    approval: PostCanaryApproval;
    evaluationReceiptId: string;
    canaryReceiptId: string;
  }) {
    const transitionInput = {
      schema_version: options.request.schema_version,
      transition_id: stableIdentifier("transition", {
        candidate_id: options.request.candidate_id,
        sequence: options.state.sequence + 1,
        approval_id: options.approval.approval_id,
      }),
      candidate_id: options.request.candidate_id,
      sequence: options.state.sequence + 1,
      from_state: options.state.state,
      to_state:
        options.request.action === "release"
          ? "released" as const
          : "rolled_back" as const,
      expected_previous_transition_hash:
        options.state.transition_hash,
      control_epoch: options.approval.control_epoch,
      actor_id: options.request.principal_id,
      authority_id: options.approval.approval_id,
      reason_code:
        options.request.action === "release"
          ? "POST_CANARY_RELEASE_APPROVED"
          : "EXACT_ROLLBACK_APPROVED",
      evidence_receipt_ids: [
        options.evaluationReceiptId,
        options.canaryReceiptId,
        ...(options.request.monitor_receipt_id === null
          ? []
          : [options.request.monitor_receipt_id]),
      ],
      idempotency_key: options.request.idempotency_key,
      transitioned_at: options.request.activated_at,
      transition_hash: canonicalSha256("placeholder"),
    };
    return CandidateTransitionSchema.parse({
      ...transitionInput,
      transition_hash: canonicalSha256Omitting(transitionInput, [
        "transition_hash",
      ]),
    });
  }

  async #replayResult(
    request: z.output<typeof LearningReleaseInputSchema>,
    requestHash: CanonicalHash,
  ): Promise<LearningReleaseResult> {
    const ledger = await this.#storage.readLearningLedger({
      principal_id: request.principal_id,
      scopes: request.scopes,
      candidate_id: request.candidate_id,
    });
    const receipt = ledger.receipts.find(
      (item) =>
        item.request_hash === requestHash &&
        (item.kind === "release" || item.kind === "rollback"),
    );
    if (receipt?.kind !== request.action) {
      throw new LearningReleaseError("RELEASE_REPLAY_INCOMPLETE");
    }
    const release = ledger.releases.find(
      (item) => item.release_id === receipt.release_id,
    );
    const transition = ledger.transitions.find(
      (item) =>
        item.authority_id === release?.approval_id &&
        item.candidate_id === request.candidate_id &&
        item.to_state ===
          (request.action === "release"
            ? "released"
            : "rolled_back"),
    );
    if (release === undefined || transition === undefined) {
      throw new LearningReleaseError("RELEASE_REPLAY_INCOMPLETE");
    }
    const pointerInput = {
      schema_version: release.schema_version,
      release_slot_hash: release.release_slot_hash,
      active_release_id:
        release.action === "release"
          ? release.release_id
          : release.restored_release_id,
      pointer_revision: receipt.resulting_pointer_revision,
      updated_at: release.activated_at,
      pointer_hash: canonicalSha256("placeholder"),
    };
    const pointer = ReleasePointerSchema.parse({
      ...pointerInput,
      pointer_hash: canonicalSha256Omitting(pointerInput, [
        "pointer_hash",
      ]),
    });
    if (!receiptHashIsValid(receipt)) {
      throw new LearningReleaseError("RELEASE_REPLAY_INCOMPLETE");
    }
    return LearningReleaseResultSchema.parse({
      request,
      release,
      pointer,
      transition,
      receipt,
      replayed: true,
    });
  }
}

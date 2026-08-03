import {
  AuthoritySchema,
  CandidateChangeSchema,
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  LaneLimitOverridesSchema,
  LanePolicySchema,
  LearningStopReceiptSchema,
  RecallLaneSchema,
  ReleaseSlotSchema,
  ScopeSchema,
  SensitivitySchema,
  UtcTimestampSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  scopeKey,
  type CandidateChange,
} from "@memo-graph/contracts";
import { z } from "zod";

import { persistLearningStop } from "./learning-stop.js";
import type { LearningLabStorage } from "./storage-port.js";

const CanonicalTargetFields = {
  memory_id: IdentifierSchema,
  revision_id: IdentifierSchema,
  content_hash: CanonicalHashSchema,
};

const CandidateOptionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory"), ...CanonicalTargetFields }).strict(),
  z.object({ kind: z.literal("procedure"), ...CanonicalTargetFields }).strict(),
  z
    .object({
      kind: z.literal("retrieval_policy"),
      target_key: IdentifierSchema,
      requested_lanes: z.array(RecallLaneSchema).min(1),
      limits: LaneLimitOverridesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("prompt"),
      artifact_ref: IdentifierSchema,
      artifact_hash: CanonicalHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("core_projection"),
      artifact_ref: IdentifierSchema,
      artifact_hash: CanonicalHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("scenario_pattern"),
      artifact_ref: IdentifierSchema,
      artifact_hash: CanonicalHashSchema,
    })
    .strict(),
  z.object({ kind: z.literal("skill") }).strict(),
  z.object({ kind: z.literal("code") }).strict(),
  z.object({ kind: z.literal("model") }).strict(),
]);

const CandidateOptionListSchema = z.array(CandidateOptionSchema).min(1);

export const CandidateProposalInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    idempotency_key: z.string().trim().min(8).max(200),
    candidate_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    trace_ids: z.array(IdentifierSchema).min(1),
    evidence_ids: z.array(IdentifierSchema).min(1),
    base_release_ids: z.array(IdentifierSchema),
    active_base_release_id: IdentifierSchema.nullable(),
    current_retrieval_policy: LanePolicySchema,
    options: CandidateOptionListSchema,
    expected_improvement_ids: z.array(IdentifierSchema).min(1),
    protected_invariant_ids: z.array(IdentifierSchema).min(1),
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    impact: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(1),
    requires_user_confirmation: z.boolean(),
    evaluation_contract_hash: CanonicalHashSchema,
    rollback_target_release_id: IdentifierSchema.nullable(),
    proposed_at: UtcTimestampSchema,
    proposed_by: IdentifierSchema,
    control_epoch: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of [
      ["trace_ids", value.trace_ids],
      ["evidence_ids", value.evidence_ids],
      ["base_release_ids", value.base_release_ids],
      ["expected_improvement_ids", value.expected_improvement_ids],
      ["protected_invariant_ids", value.protected_invariant_ids],
    ] as const) {
      if (new Set(entries).size !== entries.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be unique`,
        });
      }
    }
    const scopeKeys = value.scopes.map(scopeKey);
    if (new Set(scopeKeys).size !== scopeKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "candidate proposal scopes must be unique",
      });
    }
    if (
      value.active_base_release_id !== null &&
      !value.base_release_ids.includes(value.active_base_release_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["active_base_release_id"],
        message: "active base release must be part of the frozen base set",
      });
    }
  });

export const CandidateProposalResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("proposed"),
      candidate: CandidateChangeSchema,
      replayed: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("stopped"),
      reason_code: z.string().trim().min(1).max(200),
      receipt: LearningStopReceiptSchema,
      replayed: z.boolean(),
    })
    .strict(),
]);

export type CandidateProposalInput = z.input<
  typeof CandidateProposalInputSchema
>;
export type CandidateProposalResult = z.infer<
  typeof CandidateProposalResultSchema
>;
export type CandidateOption = z.infer<typeof CandidateOptionSchema>;
type EligibleGovernedTarget = Extract<
  NonNullable<
    Awaited<ReturnType<LearningLabStorage["getGovernedMemory"]>>
  >,
  { eligible: true }
>;

const CANDIDATE_ORDER: Readonly<Record<CandidateOption["kind"], number>> = {
  memory: 0,
  procedure: 1,
  retrieval_policy: 2,
  prompt: 3,
  core_projection: 4,
  scenario_pattern: 5,
  skill: 6,
  code: 7,
  model: 8,
};

export function selectSmallestCandidateOption(
  input: unknown,
): CandidateOption {
  const first = orderedCandidateOptions(input)[0];
  if (first === undefined) {
    throw new Error("candidate option list must not be empty");
  }
  return first;
}

function isUnsupported(
  option: CandidateOption,
): option is Extract<
  CandidateOption,
  { kind: "skill" | "code" | "model" }
> {
  return (
    option.kind === "skill" ||
    option.kind === "code" ||
    option.kind === "model"
  );
}

function orderedCandidateOptions(
  input: unknown,
): CandidateOption[] {
  const options = CandidateOptionListSchema.parse(input);
  return [...options].sort(
    (left, right) =>
      CANDIDATE_ORDER[left.kind] - CANDIDATE_ORDER[right.kind],
  );
}

export class LearningCandidateBuilder {
  readonly #storage: LearningLabStorage;

  constructor(options: { storage: LearningLabStorage }) {
    this.#storage = options.storage;
  }

  async propose(input: unknown): Promise<CandidateProposalResult> {
    const parsed = CandidateProposalInputSchema.parse(input);
    const canonicalScopes = [...parsed.scopes].sort((left, right) =>
      scopeKey(left).localeCompare(scopeKey(right)),
    );
    const requestIdentity = {
      ...parsed,
      scopes: canonicalScopes,
    };
    const idempotencyHash = canonicalSha256(requestIdentity);
    const replay = await this.#storage.replayLearningLedger({
      idempotency_key: parsed.idempotency_key,
      idempotency_hash: idempotencyHash,
    });
    if (replay !== null) {
      if (replay.kind === "candidate") {
        const frozen = await this.#storage.readLearningLedger({
          principal_id: parsed.principal_id,
          scopes: canonicalScopes,
          candidate_id: parsed.candidate_id,
        });
        const candidate = frozen.candidates.find(
          (item) => item.candidate_id === parsed.candidate_id,
        );
        if (candidate === undefined) {
          throw new Error("learning candidate replay artifact is unavailable");
        }
        return CandidateProposalResultSchema.parse({
          status: "proposed",
          candidate,
          replayed: true,
        });
      }
      if (replay.kind === "stop") {
        const receipt = LearningStopReceiptSchema.parse(replay.receipt);
        return CandidateProposalResultSchema.parse({
          status: "stopped",
          reason_code: receipt.reason_code,
          receipt,
          replayed: true,
        });
      }
      throw new Error("learning candidate replay kind mismatch");
    }
    const stop = async (reasonCode: string): Promise<CandidateProposalResult> => {
      const stopped = await persistLearningStop({
        storage: this.#storage,
        idempotencyKey: parsed.idempotency_key,
        idempotencyHash,
        principalId: parsed.principal_id,
        scopes: canonicalScopes,
        controlEpoch: parsed.control_epoch,
        reasonCode,
        createdAt: parsed.proposed_at,
        requestIdentity,
      });
      return CandidateProposalResultSchema.parse({
        status: "stopped",
        reason_code: reasonCode,
        receipt: stopped.receipt,
        replayed: stopped.replayed,
      });
    };

    const ledger = await this.#storage.readLearningLedger({
      principal_id: parsed.principal_id,
      scopes: canonicalScopes,
    });
    const control = ledger.controls.at(-1);
    if (control?.status === "paused") {
      return stop("LEARNING_PAUSED");
    }
    if ((control?.control_epoch ?? 0) !== parsed.control_epoch) {
      return stop("CONTROL_FRONTIER_STALE");
    }
    const activeReleaseIds = ledger.pointers
      .flatMap((pointer) =>
        pointer.active_release_id === null
          ? []
          : [pointer.active_release_id],
      )
      .sort();
    if (
      canonicalSha256([...parsed.base_release_ids].sort()) !==
      canonicalSha256(activeReleaseIds)
    ) {
      return stop("BASE_RELEASE_DRIFT");
    }

    const traces = [];
    for (const traceId of parsed.trace_ids) {
      const traceLedger = await this.#storage.readLearningLedger({
        principal_id: parsed.principal_id,
        scopes: canonicalScopes,
        trace_id: traceId,
      });
      const trace = traceLedger.traces.find(
        (item) => item.trace_id === traceId,
      );
      if (trace === undefined) {
        return stop("TRACE_INACCESSIBLE");
      }
      traces.push(trace);
    }
    const expectedRetrievalConfigurationHash = canonicalSha256(
      parsed.current_retrieval_policy,
    );
    const activeReleaseSetHash = canonicalSha256(
      ledger.pointers
        .map((pointer) => ({
          release_slot_hash: pointer.release_slot_hash,
          active_release_id: pointer.active_release_id,
          pointer_revision: pointer.pointer_revision,
          pointer_hash: pointer.pointer_hash,
        }))
        .sort((left, right) =>
          left.release_slot_hash.localeCompare(right.release_slot_hash),
        ),
    );
    if (
      traces.some(
        (trace) =>
          trace.retrieval_configuration_hash !==
            expectedRetrievalConfigurationHash ||
          trace.active_release_set_hash !== activeReleaseSetHash ||
          trace.control_epoch !== parsed.control_epoch,
      )
    ) {
      return stop("CONFIGURATION_DRIFT");
    }
    const traceEvidence = new Set(
      traces.flatMap((trace) => [
        ...trace.trajectory.flatMap((step) =>
          step.retention.mode === "reference"
            ? [step.retention.evidence_id]
            : [],
        ),
        ...trace.observations.flatMap((observation) =>
          observation.evidence_id === null
            ? []
            : [observation.evidence_id],
        ),
      ]),
    );
    if (
      parsed.evidence_ids.some(
        (evidenceId) => !traceEvidence.has(evidenceId),
      )
    ) {
      return stop("EVIDENCE_INACCESSIBLE");
    }

    let candidateType: CandidateChange["candidate_type"] | undefined;
    let releaseCapability:
      | CandidateChange["release_capability"]
      | undefined;
    let releaseSlot: CandidateChange["release_slot"] | undefined;
    let target: CandidateChange["target"] | undefined;
    let rejectionReason = "UNSUPPORTED_CANDIDATE_TYPE";
    for (const selected of orderedCandidateOptions(parsed.options)) {
      if (isUnsupported(selected)) {
        continue;
      }
      if (selected.kind === "memory" || selected.kind === "procedure") {
        let targetItem: EligibleGovernedTarget | undefined;
        for (const scope of canonicalScopes) {
          const result = await this.#storage.getGovernedMemory({
            memory_id: selected.memory_id,
            principal_id: parsed.principal_id,
            scope,
            as_of: parsed.proposed_at,
            include_sensitive: true,
            context_scope: null,
          });
          if (result?.eligible === true) {
            targetItem = result;
            break;
          }
        }
        if (
          targetItem === undefined ||
          targetItem.item.revision_id !== selected.revision_id ||
          targetItem.item.content_hash !== selected.content_hash ||
          targetItem.item.sensitivity !== parsed.sensitivity ||
          (selected.kind === "procedure" &&
            targetItem.item.kind !== "procedural")
        ) {
          rejectionReason = "TARGET_INELIGIBLE";
          continue;
        }
        candidateType = selected.kind;
        releaseCapability = "release_capable";
        target = {
          kind: selected.kind,
          memory_id: selected.memory_id,
          revision_id: selected.revision_id,
          content_hash: selected.content_hash,
        };
        releaseSlot = this.#releaseSlot(
          parsed.principal_id,
          selected.kind,
          canonicalScopes,
          selected.memory_id,
        );
        break;
      }
      if (selected.kind === "retrieval_policy") {
        const allowed = new Set(
          parsed.current_retrieval_policy.allowed_lanes,
        );
        const currentLimits = parsed.current_retrieval_policy.limits;
        const narrowsLanes = selected.requested_lanes.every((lane) =>
          allowed.has(lane),
        );
        const narrowsLimits = Object.entries(selected.limits).every(
          ([key, value]) => {
            const current = currentLimits[
              key as keyof typeof currentLimits
            ];
            return (
              typeof current === "number" &&
              typeof value === "number" &&
              value <= current &&
              !key.startsWith("graph_") &&
              !key.startsWith("vector_")
            );
          },
        );
        if (
          !narrowsLanes ||
          !narrowsLimits ||
          parsed.current_retrieval_policy.allowed_lanes.some(
            (lane) =>
              lane === "relation_graph" ||
              lane === "semantic_vector",
          )
        ) {
          rejectionReason = "RETRIEVAL_POLICY_WIDENING";
          continue;
        }
        candidateType = "retrieval_policy";
        releaseCapability = "release_capable";
        target = {
          kind: "retrieval_policy",
          requested_lanes: selected.requested_lanes,
          limits: selected.limits,
        };
        releaseSlot = this.#releaseSlot(
          parsed.principal_id,
          "retrieval_policy",
          canonicalScopes,
          selected.target_key,
        );
        break;
      }
      if (!parsed.requires_user_confirmation) {
        rejectionReason = "AUTHORITY_REQUIRED";
        continue;
      }
      candidateType = selected.kind;
      releaseCapability = "evaluation_only";
      target = {
        kind: "evaluation_only",
        artifact_type: selected.kind,
        artifact_ref: selected.artifact_ref,
        artifact_hash: selected.artifact_hash,
      };
      releaseSlot = null;
      break;
    }
    if (
      candidateType === undefined ||
      releaseCapability === undefined ||
      releaseSlot === undefined ||
      target === undefined
    ) {
      return stop(rejectionReason);
    }
    const confirmationRequired =
      releaseCapability === "evaluation_only" ||
      parsed.impact === "high" ||
      parsed.confidence < 0.8 ||
      parsed.sensitivity === "sensitive" ||
      parsed.sensitivity === "secret";
    if (confirmationRequired && !parsed.requires_user_confirmation) {
      return stop("AUTHORITY_REQUIRED");
    }

    if (
      (releaseCapability === "release_capable" &&
        parsed.rollback_target_release_id !==
          parsed.active_base_release_id) ||
      (releaseCapability === "evaluation_only" &&
        parsed.rollback_target_release_id !== null)
    ) {
      return stop("ROLLBACK_TARGET_MISMATCH");
    }
    const currentSlotPointer =
      releaseSlot === null
        ? undefined
        : ledger.pointers.find(
            (pointer) =>
              pointer.release_slot_hash === releaseSlot.slot_hash,
          );
    if (
      releaseSlot !== null &&
      (currentSlotPointer?.active_release_id ?? null) !==
        parsed.active_base_release_id
    ) {
      return stop("BASE_RELEASE_DRIFT");
    }
    const unsealed = {
      schema_version: parsed.schema_version,
      candidate_id: parsed.candidate_id,
      candidate_type: candidateType,
      release_capability: releaseCapability,
      principal_id: parsed.principal_id,
      scopes: canonicalScopes,
      release_slot: releaseSlot,
      target,
      base_release_ids: parsed.base_release_ids,
      active_base_release_id: parsed.active_base_release_id,
      trace_ids: parsed.trace_ids,
      evidence_ids: parsed.evidence_ids,
      expected_improvement_ids: parsed.expected_improvement_ids,
      protected_invariant_ids: parsed.protected_invariant_ids,
      authority: parsed.authority,
      sensitivity: parsed.sensitivity,
      impact: parsed.impact,
      confidence: parsed.confidence,
      requires_user_confirmation: parsed.requires_user_confirmation,
      evaluation_contract_hash: parsed.evaluation_contract_hash,
      rollback_target_release_id: parsed.rollback_target_release_id,
      proposed_at: parsed.proposed_at,
      proposed_by: parsed.proposed_by,
      reason:
        "Deterministic smallest eligible change under the frozen M5 ordering.",
    };
    const candidate = CandidateChangeSchema.parse({
      ...unsealed,
      candidate_hash: canonicalSha256(unsealed),
    });
    const command = {
      kind: "candidate" as const,
      idempotency_key: parsed.idempotency_key,
      idempotency_hash: idempotencyHash,
      candidate,
    };
    const written = await this.#storage.writeLearningLedger({
      ...command,
      request_hash: canonicalSha256Omitting(command, ["request_hash"]),
    });
    return CandidateProposalResultSchema.parse({
      status: "proposed",
      candidate,
      replayed: written.replayed,
    });
  }

  #releaseSlot(
    principalId: string,
    candidateType: "memory" | "procedure" | "retrieval_policy",
    scopes: readonly z.output<typeof ScopeSchema>[],
    targetKey: string,
  ): NonNullable<CandidateChange["release_slot"]> {
    const canonicalScopes = [...scopes].sort((left, right) =>
      scopeKey(left).localeCompare(scopeKey(right)),
    );
    const unsealed = {
      principal_id: principalId,
      candidate_type: candidateType,
      scopes: canonicalScopes,
      target_key: targetKey,
    };
    return ReleaseSlotSchema.parse({
      ...unsealed,
      slot_hash: canonicalSha256(unsealed),
    });
  }
}

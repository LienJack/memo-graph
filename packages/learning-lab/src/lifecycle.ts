import {
  CandidateStateSchema,
  CandidateTransitionReceiptSchema,
  CandidateTransitionSchema,
  ContractVersionSchema,
  IdentifierSchema,
  ScopeSchema,
  UtcTimestampSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  scopeKey,
  sealReceipt,
  type CandidateState,
} from "@memo-graph/contracts";
import { z } from "zod";

import type { LearningLabStorage } from "./storage-port.js";

const StandaloneTransitionTargetSchema = z.enum([
  "quarantined",
  "evaluating",
  "approved_for_canary",
  "rejected",
]);

export const CandidateLifecycleInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    idempotency_key: z.string().trim().min(8).max(200),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    candidate_id: IdentifierSchema,
    expected_state: CandidateStateSchema,
    expected_sequence: z.number().int().nonnegative(),
    expected_previous_transition_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    to_state: StandaloneTransitionTargetSchema,
    control_epoch: z.number().int().nonnegative(),
    actor_id: IdentifierSchema,
    authority_id: IdentifierSchema.nullable(),
    evidence_receipt_ids: z.array(IdentifierSchema).min(1),
    reason_code: z.string().trim().min(1).max(200),
    transitioned_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const scopeKeys = value.scopes.map(scopeKey);
    if (new Set(scopeKeys).size !== scopeKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "candidate lifecycle scopes must be unique",
      });
    }
    if (
      new Set(value.evidence_receipt_ids).size !==
      value.evidence_receipt_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence_receipt_ids"],
        message: "lifecycle evidence receipt ids must be unique",
      });
    }
  });

export const CandidateLifecycleResultSchema = z
  .object({
    request: CandidateLifecycleInputSchema,
    transition: CandidateTransitionSchema,
    receipt: CandidateTransitionReceiptSchema,
    replayed: z.boolean(),
  })
  .strict();

export type CandidateLifecycleInput = z.input<
  typeof CandidateLifecycleInputSchema
>;
export type CandidateLifecycleResult = z.output<
  typeof CandidateLifecycleResultSchema
>;

export type ReducedCandidateState = {
  candidate_id: string;
  state: CandidateState;
  sequence: number;
  transition_hash: string | null;
};

export class LearningLifecycleError extends Error {
  readonly code:
    | "CANDIDATE_INACCESSIBLE"
    | "TRANSITION_CONFLICT"
    | "EVALUATION_INELIGIBLE"
    | "LEARNING_PAUSED"
    | "CONTROL_FRONTIER_STALE"
    | "EVIDENCE_RECEIPT_INACCESSIBLE"
    | "LIFECYCLE_REPLAY_INCOMPLETE";

  constructor(code: LearningLifecycleError["code"]) {
    super(code);
    this.name = "LearningLifecycleError";
    this.code = code;
  }
}

export function reduceCandidateState(
  candidateIdInput: unknown,
  transitionsInput: unknown,
): ReducedCandidateState {
  const candidateId = IdentifierSchema.parse(candidateIdInput);
  const transitions = z
    .array(CandidateTransitionSchema)
    .parse(transitionsInput)
    .filter((transition) => transition.candidate_id === candidateId)
    .sort((left, right) => left.sequence - right.sequence);
  let state: CandidateState = "proposed";
  let sequence = 0;
  let transitionHash: string | null = null;
  for (const transition of transitions) {
    if (
      transition.sequence !== sequence + 1 ||
      transition.from_state !== state ||
      transition.expected_previous_transition_hash !== transitionHash
    ) {
      throw new LearningLifecycleError("TRANSITION_CONFLICT");
    }
    state = transition.to_state;
    sequence = transition.sequence;
    transitionHash = transition.transition_hash;
  }
  return {
    candidate_id: candidateId,
    state,
    sequence,
    transition_hash: transitionHash,
  };
}

export class CandidateLifecycle {
  readonly #storage: LearningLabStorage;

  constructor(options: { storage: LearningLabStorage }) {
    this.#storage = options.storage;
  }

  async transition(input: unknown): Promise<CandidateLifecycleResult> {
    const parsed = CandidateLifecycleInputSchema.parse(input);
    const canonicalScopes = [...parsed.scopes].sort((left, right) =>
      scopeKey(left).localeCompare(scopeKey(right)),
    );
    const request = CandidateLifecycleInputSchema.parse({
      ...parsed,
      scopes: canonicalScopes,
    });
    const idempotencyHash = canonicalSha256(request);
    const replay = await this.#storage.replayLearningLedger({
      idempotency_key: parsed.idempotency_key,
      idempotency_hash: idempotencyHash,
    });
    if (replay !== null) {
      if (replay.kind !== "transition") {
        throw new LearningLifecycleError(
          "LIFECYCLE_REPLAY_INCOMPLETE",
        );
      }
      const ledger = await this.#storage.readLearningLedger({
        principal_id: parsed.principal_id,
        scopes: canonicalScopes,
        candidate_id: parsed.candidate_id,
      });
      const transition = ledger.transitions.find(
        (item) => item.idempotency_key === parsed.idempotency_key,
      );
      const receipt = ledger.receipts.find(
        (item) =>
          item.kind === "learning_transition" &&
          item.transition_id === transition?.transition_id,
      );
      if (
        transition === undefined ||
        receipt?.kind !== "learning_transition"
      ) {
        throw new LearningLifecycleError(
          "LIFECYCLE_REPLAY_INCOMPLETE",
        );
      }
      return CandidateLifecycleResultSchema.parse({
        request,
        transition,
        receipt,
        replayed: true,
      });
    }

    const ledger = await this.#storage.readLearningLedger({
      principal_id: parsed.principal_id,
      scopes: canonicalScopes,
      candidate_id: parsed.candidate_id,
    });
    const candidate = ledger.candidates.find(
      (item) => item.candidate_id === parsed.candidate_id,
    );
    if (
      candidate === undefined ||
      ledger.invalid_candidate_ids.includes(parsed.candidate_id)
    ) {
      throw new LearningLifecycleError("CANDIDATE_INACCESSIBLE");
    }
    const current = reduceCandidateState(
      parsed.candidate_id,
      ledger.transitions,
    );
    if (
      current.state !== parsed.expected_state ||
      current.sequence !== parsed.expected_sequence ||
      current.transition_hash !==
        parsed.expected_previous_transition_hash
    ) {
      throw new LearningLifecycleError("TRANSITION_CONFLICT");
    }
    const control = ledger.controls.at(-1);
    if (control?.status === "paused") {
      throw new LearningLifecycleError("LEARNING_PAUSED");
    }
    if ((control?.control_epoch ?? 0) !== parsed.control_epoch) {
      throw new LearningLifecycleError("CONTROL_FRONTIER_STALE");
    }
    const evidenceReceipts = ledger.receipts.filter((receipt) =>
      parsed.evidence_receipt_ids.includes(receipt.receipt_id),
    );
    if (
      evidenceReceipts.length !== parsed.evidence_receipt_ids.length
    ) {
      throw new LearningLifecycleError(
        "EVIDENCE_RECEIPT_INACCESSIBLE",
      );
    }
    if (parsed.to_state === "approved_for_canary") {
      const evaluationReceipt = evidenceReceipts.find(
        (receipt) =>
          receipt.kind === "evaluation" &&
          receipt.candidate_id === candidate.candidate_id &&
          receipt.passed &&
          !receipt.invalidated,
      );
      if (
        candidate.release_capability !== "release_capable" ||
        candidate.release_slot === null ||
        evaluationReceipt === undefined
      ) {
        throw new LearningLifecycleError("EVALUATION_INELIGIBLE");
      }
    }
    const transitionInput = {
      schema_version: parsed.schema_version,
      transition_id: `transition:${canonicalSha256({
        candidate_id: parsed.candidate_id,
        sequence: current.sequence + 1,
        idempotency_key: parsed.idempotency_key,
      }).slice("sha256:".length, 48)}`,
      candidate_id: parsed.candidate_id,
      sequence: current.sequence + 1,
      from_state: current.state,
      to_state: parsed.to_state,
      expected_previous_transition_hash: current.transition_hash,
      control_epoch: parsed.control_epoch,
      actor_id: parsed.actor_id,
      authority_id: parsed.authority_id,
      reason_code: parsed.reason_code,
      evidence_receipt_ids: parsed.evidence_receipt_ids,
      idempotency_key: parsed.idempotency_key,
      transitioned_at: parsed.transitioned_at,
    };
    const transition = CandidateTransitionSchema.parse({
      ...transitionInput,
      transition_hash: canonicalSha256(transitionInput),
    });
    const receipt = CandidateTransitionReceiptSchema.parse(
      sealReceipt({
        schema_version: parsed.schema_version,
        receipt_id: `transition-receipt:${canonicalSha256({
          transition_id: transition.transition_id,
          transition_hash: transition.transition_hash,
        }).slice("sha256:".length, 48)}`,
        created_at: parsed.transitioned_at,
        state: "durable",
        request_hash: idempotencyHash,
        kind: "learning_transition",
        candidate_id: parsed.candidate_id,
        transition_id: transition.transition_id,
        sequence: transition.sequence,
        from_state: transition.from_state,
        to_state: transition.to_state,
        authority_id: transition.authority_id,
        evidence_receipt_ids: transition.evidence_receipt_ids,
        control_epoch: transition.control_epoch,
      }),
    );
    const command = {
      kind: "transition" as const,
      idempotency_key: parsed.idempotency_key,
      idempotency_hash: idempotencyHash,
      transition,
      receipt,
    };
    await this.#storage.writeLearningLedger({
      ...command,
      request_hash: canonicalSha256Omitting(command, ["request_hash"]),
    });
    return CandidateLifecycleResultSchema.parse({
      request,
      transition,
      receipt,
      replayed: false,
    });
  }
}

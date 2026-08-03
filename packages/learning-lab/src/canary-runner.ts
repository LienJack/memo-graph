import {
  CanaryAuthorizationSchema,
  CanaryManifestSchema,
  CanaryReceiptSchema,
  CanaryRunSchema,
  CandidateTransitionSchema,
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  ScopeSchema,
  UtcTimestampSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  scopeKey,
  sealReceipt,
  type CanaryAuthorization,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  reduceCandidateState,
  type ReducedCandidateState,
} from "./lifecycle.js";
import type { G5LoadedCanaryCase } from "./partition-loader.js";
import type { LearningLabStorage } from "./storage-port.js";

const StableCanaryCodeSchema = z.string().trim().min(1).max(200);

const CanaryRunInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    idempotency_key: z.string().trim().min(8).max(200),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    candidate_id: IdentifierSchema,
    authorization_id: IdentifierSchema,
    canary_manifest: CanaryManifestSchema,
    started_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const scopeKeys = value.scopes.map(scopeKey);
    if (new Set(scopeKeys).size !== scopeKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "canary scopes must be unique",
      });
    }
  });

const CanaryCaseExecutionResultSchema = z
  .object({
    case_id: IdentifierSchema,
    stable_comparator_release_id: IdentifierSchema.nullable(),
    passed: z.boolean(),
    failure_codes: z.array(StableCanaryCodeSchema),
    initial_state_hash: CanonicalHashSchema,
    final_state_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.failure_codes).size !== value.failure_codes.length) {
      context.addIssue({
        code: "custom",
        path: ["failure_codes"],
        message: "canary failure codes must be unique",
      });
    }
    if (value.passed && value.failure_codes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["failure_codes"],
        message: "a passing canary case cannot report failure codes",
      });
    }
  });

export const CanaryRunResultSchema = z
  .object({
    authorization: CanaryAuthorizationSchema,
    transition: CandidateTransitionSchema,
    run: CanaryRunSchema,
    receipt: CanaryReceiptSchema,
    replayed: z.boolean(),
  })
  .strict();

export type CanaryRunInput = z.input<typeof CanaryRunInputSchema>;
export type CanaryCaseExecutionResult = z.input<
  typeof CanaryCaseExecutionResultSchema
>;
export type CanaryRunResult = z.output<typeof CanaryRunResultSchema>;

export type CanaryCaseExecutionRequest = {
  canary_run_id: string;
  candidate_id: string;
  stable_release_id: string | null;
  initial_state_hash: string;
  case_body: G5LoadedCanaryCase["case_body"];
  oracle: G5LoadedCanaryCase["oracle"];
};

type CanaryPartitionSource = {
  loadCanaryCases(input: unknown): Promise<G5LoadedCanaryCase[]>;
};

export type VerifiedCanaryAuthority = {
  authorization: CanaryAuthorization;
  registry_hash: `sha256:${string}`;
  verified_at: string;
};

export interface CanaryAuthorityRegistry {
  verifyCanaryAuthorization(
    authorizationId: string,
  ): Promise<VerifiedCanaryAuthority>;
  confirmCanaryAuthorizationUnchanged(
    verified: VerifiedCanaryAuthority,
  ): Promise<void>;
}

export class LearningCanaryError extends Error {
  readonly code:
    | "CANARY_REPLAY_INCOMPLETE"
    | "CANDIDATE_INACCESSIBLE"
    | "CANDIDATE_NOT_APPROVED"
    | "EVALUATION_INELIGIBLE"
    | "CONFIGURATION_DRIFT"
    | "LEARNING_PAUSED"
    | "CONTROL_FRONTIER_STALE"
    | "AUTHORIZATION_INVALID";

  constructor(code: LearningCanaryError["code"]) {
    super(code);
    this.name = "LearningCanaryError";
    this.code = code;
  }
}

export class LearningCanaryRunner {
  readonly #storage: LearningLabStorage;
  readonly #partitions: CanaryPartitionSource;
  readonly #authorityRegistry: CanaryAuthorityRegistry;
  readonly #executeCase: (
    request: CanaryCaseExecutionRequest,
  ) => CanaryCaseExecutionResult | Promise<CanaryCaseExecutionResult>;
  readonly #stateProbe: () => string | Promise<string>;
  readonly #clock: () => string;

  constructor(options: {
    storage: LearningLabStorage;
    partitions: CanaryPartitionSource;
    authorityRegistry: CanaryAuthorityRegistry;
    executeCase: (
      request: CanaryCaseExecutionRequest,
    ) => CanaryCaseExecutionResult | Promise<CanaryCaseExecutionResult>;
    stateProbe: () => string | Promise<string>;
    clock?: () => string;
  }) {
    this.#storage = options.storage;
    this.#partitions = options.partitions;
    this.#authorityRegistry = options.authorityRegistry;
    this.#executeCase = options.executeCase;
    this.#stateProbe = options.stateProbe;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async run(input: unknown): Promise<CanaryRunResult> {
    const parsed = CanaryRunInputSchema.parse(input);
    const scopes = [...parsed.scopes].sort((left, right) =>
      scopeKey(left).localeCompare(scopeKey(right)),
    );
    const request = CanaryRunInputSchema.parse({
      ...parsed,
      scopes,
    });
    const idempotencyHash = canonicalSha256(request);
    const replay = await this.#storage.replayLearningLedger({
      idempotency_key: parsed.idempotency_key,
      idempotency_hash: idempotencyHash,
    });
    if (replay !== null) {
      if (replay.kind !== "canary") {
        throw new LearningCanaryError("CANARY_REPLAY_INCOMPLETE");
      }
      return this.#replayResult(request, idempotencyHash);
    }

    const ledgerBefore = await this.#storage.readLearningLedger({
      principal_id: parsed.principal_id,
      scopes,
      candidate_id: parsed.candidate_id,
    });
    const candidate = ledgerBefore.candidates.find(
      (item) => item.candidate_id === parsed.candidate_id,
    );
    if (
      candidate === undefined ||
      ledgerBefore.invalid_candidate_ids.includes(parsed.candidate_id)
    ) {
      throw new LearningCanaryError("CANDIDATE_INACCESSIBLE");
    }
    const candidateState = reduceCandidateState(
      candidate.candidate_id,
      ledgerBefore.transitions,
    );
    if (candidateState.state !== "approved_for_canary") {
      throw new LearningCanaryError("CANDIDATE_NOT_APPROVED");
    }
    if (
      candidate.release_capability !== "release_capable" ||
      candidate.release_slot === null
    ) {
      throw new LearningCanaryError("EVALUATION_INELIGIBLE");
    }
    const evaluationReceipt = [...ledgerBefore.receipts]
      .reverse()
      .find(
        (receipt) =>
          receipt.kind === "evaluation" &&
          receipt.candidate_id === candidate.candidate_id &&
          receipt.passed &&
          !receipt.invalidated,
      );
    if (evaluationReceipt?.kind !== "evaluation") {
      throw new LearningCanaryError("EVALUATION_INELIGIBLE");
    }
    const evaluationIdentity = ledgerBefore.evaluation_identities.find(
      (identity) => identity.run_id === evaluationReceipt.run_id,
    );
    if (evaluationIdentity === undefined) {
      throw new LearningCanaryError("EVALUATION_INELIGIBLE");
    }
    const control = ledgerBefore.controls.at(-1);
    if (control?.status === "paused") {
      throw new LearningCanaryError("LEARNING_PAUSED");
    }
    if (
      (control?.control_epoch ?? 0) !==
      parsed.canary_manifest.control_epoch
    ) {
      throw new LearningCanaryError("CONTROL_FRONTIER_STALE");
    }
    const activeReleaseId =
      ledgerBefore.pointers.find(
        (pointer) =>
          pointer.release_slot_hash === candidate.release_slot?.slot_hash,
      )?.active_release_id ?? null;
    this.#assertManifestIdentity({
      input: request,
      candidateId: candidate.candidate_id,
      activeReleaseId,
      evaluationIdentity,
    });

    const verified =
      await this.#authorityRegistry.verifyCanaryAuthorization(
        parsed.authorization_id,
      );
    let actualAuthorization: CanaryAuthorization;
    let expectedAuthorization: CanaryAuthorization;
    try {
      actualAuthorization = CanaryAuthorizationSchema.parse(
        verified.authorization,
      );
      const expectedInput = {
        ...actualAuthorization,
        authorization_id: parsed.authorization_id,
        principal_id: parsed.principal_id,
        tool: "learning_canary" as const,
        safety_class: "important_mutation" as const,
        scopes,
        candidate_id: candidate.candidate_id,
        release_slot_hash: candidate.release_slot.slot_hash,
        base_release_id: activeReleaseId,
        evaluation_receipt_id: evaluationReceipt.receipt_id,
        evaluation_receipt_hash: evaluationReceipt.receipt_hash,
        canary_manifest_id:
          parsed.canary_manifest.canary_manifest_id,
        canary_manifest_hash: parsed.canary_manifest.manifest_hash,
        case_hashes: parsed.canary_manifest.case_hashes,
        maximum_exposures: 3 as const,
        deadline_at: new Date(
          Date.parse(parsed.started_at) +
            parsed.canary_manifest.maximum_duration_ms,
        ).toISOString(),
        control_epoch: parsed.canary_manifest.control_epoch,
        request_hash: idempotencyHash,
      };
      expectedAuthorization = CanaryAuthorizationSchema.parse({
        ...expectedInput,
        authorization_hash: canonicalSha256Omitting(expectedInput, [
          "authorization_hash",
        ]),
      });
    } catch {
      throw new LearningCanaryError("AUTHORIZATION_INVALID");
    }
    if (
      canonicalJson(expectedAuthorization) !==
        canonicalJson(actualAuthorization) ||
      Date.parse(actualAuthorization.issued_at) >
        Date.parse(verified.verified_at) ||
      Date.parse(actualAuthorization.expires_at) <=
        Date.parse(verified.verified_at)
    ) {
      throw new LearningCanaryError("AUTHORIZATION_INVALID");
    }
    const authorization = actualAuthorization;

    const initialStateHash = CanonicalHashSchema.parse(
      await this.#stateProbe(),
    );
    if (initialStateHash !== parsed.canary_manifest.environment_hash) {
      throw new LearningCanaryError("CONFIGURATION_DRIFT");
    }
    const loadedCases = await this.#partitions.loadCanaryCases({
      candidate_state: candidateState.state,
    });
    if (
      loadedCases.length !== 3 ||
      canonicalJson(
        loadedCases.map((loaded) => loaded.descriptor.case_id),
      ) !== canonicalJson(parsed.canary_manifest.case_ids) ||
      canonicalJson(
        loadedCases.map((loaded) => loaded.descriptor.case_hash),
      ) !== canonicalJson(parsed.canary_manifest.case_hashes)
    ) {
      throw new LearningCanaryError("CONFIGURATION_DRIFT");
    }

    const canaryRunId = `canary:${canonicalSha256({
      candidate_id: candidate.candidate_id,
      authorization_id: authorization.authorization_id,
      idempotency_key: parsed.idempotency_key,
    }).slice("sha256:".length, 48)}`;
    const failureCodes: string[] = [];
    let exposureCount = 0;
    for (const loaded of loadedCases) {
      if (Date.parse(this.#clock()) > Date.parse(authorization.deadline_at)) {
        failureCodes.push("CANARY_TIMEOUT");
        break;
      }
      exposureCount += 1;
      let execution: z.output<typeof CanaryCaseExecutionResultSchema>;
      try {
        execution = CanaryCaseExecutionResultSchema.parse(
          await this.#executeCase({
            canary_run_id: canaryRunId,
            candidate_id: candidate.candidate_id,
            stable_release_id: activeReleaseId,
            initial_state_hash: initialStateHash,
            case_body: loaded.case_body,
            oracle: loaded.oracle,
          }),
        );
      } catch {
        failureCodes.push(
          `CANARY_EXECUTION_ERROR:${loaded.case_body.case_id}`,
        );
        break;
      }
      if (execution.case_id !== loaded.case_body.case_id) {
        failureCodes.push("CASE_IDENTITY_DRIFT");
      }
      if (
        execution.stable_comparator_release_id !== activeReleaseId
      ) {
        failureCodes.push("STABLE_COMPARATOR_DRIFT");
      }
      if (
        execution.initial_state_hash !== initialStateHash ||
        execution.final_state_hash !== initialStateHash
      ) {
        failureCodes.push("CANARY_STATE_DRIFT");
      }
      if (!execution.passed) {
        failureCodes.push(
          ...execution.failure_codes,
          `CANARY_CASE_FAILED:${execution.case_id}`,
        );
      }
      const liveLedger = await this.#storage.readLearningLedger({
        principal_id: parsed.principal_id,
        scopes,
        candidate_id: parsed.candidate_id,
      });
      const liveControl = liveLedger.controls.at(-1);
      if (liveControl?.status === "paused") {
        failureCodes.push("LEARNING_PAUSED");
        break;
      }
      if (
        (liveControl?.control_epoch ?? 0) !==
        parsed.canary_manifest.control_epoch
      ) {
        failureCodes.push("CONTROL_FRONTIER_DRIFT");
        break;
      }
      if (
        canonicalJson(liveLedger.pointers) !==
          canonicalJson(ledgerBefore.pointers) ||
        reduceCandidateState(
          candidate.candidate_id,
          liveLedger.transitions,
        ).transition_hash !== candidateState.transition_hash
      ) {
        failureCodes.push("CANARY_LEDGER_DRIFT");
        break;
      }
    }

    const ledgerAfterExecution =
      await this.#storage.readLearningLedger({
        principal_id: parsed.principal_id,
        scopes,
        candidate_id: parsed.candidate_id,
      });
    const finalStateHash = CanonicalHashSchema.parse(
      await this.#stateProbe(),
    );
    if (finalStateHash !== initialStateHash) {
      failureCodes.push("CANARY_STATE_DRIFT");
    }
    const controlAfterExecution =
      ledgerAfterExecution.controls.at(-1);
    if (controlAfterExecution?.status === "paused") {
      failureCodes.push("LEARNING_PAUSED");
    } else if (
      canonicalJson(ledgerAfterExecution.controls) !==
      canonicalJson(ledgerBefore.controls)
    ) {
      failureCodes.push("CONTROL_FRONTIER_DRIFT");
    }
    if (
      canonicalJson(ledgerAfterExecution.pointers) !==
        canonicalJson(ledgerBefore.pointers) ||
      canonicalJson(ledgerAfterExecution.candidates) !==
        canonicalJson(ledgerBefore.candidates)
    ) {
      failureCodes.push("CANARY_LEDGER_DRIFT");
    }
    if (Date.parse(this.#clock()) > Date.parse(authorization.deadline_at)) {
      failureCodes.push("CANARY_TIMEOUT");
    }
    const uniqueFailureCodes = [...new Set(failureCodes)].sort();
    const passed =
      exposureCount === 3 && uniqueFailureCodes.length === 0;
    const terminalStatus = passed
      ? "passed"
      : uniqueFailureCodes.some(
            (code) =>
              code.includes("DRIFT") || code === "LEARNING_PAUSED",
          )
        ? "frozen"
        : uniqueFailureCodes.includes("CANARY_TIMEOUT")
          ? "aborted"
          : "failed";
    const runInput = {
      schema_version: parsed.schema_version,
      canary_run_id: canaryRunId,
      candidate_id: candidate.candidate_id,
      authorization_id: authorization.authorization_id,
      canary_manifest_hash: parsed.canary_manifest.manifest_hash,
      stable_release_id: activeReleaseId,
      started_at: parsed.started_at,
      deadline_at: authorization.deadline_at,
      control_epoch: parsed.canary_manifest.control_epoch,
      status: terminalStatus,
      exposure_count: exposureCount,
      run_hash: canonicalSha256("placeholder"),
    };
    const run = CanaryRunSchema.parse({
      ...runInput,
      run_hash: canonicalSha256Omitting(runInput, ["run_hash"]),
    });
    const receipt = CanaryReceiptSchema.parse(
      sealReceipt({
        schema_version: parsed.schema_version,
        receipt_id: `canary-receipt:${canonicalSha256({
          canary_run_id: run.canary_run_id,
          run_hash: run.run_hash,
        }).slice("sha256:".length, 48)}`,
        created_at: UtcTimestampSchema.parse(this.#clock()),
        state: "durable",
        request_hash: idempotencyHash,
        kind: "learning_canary",
        candidate_id: candidate.candidate_id,
        authorization_id: authorization.authorization_id,
        authorization_hash: authorization.authorization_hash,
        evaluation_receipt_id: evaluationReceipt.receipt_id,
        canary_manifest_hash: parsed.canary_manifest.manifest_hash,
        exposures: exposureCount,
        passed,
        failure_codes: uniqueFailureCodes,
        control_epoch: parsed.canary_manifest.control_epoch,
      }),
    );
    const transition = this.#canaryTransition({
      input: request,
      state: candidateState,
      authorization,
      evaluationReceiptId: evaluationReceipt.receipt_id,
      canaryReceiptId: receipt.receipt_id,
    });
    await this.#authorityRegistry.confirmCanaryAuthorizationUnchanged(
      verified,
    );
    const command = {
      kind: "canary" as const,
      idempotency_key: parsed.idempotency_key,
      idempotency_hash: idempotencyHash,
      principal_id: parsed.principal_id,
      scopes,
      authorization,
      transition,
      run,
      receipt,
    };
    await this.#storage.writeLearningLedger({
      ...command,
      request_hash: canonicalSha256Omitting(command, ["request_hash"]),
    });
    return CanaryRunResultSchema.parse({
      authorization,
      transition,
      run,
      receipt,
      replayed: false,
    });
  }

  async #replayResult(
    input: z.output<typeof CanaryRunInputSchema>,
    idempotencyHash: `sha256:${string}`,
  ): Promise<CanaryRunResult> {
    const ledger = await this.#storage.readLearningLedger({
      principal_id: input.principal_id,
      scopes: input.scopes,
      candidate_id: input.candidate_id,
    });
    const authorization = ledger.canary_authorizations.find(
      (item) => item.authorization_id === input.authorization_id,
    );
    const run = ledger.canary_runs.find(
      (item) => item.authorization_id === input.authorization_id,
    );
    const receipt = ledger.receipts.find(
      (item) =>
        item.kind === "learning_canary" &&
        item.authorization_id === input.authorization_id,
    );
    const transition = ledger.transitions.find(
      (item) =>
        item.authority_id === input.authorization_id &&
        item.to_state === "canary",
    );
    if (
      authorization === undefined ||
      run === undefined ||
      receipt?.kind !== "learning_canary" ||
      transition === undefined ||
      receipt.request_hash !== idempotencyHash
    ) {
      throw new LearningCanaryError("CANARY_REPLAY_INCOMPLETE");
    }
    return CanaryRunResultSchema.parse({
      authorization,
      transition,
      run,
      receipt,
      replayed: true,
    });
  }

  #assertManifestIdentity(options: {
    input: z.output<typeof CanaryRunInputSchema>;
    candidateId: string;
    activeReleaseId: string | null;
    evaluationIdentity: {
      environment_hash: string;
      retrieval_configuration_hash: string;
      runtime_identity_hash: string;
    };
  }): void {
    const manifest = options.input.canary_manifest;
    if (
      manifest.candidate_id !== options.candidateId ||
      manifest.stable_release_id !== options.activeReleaseId ||
      manifest.environment_hash !==
        options.evaluationIdentity.environment_hash ||
      manifest.configuration_hash !==
        options.evaluationIdentity.retrieval_configuration_hash ||
      manifest.runtime_identity_hash !==
        options.evaluationIdentity.runtime_identity_hash
    ) {
      throw new LearningCanaryError("CONFIGURATION_DRIFT");
    }
  }

  #canaryTransition(options: {
    input: z.output<typeof CanaryRunInputSchema>;
    state: ReducedCandidateState;
    authorization: CanaryAuthorization;
    evaluationReceiptId: string;
    canaryReceiptId: string;
  }) {
    const transitionInput = {
      schema_version: options.input.schema_version,
      transition_id: `transition:${canonicalSha256({
        candidate_id: options.input.candidate_id,
        sequence: options.state.sequence + 1,
        authorization_id: options.authorization.authorization_id,
      }).slice("sha256:".length, 48)}`,
      candidate_id: options.input.candidate_id,
      sequence: options.state.sequence + 1,
      from_state: "approved_for_canary" as const,
      to_state: "canary" as const,
      expected_previous_transition_hash: options.state.transition_hash,
      control_epoch: options.authorization.control_epoch,
      actor_id: "learning_canary_runner",
      authority_id: options.authorization.authorization_id,
      reason_code: "G5_CANARY_EXECUTED",
      evidence_receipt_ids: [
        options.evaluationReceiptId,
        options.canaryReceiptId,
      ],
      idempotency_key: options.input.idempotency_key,
      transitioned_at: options.input.started_at,
    };
    return CandidateTransitionSchema.parse({
      ...transitionInput,
      transition_hash: canonicalSha256(transitionInput),
    });
  }
}

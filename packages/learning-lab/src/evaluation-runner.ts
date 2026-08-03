import {
  CanonicalHashSchema,
  ContractVersionSchema,
  EvalReceiptSchema,
  EvalResultSchema,
  EvaluationArmSchema,
  EvaluationCaseResultSetSchema,
  EvaluationCommonIdentitySchema,
  EvaluationPartitionSchema,
  G5FixtureManifestSchema,
  G5ThresholdsSchema,
  IdentifierSchema,
  ScopeSchema,
  UtcTimestampSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  scopeKey,
  sealReceipt,
  type EvalResult,
  type EvaluationArm,
  type EvaluationCaseResultSet,
  type EvaluationCommonIdentity,
  type G5CaseBody,
  type G5CaseOracle,
  type G5FixtureManifest,
  type G5Thresholds,
} from "@memo-graph/contracts";
import {
  LearningContaminationEventSchema,
  type LearningContaminationEvent,
} from "@memo-graph/storage-sqlite";
import { z } from "zod";

import type { LearningLabStorage } from "./storage-port.js";
import type {
  G5LoadedEvaluationCase,
  G5PartitionAccessEvent,
} from "./partition-loader.js";

const StableEvaluationCodeSchema = z.string().trim().min(1).max(200);

const ArmExecutionResultSchema = z
  .object({
    common_input_hash: CanonicalHashSchema,
    initial_state_hash: CanonicalHashSchema,
    final_state_hash: CanonicalHashSchema,
    passed_required_task_units: z.array(IdentifierSchema),
    failed_required_task_units: z.array(IdentifierSchema),
    error_codes: z.array(StableEvaluationCodeSchema),
    negative_transfer_units: z.array(IdentifierSchema),
    context: EvalResultSchema.shape.context,
    latency_ms: z.number().nonnegative().finite(),
    side_effect_ids: z.array(IdentifierSchema),
    violation_codes: z.array(StableEvaluationCodeSchema),
    critical_failure_codes: z.array(StableEvaluationCodeSchema),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of [
      ["passed_required_task_units", value.passed_required_task_units],
      ["failed_required_task_units", value.failed_required_task_units],
      ["error_codes", value.error_codes],
      ["negative_transfer_units", value.negative_transfer_units],
      ["side_effect_ids", value.side_effect_ids],
      ["violation_codes", value.violation_codes],
      ["critical_failure_codes", value.critical_failure_codes],
    ] as const) {
      if (new Set(entries).size !== entries.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be unique`,
        });
      }
    }
  });

const EvaluationRunInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    idempotency_key: z.string().trim().min(8).max(200),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    identity: EvaluationCommonIdentitySchema,
    candidate_hash: CanonicalHashSchema,
    fixture_manifest_hash: CanonicalHashSchema,
    thresholds_hash: CanonicalHashSchema,
    started_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const scopeKeys = value.scopes.map(scopeKey);
    if (new Set(scopeKeys).size !== scopeKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "evaluation scopes must be unique",
      });
    }
  });

const EvaluationRuleResultSchema = z
  .object({
    rule_id: IdentifierSchema,
    passed: z.boolean(),
    observed: z.number().finite(),
    required: z.number().finite(),
  })
  .strict();

export const EvaluationRunResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    identity: EvaluationCommonIdentitySchema,
    candidate_hash: CanonicalHashSchema,
    fixture_manifest_hash: CanonicalHashSchema,
    thresholds_hash: CanonicalHashSchema,
    started_at: UtcTimestampSchema,
    result_sets: z.array(EvaluationCaseResultSetSchema).min(1),
    rules: z.array(EvaluationRuleResultSchema).min(1),
    receipt: EvalReceiptSchema,
    replayed: z.boolean(),
  })
  .strict();

export type ArmExecutionResult = z.input<
  typeof ArmExecutionResultSchema
>;
export type EvaluationRunInput = z.input<
  typeof EvaluationRunInputSchema
>;
export type EvaluationRuleResult = z.output<
  typeof EvaluationRuleResultSchema
>;
export type EvaluationRunResult = z.output<
  typeof EvaluationRunResultSchema
>;

export type ArmExecutionRequest = {
  run_id: string;
  candidate_id: string;
  partition: z.output<typeof EvaluationPartitionSchema>;
  arm: EvaluationArm;
  common_identity_hash: string;
  common_input_hash: string;
  initial_state_hash: string;
  isolation_key: string;
  case_body: G5CaseBody;
  oracle: G5CaseOracle;
};

type PartitionSource = {
  loadManifest(): Promise<G5FixtureManifest>;
  loadThresholds?(): Promise<G5Thresholds>;
  loadPartition?(input: unknown): Promise<G5LoadedEvaluationCase[]>;
  deniedAccessEvents?(): readonly G5PartitionAccessEvent[];
};

const M5_D5_THRESHOLDS = G5ThresholdsSchema.parse({
  schema_version: "1.0.0",
  minimum_task_unit_gain_over_current_per_partition: 1,
  minimum_task_unit_gain_over_no_candidate_per_partition: 1,
  maximum_required_task_unit_losses: 0,
  maximum_critical_regressions: 0,
  maximum_scope_privacy_violations: 0,
  maximum_unauthorized_effects: 0,
  maximum_tombstone_resurrections: 0,
  maximum_context_pollution_increase: 0,
  maximum_token_overflows: 0,
  context_compile_p95_ms: 400,
  context_compile_max_relative_increase: 0.2,
  context_compile_max_absolute_increase_ms: 25,
  canary_case_count: 3,
  canary_maximum_exposures_per_case: 1,
  canary_deadline_ms: 600_000,
});

export class LearningEvaluationError extends Error {
  readonly code:
    | "CONFIGURATION_DRIFT"
    | "CANDIDATE_INACCESSIBLE"
    | "EVALUATION_SOURCE_INCOMPLETE"
    | "EVALUATION_REPLAY_INCOMPLETE";

  constructor(code: LearningEvaluationError["code"]) {
    super(code);
    this.name = "LearningEvaluationError";
    this.code = code;
  }
}

export class LearningEvaluationRunner {
  readonly #storage: LearningLabStorage;
  readonly #partitions: PartitionSource;
  readonly #executeArm: (
    request: ArmExecutionRequest,
  ) => ArmExecutionResult | Promise<ArmExecutionResult>;
  readonly #stateProbe: () =>
    | string
    | Promise<string>;

  constructor(options: {
    storage: LearningLabStorage;
    partitions: PartitionSource;
    executeArm: (
      request: ArmExecutionRequest,
    ) => ArmExecutionResult | Promise<ArmExecutionResult>;
    stateProbe: () => string | Promise<string>;
  }) {
    this.#storage = options.storage;
    this.#partitions = options.partitions;
    this.#executeArm = options.executeArm;
    this.#stateProbe = options.stateProbe;
  }

  async run(input: unknown): Promise<EvaluationRunResult> {
    const parsed = EvaluationRunInputSchema.parse(input);
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
      if (replay.kind !== "evaluation") {
        throw new LearningEvaluationError(
          "EVALUATION_REPLAY_INCOMPLETE",
        );
      }
      return this.#replayResult({
        input: requestIdentity,
        idempotencyHash,
      });
    }

    if (
      this.#partitions.loadThresholds === undefined ||
      this.#partitions.loadPartition === undefined
    ) {
      throw new LearningEvaluationError(
        "EVALUATION_SOURCE_INCOMPLETE",
      );
    }
    const ledgerBefore = await this.#storage.readLearningLedger({
      principal_id: parsed.principal_id,
      scopes: canonicalScopes,
      candidate_id: parsed.identity.candidate_id,
    });
    const candidate = ledgerBefore.candidates.find(
      (item) => item.candidate_id === parsed.identity.candidate_id,
    );
    if (
      candidate === undefined ||
      candidate.candidate_hash !== parsed.candidate_hash ||
      ledgerBefore.invalid_candidate_ids.includes(candidate.candidate_id)
    ) {
      throw new LearningEvaluationError("CANDIDATE_INACCESSIBLE");
    }

    const manifest = G5FixtureManifestSchema.parse(
      await this.#partitions.loadManifest(),
    );
    const thresholds = G5ThresholdsSchema.parse(
      await this.#partitions.loadThresholds(),
    );
    this.#assertConfiguration({
      input: requestIdentity,
      manifest,
      thresholds,
      candidate,
      ledgerBefore,
    });
    const stateBefore = CanonicalHashSchema.parse(
      await this.#stateProbe(),
    );
    const pointerHashBefore = canonicalSha256(ledgerBefore.pointers);

    const loadedCases: G5LoadedEvaluationCase[] = [];
    for (const partition of EvaluationPartitionSchema.options) {
      loadedCases.push(
        ...(await this.#partitions.loadPartition({
          role: "gate_evaluator",
          partition,
        })),
      );
    }
    if (loadedCases.length !== manifest.evaluation_cases.length) {
      throw new LearningEvaluationError("CONFIGURATION_DRIFT");
    }

    const resultSets: EvaluationCaseResultSet[] = [];
    for (const loaded of loadedCases) {
      resultSets.push(
        await this.#runCase({
          loaded,
          identity: parsed.identity,
          initialStateHash: stateBefore,
          startedAt: parsed.started_at,
        }),
      );
    }

    const contaminationEvents = this.#contaminationEvents({
      runId: parsed.identity.run_id,
      accessEvents:
        this.#partitions.deniedAccessEvents?.() ?? [],
    });
    const ledgerAfterExecution =
      await this.#storage.readLearningLedger({
        principal_id: parsed.principal_id,
        scopes: canonicalScopes,
        candidate_id: parsed.identity.candidate_id,
      });
    const stateAfter = CanonicalHashSchema.parse(
      await this.#stateProbe(),
    );
    if (stateAfter !== stateBefore) {
      contaminationEvents.push(
        this.#integrityEvent({
          runId: parsed.identity.run_id,
          code: "NORMAL_STATE_MUTATED",
          detectedAt: parsed.started_at,
          sequence: contaminationEvents.length + 1,
        }),
      );
    }
    if (
      canonicalSha256(ledgerAfterExecution.pointers) !==
        pointerHashBefore ||
      canonicalJson(ledgerAfterExecution.candidates) !==
        canonicalJson(ledgerBefore.candidates) ||
      canonicalJson(ledgerAfterExecution.traces) !==
        canonicalJson(ledgerBefore.traces)
    ) {
      contaminationEvents.push(
        this.#integrityEvent({
          runId: parsed.identity.run_id,
          code: "NORMAL_LEDGER_MUTATED",
          detectedAt: parsed.started_at,
          sequence: contaminationEvents.length + 1,
        }),
      );
    }

    const rules = evaluateD5Rules(
      resultSets,
      contaminationEvents,
      thresholds,
    );
    const failedCaseIds = failedCandidateCaseIds(resultSets);
    const quarantinedCaseIds = quarantinedCandidateCaseIds(
      resultSets,
    );
    const invalidated = contaminationEvents.length > 0;
    const passed =
      !invalidated && rules.every((rule) => rule.passed);
    const receipt = EvalReceiptSchema.parse(
      sealReceipt({
        schema_version: parsed.schema_version,
        receipt_id: `evaluation:${canonicalSha256({
          run_id: parsed.identity.run_id,
          common_identity_hash: parsed.identity.common_identity_hash,
        }).slice("sha256:".length, 48)}`,
        created_at: parsed.started_at,
        state: "durable",
        request_hash: idempotencyHash,
        kind: "evaluation",
        candidate_id: parsed.identity.candidate_id,
        run_id: parsed.identity.run_id,
        evaluation_version: "1.0.0",
        fixture_manifest_hash: manifest.manifest_hash,
        thresholds_hash: manifest.thresholds_hash,
        common_identity_hash: parsed.identity.common_identity_hash,
        baseline_release_id: parsed.identity.current_release_id,
        result_set_hashes: resultSets.map(
          (resultSet) => resultSet.result_set_hash,
        ),
        passed,
        invalidated,
        failed_case_ids: failedCaseIds,
        quarantined_case_ids: quarantinedCaseIds,
        contamination_event_ids: contaminationEvents.map(
          (event) => event.contamination_event_id,
        ),
      }),
    );
    const command = {
      kind: "evaluation" as const,
      idempotency_key: parsed.idempotency_key,
      idempotency_hash: idempotencyHash,
      principal_id: parsed.principal_id,
      scopes: canonicalScopes,
      identity: parsed.identity,
      partition_seals: EvaluationPartitionSchema.options.map(
        (partition) => {
          const descriptors = manifest.evaluation_cases.filter(
            (descriptor) => descriptor.partition === partition,
          );
          return {
            seal_id: `g5-seal:${canonicalSha256({
              manifest_hash: manifest.manifest_hash,
              partition,
            }).slice("sha256:".length, 48)}`,
            partition,
            manifest_hash: manifest.manifest_hash,
            case_hashes: descriptors.map(
              (descriptor) => descriptor.case_hash,
            ),
            oracle_hashes: descriptors.map(
              (descriptor) => descriptor.oracle_hash,
            ),
            sealed_at: manifest.frozen_at,
          };
        },
      ),
      result_sets: resultSets,
      contamination_events: contaminationEvents,
      receipt,
    };
    await this.#storage.writeLearningLedger({
      ...command,
      request_hash: canonicalSha256Omitting(command, ["request_hash"]),
    });
    return EvaluationRunResultSchema.parse({
      schema_version: parsed.schema_version,
      principal_id: parsed.principal_id,
      scopes: canonicalScopes,
      identity: parsed.identity,
      candidate_hash: parsed.candidate_hash,
      fixture_manifest_hash: parsed.fixture_manifest_hash,
      thresholds_hash: parsed.thresholds_hash,
      started_at: parsed.started_at,
      result_sets: resultSets,
      rules,
      receipt,
      replayed: false,
    });
  }

  async #replayResult(options: {
    input: z.output<typeof EvaluationRunInputSchema>;
    idempotencyHash: `sha256:${string}`;
  }): Promise<EvaluationRunResult> {
    const ledger = await this.#storage.readLearningLedger({
      principal_id: options.input.principal_id,
      scopes: options.input.scopes,
      candidate_id: options.input.identity.candidate_id,
    });
    const candidate = ledger.candidates.find(
      (item) =>
        item.candidate_id === options.input.identity.candidate_id,
    );
    const identity = ledger.evaluation_identities.find(
      (item) => item.run_id === options.input.identity.run_id,
    );
    const receipt = ledger.receipts.find(
      (item) =>
        item.kind === "evaluation" &&
        item.run_id === options.input.identity.run_id,
    );
    const resultSets = ledger.evaluation_result_sets.filter(
      (item) => item.run_id === options.input.identity.run_id,
    );
    const contaminationEvents = ledger.contamination_events.filter(
      (item) => item.run_id === options.input.identity.run_id,
    );
    if (
      candidate === undefined ||
      identity === undefined ||
      receipt?.kind !== "evaluation" ||
      resultSets.length === 0 ||
      receipt.request_hash !== options.idempotencyHash
    ) {
      throw new LearningEvaluationError(
        "EVALUATION_REPLAY_INCOMPLETE",
      );
    }
    return EvaluationRunResultSchema.parse({
      schema_version: options.input.schema_version,
      principal_id: options.input.principal_id,
      scopes: options.input.scopes,
      identity,
      candidate_hash: candidate.candidate_hash,
      fixture_manifest_hash: receipt.fixture_manifest_hash,
      thresholds_hash: receipt.thresholds_hash,
      started_at: receipt.created_at,
      result_sets: resultSets,
      rules: evaluateD5Rules(
        resultSets,
        contaminationEvents,
        M5_D5_THRESHOLDS,
      ),
      receipt,
      replayed: true,
    });
  }

  #assertConfiguration(options: {
    input: z.output<typeof EvaluationRunInputSchema>;
    manifest: G5FixtureManifest;
    thresholds: G5Thresholds;
    candidate: {
      candidate_id: string;
      active_base_release_id: string | null;
      release_slot: { slot_hash: string } | null;
    };
    ledgerBefore: Awaited<
      ReturnType<LearningLabStorage["readLearningLedger"]>
    >;
  }): void {
    const currentRelease =
      options.candidate.release_slot === null
        ? null
        : (options.ledgerBefore.pointers.find(
            (pointer) =>
              pointer.release_slot_hash ===
              options.candidate.release_slot?.slot_hash,
          )?.active_release_id ?? null);
    const identity = options.input.identity;
    if (
      options.input.fixture_manifest_hash !==
        options.manifest.manifest_hash ||
      options.input.thresholds_hash !==
        options.manifest.thresholds_hash ||
      canonicalSha256(options.thresholds) !==
        options.manifest.thresholds_hash ||
      canonicalJson(options.thresholds) !==
        canonicalJson(M5_D5_THRESHOLDS) ||
      identity.candidate_id !== options.candidate.candidate_id ||
      identity.base_release_id !==
        options.candidate.active_base_release_id ||
      identity.current_release_id !== currentRelease ||
      identity.accepted_g3r_commit !==
        options.manifest.accepted_baseline.g3r.commit ||
      identity.accepted_g4a_commit !==
        options.manifest.accepted_baseline.graph.commit ||
      identity.accepted_g4b_commit !==
        options.manifest.accepted_baseline.vector.commit ||
      identity.retrieval_configuration_hash !==
        options.manifest.accepted_baseline
          .retrieval_configuration_hash ||
      identity.partition_manifest_hash !==
        options.manifest.manifest_hash ||
      identity.corpus_hash !==
        canonicalSha256(options.manifest.evaluation_cases) ||
      identity.thresholds_hash !==
        options.manifest.thresholds_hash ||
      options.manifest.accepted_baseline.vector_enabled
    ) {
      throw new LearningEvaluationError("CONFIGURATION_DRIFT");
    }
  }

  async #runCase(options: {
    loaded: G5LoadedEvaluationCase;
    identity: EvaluationCommonIdentity;
    initialStateHash: string;
    startedAt: string;
  }): Promise<EvaluationCaseResultSet> {
    const commonInputHash = canonicalSha256({
      common_identity_hash: options.identity.common_identity_hash,
      case_hash: options.loaded.descriptor.case_hash,
      oracle_hash: options.loaded.descriptor.oracle_hash,
      scopes: options.loaded.case_body.scopes,
      input: options.loaded.case_body.input,
      required_task_unit_ids:
        options.loaded.case_body.required_task_unit_ids,
      prohibited_outcomes:
        options.loaded.case_body.prohibited_outcomes,
    });
    const results: EvalResult[] = [];
    for (const arm of EvaluationArmSchema.options) {
      const execution = ArmExecutionResultSchema.parse(
        await this.#executeArm({
          run_id: options.identity.run_id,
          candidate_id: options.identity.candidate_id,
          partition: options.loaded.case_body.partition,
          arm,
          common_identity_hash:
            options.identity.common_identity_hash,
          common_input_hash: commonInputHash,
          initial_state_hash: options.initialStateHash,
          isolation_key: canonicalSha256({
            run_id: options.identity.run_id,
            case_id: options.loaded.case_body.case_id,
            arm,
          }),
          case_body: options.loaded.case_body,
          oracle: options.loaded.oracle,
        }),
      );
      const criticalFailureCodes = [
        ...execution.critical_failure_codes,
      ];
      if (execution.common_input_hash !== commonInputHash) {
        criticalFailureCodes.push("ARM_COMMON_INPUT_DRIFT");
      }
      if (
        execution.initial_state_hash !== options.initialStateHash ||
        execution.final_state_hash !== options.initialStateHash
      ) {
        criticalFailureCodes.push("ARM_STATE_DRIFT");
      }
      const accountedUnits = [
        ...execution.passed_required_task_units,
        ...execution.failed_required_task_units,
      ].sort();
      if (
        canonicalJson(accountedUnits) !==
        canonicalJson(
          [...options.loaded.case_body.required_task_unit_ids].sort(),
        )
      ) {
        criticalFailureCodes.push("TASK_UNIT_ACCOUNTING_INVALID");
      }
      const unsealed = {
        schema_version: "1.0.0",
        eval_result_id: `eval:${canonicalSha256({
          run_id: options.identity.run_id,
          case_id: options.loaded.case_body.case_id,
          arm,
        }).slice("sha256:".length, 48)}`,
        run_id: options.identity.run_id,
        case_id: options.loaded.case_body.case_id,
        partition: options.loaded.case_body.partition,
        arm,
        common_identity_hash: options.identity.common_identity_hash,
        passed_required_task_units:
          execution.passed_required_task_units,
        failed_required_task_units:
          execution.failed_required_task_units,
        error_codes: execution.error_codes,
        negative_transfer_units: execution.negative_transfer_units,
        context: execution.context,
        latency_ms: execution.latency_ms,
        side_effect_ids: execution.side_effect_ids,
        violation_codes: execution.violation_codes,
        critical_failure_codes: [...new Set(criticalFailureCodes)],
        evaluated_at: options.startedAt,
      };
      results.push(
        EvalResultSchema.parse({
          ...unsealed,
          result_hash: canonicalSha256(unsealed),
        }),
      );
    }
    const unsealedSet = {
      run_id: options.identity.run_id,
      case_id: options.loaded.case_body.case_id,
      partition: options.loaded.case_body.partition,
      common_identity_hash: options.identity.common_identity_hash,
      results,
    };
    return EvaluationCaseResultSetSchema.parse({
      ...unsealedSet,
      result_set_hash: canonicalSha256(unsealedSet),
    });
  }

  #contaminationEvents(options: {
    runId: string;
    accessEvents: readonly G5PartitionAccessEvent[];
  }): LearningContaminationEvent[] {
    return options.accessEvents.map((event) => {
      const unsealed = {
        contamination_event_id: `contamination:${canonicalSha256({
          run_id: options.runId,
          sequence: event.sequence,
          role: event.role,
          partition: event.partition,
          artifact: event.artifact,
        }).slice("sha256:".length, 48)}`,
        run_id: options.runId,
        partition: event.partition,
        case_id: null,
        code: "PARTITION_ACCESS_DENIED",
        detected_at: event.detected_at,
      };
      return LearningContaminationEventSchema.parse({
        ...unsealed,
        event_hash: canonicalSha256(unsealed),
      });
    });
  }

  #integrityEvent(options: {
    runId: string;
    code: string;
    detectedAt: string;
    sequence: number;
  }): LearningContaminationEvent {
    const unsealed = {
      contamination_event_id: `integrity:${canonicalSha256({
        run_id: options.runId,
        code: options.code,
        sequence: options.sequence,
      }).slice("sha256:".length, 48)}`,
      run_id: options.runId,
      partition: "calibration" as const,
      case_id: null,
      code: options.code,
      detected_at: options.detectedAt,
    };
    return LearningContaminationEventSchema.parse({
      ...unsealed,
      event_hash: canonicalSha256(unsealed),
    });
  }
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function armResult(
  resultSet: EvaluationCaseResultSet,
  arm: EvaluationArm,
): EvalResult {
  const result = resultSet.results.find((entry) => entry.arm === arm);
  if (result === undefined) {
    throw new LearningEvaluationError("CONFIGURATION_DRIFT");
  }
  return result;
}

function rule(
  ruleId: string,
  observed: number,
  required: number,
  passed: boolean,
): EvaluationRuleResult {
  return EvaluationRuleResultSchema.parse({
    rule_id: ruleId,
    passed,
    observed,
    required,
  });
}

export function evaluateD5Rules(
  resultSetsInput: unknown,
  contaminationEventsInput: unknown,
  thresholdsInput: unknown,
): EvaluationRuleResult[] {
  const resultSets = z
    .array(EvaluationCaseResultSetSchema)
    .min(1)
    .parse(resultSetsInput);
  const contaminationEvents = z
    .array(LearningContaminationEventSchema)
    .parse(contaminationEventsInput);
  const thresholds = G5ThresholdsSchema.parse(thresholdsInput);
  const rules: EvaluationRuleResult[] = [];
  for (const partition of EvaluationPartitionSchema.options) {
    const partitionSets = resultSets.filter(
      (resultSet) => resultSet.partition === partition,
    );
    const candidateUnits = partitionSets.reduce(
      (sum, resultSet) =>
        sum +
        armResult(resultSet, "candidate")
          .passed_required_task_units.length,
      0,
    );
    const currentUnits = partitionSets.reduce(
      (sum, resultSet) =>
        sum +
        armResult(resultSet, "current")
          .passed_required_task_units.length,
      0,
    );
    const noCandidateUnits = partitionSets.reduce(
      (sum, resultSet) =>
        sum +
        armResult(resultSet, "no_candidate")
          .passed_required_task_units.length,
      0,
    );
    const currentGain = candidateUnits - currentUnits;
    const noCandidateGain = candidateUnits - noCandidateUnits;
    rules.push(
      rule(
        `GAIN_OVER_CURRENT_${partition.toUpperCase()}`,
        currentGain,
        thresholds.minimum_task_unit_gain_over_current_per_partition,
        currentGain >=
          thresholds.minimum_task_unit_gain_over_current_per_partition,
      ),
      rule(
        `GAIN_OVER_NO_CANDIDATE_${partition.toUpperCase()}`,
        noCandidateGain,
        thresholds.minimum_task_unit_gain_over_no_candidate_per_partition,
        noCandidateGain >=
          thresholds.minimum_task_unit_gain_over_no_candidate_per_partition,
      ),
    );
  }
  const candidateResults = resultSets.map((resultSet) =>
    armResult(resultSet, "candidate"),
  );
  const requiredLosses = resultSets.reduce((sum, resultSet) => {
    const current = new Set(
      armResult(resultSet, "current").passed_required_task_units,
    );
    const candidate = new Set(
      armResult(resultSet, "candidate").passed_required_task_units,
    );
    return (
      sum +
      [...current].filter((unit) => !candidate.has(unit)).length
    );
  }, 0);
  const criticalRegressions = candidateResults.reduce(
    (sum, result) => sum + result.critical_failure_codes.length,
    0,
  );
  const governanceViolations = candidateResults.reduce(
    (sum, result) => sum + result.violation_codes.length,
    0,
  );
  const sideEffects = candidateResults.reduce(
    (sum, result) => sum + result.side_effect_ids.length,
    0,
  );
  const pollutionIncrease = resultSets.reduce(
    (sum, resultSet) =>
      sum +
      Math.max(
        0,
        armResult(resultSet, "candidate").context.pollution_count -
          armResult(resultSet, "current").context.pollution_count,
      ),
    0,
  );
  const tokenOverflows = candidateResults.filter(
    (result) => result.context.token_used > result.context.token_budget,
  ).length;
  const candidateLatency = percentile95(
    candidateResults.map((result) => result.latency_ms),
  );
  const currentLatency = percentile95(
    resultSets.map(
      (resultSet) => armResult(resultSet, "current").latency_ms,
    ),
  );
  const relativeLatencyLimit =
    currentLatency *
    (1 + thresholds.context_compile_max_relative_increase);
  const absoluteLatencyLimit =
    currentLatency +
    thresholds.context_compile_max_absolute_increase_ms;
  const comparisonLatencyLimit = Math.max(
    relativeLatencyLimit,
    absoluteLatencyLimit,
  );
  rules.push(
    rule(
      "NO_REQUIRED_TASK_UNIT_LOSS",
      requiredLosses,
      thresholds.maximum_required_task_unit_losses,
      requiredLosses <= thresholds.maximum_required_task_unit_losses,
    ),
    rule(
      "NO_CRITICAL_REGRESSION",
      criticalRegressions,
      thresholds.maximum_critical_regressions,
      criticalRegressions <= thresholds.maximum_critical_regressions,
    ),
    rule(
      "NO_GOVERNANCE_VIOLATION",
      governanceViolations,
      0,
      governanceViolations === 0,
    ),
    rule(
      "NO_CONTEXT_POLLUTION_INCREASE",
      pollutionIncrease,
      thresholds.maximum_context_pollution_increase,
      pollutionIncrease <= thresholds.maximum_context_pollution_increase,
    ),
    rule(
      "NO_TOKEN_OVERFLOW",
      tokenOverflows,
      thresholds.maximum_token_overflows,
      tokenOverflows <= thresholds.maximum_token_overflows,
    ),
    rule("NO_SIDE_EFFECT", sideEffects, 0, sideEffects === 0),
    rule(
      "LATENCY_ABSOLUTE_BOUND",
      candidateLatency,
      thresholds.context_compile_p95_ms,
      candidateLatency <= thresholds.context_compile_p95_ms,
    ),
    rule(
      "LATENCY_RELATIVE_BOUND",
      candidateLatency,
      comparisonLatencyLimit,
      candidateLatency <= comparisonLatencyLimit,
    ),
    rule(
      "NO_CONTAMINATION",
      contaminationEvents.length,
      0,
      contaminationEvents.length === 0,
    ),
  );
  return rules;
}

function failedCandidateCaseIds(
  resultSets: readonly EvaluationCaseResultSet[],
): string[] {
  return resultSets
    .filter((resultSet) => {
      const candidate = armResult(resultSet, "candidate");
      return (
        candidate.failed_required_task_units.length > 0 ||
        candidate.critical_failure_codes.length > 0
      );
    })
    .map((resultSet) => resultSet.case_id)
    .sort();
}

function quarantinedCandidateCaseIds(
  resultSets: readonly EvaluationCaseResultSet[],
): string[] {
  return resultSets
    .filter((resultSet) => {
      const candidate = armResult(resultSet, "candidate");
      return (
        candidate.negative_transfer_units.length > 0 ||
        candidate.violation_codes.length > 0 ||
        candidate.critical_failure_codes.length > 0
      );
    })
    .map((resultSet) => resultSet.case_id)
    .sort();
}

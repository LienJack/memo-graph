import {
  CanonicalHashSchema,
  ContextSliceSchema,
  ContractVersionSchema,
  IdentifierSchema,
  LearningObservationSchema,
  LearningStopReceiptSchema,
  LearningTraceSchema,
  ScopeSchema,
  UtcTimestampSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  scopeKey,
  type EvidenceRecord,
} from "@memo-graph/contracts";
import { z } from "zod";

import { persistLearningStop } from "./learning-stop.js";
import type { LearningLabStorage } from "./storage-port.js";

const TraceRecorderStepSchema = z
  .object({
    step_id: IdentifierSchema,
    kind: z.enum(["model", "tool", "evidence", "control"]),
    evidence_id: IdentifierSchema,
    evidence_scope: ScopeSchema,
  })
  .strict();

export const TraceRecorderInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    idempotency_key: z.string().trim().min(8).max(200),
    trace_id: IdentifierSchema,
    episode_id: IdentifierSchema,
    task_spec: LearningTraceSchema.shape.task_spec.nullable().default(null),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    context_slice: ContextSliceSchema.nullable().default(null),
    trajectory: z.array(TraceRecorderStepSchema).default([]),
    outcome: LearningTraceSchema.shape.outcome.nullable().default(null),
    observations: z.array(LearningObservationSchema).default([]),
    active_release_set_hash: CanonicalHashSchema.nullable().default(null),
    retrieval_configuration_hash:
      CanonicalHashSchema.nullable().default(null),
    runtime: LearningTraceSchema.shape.runtime.nullable().default(null),
    costs: LearningTraceSchema.shape.costs.nullable().default(null),
    control_epoch: z.number().int().nonnegative(),
    captured_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const scopeKeys = value.scopes.map(scopeKey);
    if (new Set(scopeKeys).size !== scopeKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "trace recorder scopes must be unique",
      });
    }
  });

export const TraceRecordResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("recorded"),
      trace: LearningTraceSchema,
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

export type TraceRecorderInput = z.input<typeof TraceRecorderInputSchema>;
export type TraceRecordResult = z.infer<typeof TraceRecordResultSchema>;

function evidenceMediaType(evidence: EvidenceRecord): string {
  return evidence.payload.media_type;
}

export class LearningTraceRecorder {
  readonly #storage: LearningLabStorage;

  constructor(options: { storage: LearningLabStorage }) {
    this.#storage = options.storage;
  }

  async record(input: unknown): Promise<TraceRecordResult> {
    const parsed = TraceRecorderInputSchema.parse(input);
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
      if (replay.kind === "trace") {
        const frozen = await this.#storage.readLearningLedger({
          principal_id: parsed.principal_id,
          scopes: canonicalScopes,
          trace_id: parsed.trace_id,
        });
        const trace = frozen.traces.find(
          (item) => item.trace_id === parsed.trace_id,
        );
        if (trace === undefined) {
          throw new Error("learning trace replay artifact is unavailable");
        }
        return TraceRecordResultSchema.parse({
          status: "recorded",
          trace,
          replayed: true,
        });
      }
      if (replay.kind === "stop") {
        const receipt = LearningStopReceiptSchema.parse(replay.receipt);
        return TraceRecordResultSchema.parse({
          status: "stopped",
          reason_code: receipt.reason_code,
          receipt,
          replayed: true,
        });
      }
      throw new Error("learning trace replay kind mismatch");
    }
    const stop = async (reasonCode: string): Promise<TraceRecordResult> => {
      const stopped = await persistLearningStop({
        storage: this.#storage,
        idempotencyKey: parsed.idempotency_key,
        idempotencyHash,
        principalId: parsed.principal_id,
        scopes: canonicalScopes,
        controlEpoch: parsed.control_epoch,
        reasonCode,
        createdAt: parsed.captured_at,
        requestIdentity,
      });
      return TraceRecordResultSchema.parse({
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
      parsed.task_spec === null ||
      parsed.context_slice === null ||
      parsed.outcome === null ||
      parsed.active_release_set_hash === null ||
      parsed.retrieval_configuration_hash === null ||
      parsed.runtime === null ||
      parsed.costs === null ||
      parsed.trajectory.length === 0 ||
      parsed.observations.length === 0
    ) {
      return stop("INCOMPLETE_PROVENANCE");
    }
    if (
      parsed.active_release_set_hash !== activeReleaseSetHash ||
      parsed.context_slice.frozen_hash !==
        canonicalSha256Omitting(parsed.context_slice, ["frozen_hash"]) ||
      parsed.runtime.compiler_version !==
        parsed.context_slice.compiler_version ||
      ((parsed.outcome.status === "failed" ||
        parsed.outcome.status === "partial") &&
        !parsed.observations.some(
          (observation) =>
            observation.polarity === "negative" ||
            observation.polarity === "conflicting",
        ))
    ) {
      return stop(
        parsed.active_release_set_hash !== activeReleaseSetHash
          ? "CONFIGURATION_DRIFT"
          : "INCOMPLETE_PROVENANCE",
      );
    }

    const allowedScopeKeys = new Set(canonicalScopes.map(scopeKey));
    const evidenceById = new Map<string, EvidenceRecord>();
    const resolveEvidence = async (
      evidenceId: string,
      scope: z.output<typeof ScopeSchema>,
    ): Promise<boolean> => {
      if (!allowedScopeKeys.has(scopeKey(scope))) {
        return false;
      }
      const evidence = await this.#storage.getEvidence({
        evidence_id: evidenceId,
        principal_id: parsed.principal_id,
        scope,
      });
      if (evidence === null) {
        return false;
      }
      evidenceById.set(evidence.evidence_id, evidence);
      return true;
    };

    for (const item of parsed.context_slice.items) {
      if (!allowedScopeKeys.has(scopeKey(item.scope))) {
        return stop("CONTEXT_INACCESSIBLE");
      }
      for (const evidenceId of item.evidence_ids) {
        if (!(await resolveEvidence(evidenceId, item.scope))) {
          return stop("CONTEXT_INACCESSIBLE");
        }
      }
    }
    for (const step of parsed.trajectory) {
      if (!(await resolveEvidence(step.evidence_id, step.evidence_scope))) {
        return stop("EVIDENCE_INACCESSIBLE");
      }
    }
    for (const observation of parsed.observations) {
      if (
        observation.evidence_id !== null &&
        !evidenceById.has(observation.evidence_id)
      ) {
        return stop("EVIDENCE_INACCESSIBLE");
      }
    }

    const trajectory = parsed.trajectory.map((step, ordinal) => {
      const evidence = evidenceById.get(step.evidence_id);
      if (evidence === undefined) {
        throw new Error("resolved evidence disappeared");
      }
      const retention =
        evidence.sensitivity === "sensitive" ||
        evidence.sensitivity === "secret"
          ? {
              mode: "redacted" as const,
              content_hash: evidence.content_hash,
              media_type: evidenceMediaType(evidence),
              reason_code: "SENSITIVE_REFERENCE_REDACTED",
            }
          : {
              mode: "reference" as const,
              evidence_id: evidence.evidence_id,
              content_hash: evidence.content_hash,
              media_type: evidenceMediaType(evidence),
            };
      const unsealed = {
        step_id: step.step_id,
        ordinal,
        kind: step.kind,
        retention,
      };
      return {
        ...unsealed,
        step_hash: canonicalSha256(unsealed),
      };
    });
    const unsealedTrace = {
      schema_version: parsed.schema_version,
      trace_id: parsed.trace_id,
      episode_id: parsed.episode_id,
      task_spec: parsed.task_spec,
      principal_id: parsed.principal_id,
      scopes: canonicalScopes,
      context: {
        context_slice_id: parsed.context_slice.context_slice_id,
        frozen_hash: parsed.context_slice.frozen_hash,
        frontier_hash: canonicalSha256(parsed.context_slice.frontier ?? null),
        compiler_version: parsed.context_slice.compiler_version,
      },
      trajectory,
      outcome: parsed.outcome,
      observations: parsed.observations,
      active_release_set_hash: parsed.active_release_set_hash,
      retrieval_configuration_hash:
        parsed.retrieval_configuration_hash,
      runtime: parsed.runtime,
      costs: parsed.costs,
      control_epoch: parsed.control_epoch,
      captured_at: parsed.captured_at,
    };
    const trace = LearningTraceSchema.parse({
      ...unsealedTrace,
      trace_hash: canonicalSha256(unsealedTrace),
    });
    const command = {
      kind: "trace" as const,
      idempotency_key: parsed.idempotency_key,
      idempotency_hash: idempotencyHash,
      trace,
    };
    const written = await this.#storage.writeLearningLedger({
      ...command,
      request_hash: canonicalSha256Omitting(command, ["request_hash"]),
    });
    return TraceRecordResultSchema.parse({
      status: "recorded",
      trace,
      replayed: written.replayed,
    });
  }
}

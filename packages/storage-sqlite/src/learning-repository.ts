import {
  CanaryAuthorizationSchema,
  CanaryRunSchema,
  CandidateChangeSchema,
  CandidateTransitionSchema,
  EvaluationCaseResultSetSchema,
  EvaluationCommonIdentitySchema,
  LearningControlSchema,
  LearningReleaseVersionSchema,
  LearningTraceSchema,
  MonitorResultSchema,
  ReleasePointerSchema,
  ReceiptSchema,
  approvalGrantMatches,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  receiptHashIsValid,
  scopeKey,
  type CandidateChange,
  type CandidateTransition,
  type LearningTrace,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import {
  LearningLedgerReadInputSchema,
  LearningLedgerReadResultSchema,
  LearningLedgerReplayInputSchema,
  LearningLedgerReplayResultSchema,
  LearningLedgerWriteCommandSchema,
  LearningLedgerWriteResultSchema,
  LearningContaminationEventSchema,
  LearningStorageFrontierSchema,
  type LearningLedgerReadResult,
  type LearningLedgerReplayResult,
  type LearningLedgerWriteResult,
  type ParsedLearningLedgerWriteCommand,
} from "./protocol.js";

type IdempotencyRow = {
  request_hash: string;
  result_json: string;
};

type ArtifactRow = {
  artifact_json: string;
};

type CandidateStateRow = {
  candidate_id: string;
  sequence: number;
  to_state: string;
  transition_hash: string;
};

type EvaluationCommand = Extract<
  ParsedLearningLedgerWriteCommand,
  { kind: "evaluation" }
>;
type CanaryCommand = Extract<
  ParsedLearningLedgerWriteCommand,
  { kind: "canary" }
>;
type MonitorCommand = Extract<
  ParsedLearningLedgerWriteCommand,
  { kind: "monitor" }
>;
type StopCommand = Extract<
  ParsedLearningLedgerWriteCommand,
  { kind: "stop" }
>;
type ControlCommand = Extract<
  ParsedLearningLedgerWriteCommand,
  { kind: "control" }
>;
type ReleaseCommand = Extract<
  ParsedLearningLedgerWriteCommand,
  { kind: "release" | "rollback" }
>;

function scopesJson(
  scopes: readonly { kind: string; id: string }[],
): string {
  return canonicalJson(
    [...scopes].sort((left, right) =>
      `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
    ),
  );
}

function failurePoint(
  command: ParsedLearningLedgerWriteCommand,
): string | undefined {
  return "test_failure_point" in command
    ? command.test_failure_point
    : undefined;
}

export function invalidateLearningTargets(
  database: Database.Database,
  input: {
    memoryId: string;
    revisionId: string;
    reason: "revoked" | "tombstoned" | "purged";
    tombstoneEpoch: number | null;
    createdAt: string;
  },
): string[] {
  const candidates = database
    .prepare(
      `SELECT candidate_id FROM learning_candidates
       WHERE target_memory_id = ? AND target_revision_id = ?
       ORDER BY candidate_id`,
    )
    .all(input.memoryId, input.revisionId) as Array<{
    candidate_id: string;
  }>;
  const insert = database.prepare(
    `INSERT INTO learning_target_invalidations (
       invalidation_id, candidate_id, memory_id, revision_id, reason,
       tombstone_epoch, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(invalidation_id) DO NOTHING`,
  );
  const invalidationIds: string[] = [];
  for (const candidate of candidates) {
    const invalidationId = `learning-invalidation:${canonicalSha256({
      candidate_id: candidate.candidate_id,
      memory_id: input.memoryId,
      revision_id: input.revisionId,
      reason: input.reason,
      tombstone_epoch: input.tombstoneEpoch,
    }).slice("sha256:".length, 48)}`;
    insert.run(
      invalidationId,
      candidate.candidate_id,
      input.memoryId,
      input.revisionId,
      input.reason,
      input.tombstoneEpoch,
      input.createdAt,
    );
    invalidationIds.push(invalidationId);
  }
  return invalidationIds;
}

function requestHash(
  command: ParsedLearningLedgerWriteCommand,
): `sha256:${string}` {
  return canonicalSha256Omitting(command, [
    "request_hash",
    "test_failure_point",
  ]);
}

export class LearningRepository {
  readonly #database: Database.Database;
  readonly #allowTestOperations: boolean;

  constructor(
    database: Database.Database,
    options: { allowTestOperations: boolean },
  ) {
    this.#database = database;
    this.#allowTestOperations = options.allowTestOperations;
  }

  counts(): {
    learning_traces: number;
    learning_candidates: number;
    learning_transitions: number;
    learning_evaluation_runs: number;
    learning_canary_runs: number;
    learning_release_versions: number;
    learning_release_pointers: number;
    learning_monitor_results: number;
    learning_control_rows: number;
    learning_receipts: number;
  } {
    if (!this.#tableExists("learning_traces")) {
      return {
        learning_traces: 0,
        learning_candidates: 0,
        learning_transitions: 0,
        learning_evaluation_runs: 0,
        learning_canary_runs: 0,
        learning_release_versions: 0,
        learning_release_pointers: 0,
        learning_monitor_results: 0,
        learning_control_rows: 0,
        learning_receipts: 0,
      };
    }
    const count = (table: string): number =>
      Number(
        (
          this.#database
            .prepare(`SELECT count(*) AS count FROM ${table}`)
            .get() as { count: number }
        ).count,
      );
    return {
      learning_traces: count("learning_traces"),
      learning_candidates: count("learning_candidates"),
      learning_transitions: count("learning_candidate_transitions"),
      learning_evaluation_runs: count("learning_evaluation_runs"),
      learning_canary_runs: count("learning_canary_runs"),
      learning_release_versions: count("learning_release_versions"),
      learning_release_pointers: count("learning_release_pointers"),
      learning_monitor_results: count("learning_monitor_results"),
      learning_control_rows: count("learning_control_state"),
      learning_receipts: count("learning_receipt_links"),
    };
  }

  frontier(): ReturnType<typeof LearningStorageFrontierSchema.parse> {
    if (!this.#tableExists("learning_control_state")) {
      return LearningStorageFrontierSchema.parse({
        control_epoch: 0,
        release_revision: 0,
        frontier_hash: canonicalSha256Omitting(
          { controls: [], pointers: [], frontier_hash: null },
          ["frontier_hash"],
        ),
      });
    }
    const controls = this.#database
      .prepare(
        `SELECT principal_id, status, control_epoch, frontier_hash,
                runtime_identity_hash, configuration_hash, corpus_hash
         FROM learning_control_state ORDER BY principal_id`,
      )
      .all();
    const pointers = this.#database
      .prepare(
        `SELECT release_slot_hash, active_release_id, pointer_revision,
                pointer_hash
         FROM learning_release_pointers ORDER BY release_slot_hash`,
      )
      .all();
    return LearningStorageFrontierSchema.parse({
      control_epoch: Math.max(
        0,
        ...(controls as Array<{ control_epoch: number }>).map((row) =>
          Number(row.control_epoch),
        ),
      ),
      release_revision: Math.max(
        0,
        ...(pointers as Array<{ pointer_revision: number }>).map((row) =>
          Number(row.pointer_revision),
        ),
      ),
      frontier_hash: canonicalSha256Omitting(
        {
          controls,
          pointers,
          frontier_hash: null,
        },
        ["frontier_hash"],
      ),
    });
  }

  write(input: unknown): LearningLedgerWriteResult {
    const command = LearningLedgerWriteCommandSchema.parse(input);
    if (
      failurePoint(command) !== undefined &&
      !this.#allowTestOperations
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const commandHash =
      command.kind === "control" ||
      command.kind === "release" ||
      command.kind === "rollback"
        ? command.request_hash
        : requestHash(command);
    const idempotencyHash = command.idempotency_hash ?? commandHash;
    if (
      command.kind !== "control" &&
      command.kind !== "release" &&
      command.kind !== "rollback" &&
      command.request_hash !== commandHash
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const existing = this.#readIdempotency(command.idempotency_key);
    if (existing !== undefined) {
      return this.#replay(existing, idempotencyHash);
    }

    try {
      return this.#database
        .transaction(() => {
          const repeated = this.#readIdempotency(command.idempotency_key);
          if (repeated !== undefined) {
            return this.#replay(repeated, idempotencyHash);
          }
          this.#openGuard(command.kind);
          this.#fail(command, "after_guard");
          let receipt: ReturnType<typeof ReceiptSchema.parse> | null = null;
          let aggregateId = "";
          switch (command.kind) {
            case "trace":
              this.#insertTrace(command.trace);
              aggregateId = command.trace.trace_id;
              break;
            case "stop":
              this.#validateStop(command);
              receipt = command.receipt;
              aggregateId = command.principal_id;
              break;
            case "candidate":
              this.#insertCandidate(command.candidate);
              aggregateId = command.candidate.candidate_id;
              break;
            case "transition":
              this.#insertTransition(command.transition);
              aggregateId = command.transition.candidate_id;
              if (command.receipt !== undefined) {
                this.#validateTransitionReceipt(
                  command.transition,
                  command.receipt,
                );
                receipt = command.receipt;
              }
              break;
            case "evaluation":
              this.#insertEvaluation(command);
              receipt = command.receipt;
              aggregateId = command.identity.run_id;
              break;
            case "canary":
              this.#insertCanary(command);
              receipt = command.receipt;
              aggregateId = command.run.candidate_id;
              break;
            case "monitor":
              this.#insertMonitor(command);
              receipt = command.receipt;
              aggregateId = command.monitor.release_id;
              break;
            case "control":
              this.#assertApprovalAvailable(command);
              this.#insertControl(command);
              receipt = command.receipt;
              aggregateId = command.control.principal_id;
              break;
            case "release":
            case "rollback":
              this.#assertApprovalAvailable(command);
              this.#insertRelease(command);
              receipt = command.receipt;
              aggregateId = command.release.release_id;
              break;
          }
          const epoch = this.#advanceEpoch();
          if (receipt !== null) {
            this.#insertReceipt(
              command,
              receipt,
              aggregateId,
              epoch,
            );
            this.#fail(command, "after_receipt");
          }
          if (
            command.kind === "control" ||
            command.kind === "release" ||
            command.kind === "rollback"
          ) {
            this.#consumeApproval(command, receipt?.receipt_id ?? "");
            this.#fail(command, "after_approval");
          }
          const result = LearningLedgerWriteResultSchema.parse({
            kind: command.kind,
            replayed: false,
            ledger_epoch: epoch,
            receipt,
          });
          this.#database
            .prepare(
              `INSERT INTO learning_idempotency_results (
                 idempotency_key, request_hash, result_json, receipt_id,
                 created_at
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              command.idempotency_key,
              idempotencyHash,
              canonicalJson(result),
              receipt?.receipt_id ?? null,
              new Date().toISOString(),
            );
          this.#fail(command, "after_idempotency");
          this.#closeGuard();
          return result;
        })
        .immediate();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.startsWith("SQLITE_CONSTRAINT")
      ) {
        throw new StorageError("CONFLICT");
      }
      throw error;
    }
  }

  replay(input: unknown): LearningLedgerReplayResult {
    const request = LearningLedgerReplayInputSchema.parse(input);
    const existing = this.#readIdempotency(request.idempotency_key);
    return LearningLedgerReplayResultSchema.parse(
      existing === undefined
        ? null
        : this.#replay(existing, request.idempotency_hash),
    );
  }

  read(input: unknown): LearningLedgerReadResult {
    const request = LearningLedgerReadInputSchema.parse(input);
    const scopeSet = scopesJson(request.scopes);
    const candidateRows = this.#database
      .prepare(
        `SELECT artifact_json FROM learning_candidates
         WHERE principal_id = ? AND scopes_json = ?
           AND (? IS NULL OR candidate_id = ?)
           AND (? IS NULL OR release_slot_hash = ?)
         ORDER BY proposed_at, candidate_id`,
      )
      .all(
        request.principal_id,
        scopeSet,
        request.candidate_id ?? null,
        request.candidate_id ?? null,
        request.release_slot_hash ?? null,
        request.release_slot_hash ?? null,
      ) as ArtifactRow[];
    const candidates = candidateRows.map((row) =>
      CandidateChangeSchema.parse(JSON.parse(row.artifact_json) as unknown),
    );
    const candidateIds = candidates.map((candidate) => candidate.candidate_id);

    let traceRows: ArtifactRow[];
    if (request.trace_id !== undefined) {
      traceRows = this.#database
        .prepare(
          `SELECT artifact_json FROM learning_traces
           WHERE principal_id = ? AND scopes_json = ? AND trace_id = ?
           ORDER BY captured_at, trace_id`,
        )
        .all(request.principal_id, scopeSet, request.trace_id) as ArtifactRow[];
    } else if (candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => "?").join(", ");
      traceRows = this.#database
        .prepare(
          `SELECT DISTINCT t.artifact_json, t.captured_at, t.trace_id
           FROM learning_traces AS t
           JOIN learning_candidate_traces AS l ON l.trace_id = t.trace_id
           WHERE t.principal_id = ? AND t.scopes_json = ?
             AND l.candidate_id IN (${placeholders})
           ORDER BY t.captured_at, t.trace_id`,
        )
        .all(request.principal_id, scopeSet, ...candidateIds) as ArtifactRow[];
    } else {
      traceRows = this.#database
        .prepare(
          `SELECT artifact_json FROM learning_traces
           WHERE principal_id = ? AND scopes_json = ?
           ORDER BY captured_at, trace_id`,
        )
        .all(request.principal_id, scopeSet) as ArtifactRow[];
    }
    const traces = traceRows.map((row) =>
      LearningTraceSchema.parse(JSON.parse(row.artifact_json) as unknown),
    );

    const transitions =
      candidateIds.length === 0
        ? []
        : (
            this.#database
              .prepare(
                `SELECT artifact_json FROM learning_candidate_transitions
                 WHERE candidate_id IN (${candidateIds
                   .map(() => "?")
                   .join(", ")})
                 ORDER BY candidate_id, sequence`,
              )
              .all(...candidateIds) as ArtifactRow[]
          ).map((row) =>
            CandidateTransitionSchema.parse(
              JSON.parse(row.artifact_json) as unknown,
            ),
          );
    const stateRows =
      candidateIds.length === 0
        ? []
        : (this.#database
            .prepare(
              `SELECT t.candidate_id, t.sequence, t.to_state,
                      t.transition_hash
               FROM learning_candidate_transitions AS t
               JOIN (
                 SELECT candidate_id, max(sequence) AS sequence
                 FROM learning_candidate_transitions
                 WHERE candidate_id IN (${candidateIds
                   .map(() => "?")
                   .join(", ")})
                 GROUP BY candidate_id
               ) AS latest
                 ON latest.candidate_id = t.candidate_id
                AND latest.sequence = t.sequence
               ORDER BY t.candidate_id`,
            )
            .all(...candidateIds) as CandidateStateRow[]);
    const stateByCandidate = new Map(
      stateRows.map((row) => [row.candidate_id, row]),
    );
    const candidateStates = candidates.map((candidate) => {
      const row = stateByCandidate.get(candidate.candidate_id);
      return row === undefined
        ? {
            candidate_id: candidate.candidate_id,
            state: "proposed" as const,
            sequence: 0,
            transition_hash: null,
          }
        : {
            candidate_id: row.candidate_id,
            state: row.to_state,
            sequence: Number(row.sequence),
            transition_hash: row.transition_hash,
          };
    });

    const artifactRowsForCandidates = (
      table: string,
      candidateColumn = "candidate_id",
      order = "rowid"
    ): ArtifactRow[] =>
      candidateIds.length === 0
        ? []
        : (this.#database
            .prepare(
              `SELECT artifact_json FROM ${table}
               WHERE ${candidateColumn} IN (${candidateIds
                 .map(() => "?")
                 .join(", ")})
               ORDER BY ${order}`,
            )
            .all(...candidateIds) as ArtifactRow[]);
    const evaluationIdentities =
      candidateIds.length === 0
        ? []
        : (
            this.#database
              .prepare(
                `SELECT identity_json AS artifact_json
                 FROM learning_evaluation_runs
                 WHERE candidate_id IN (${candidateIds
                   .map(() => "?")
                   .join(", ")})
                 ORDER BY started_at, run_id`,
              )
              .all(...candidateIds) as ArtifactRow[]
          ).map((row) =>
            EvaluationCommonIdentitySchema.parse(
              JSON.parse(row.artifact_json) as unknown,
            ),
          );
    const runIds = evaluationIdentities.map((identity) => identity.run_id);
    const evaluationResultSets =
      runIds.length === 0
        ? []
        : (
            this.#database
              .prepare(
                `SELECT artifact_json FROM learning_evaluation_result_sets
                 WHERE run_id IN (${runIds.map(() => "?").join(", ")})
                 ORDER BY run_id, partition, case_id`,
              )
              .all(...runIds) as ArtifactRow[]
          ).map((row) =>
            EvaluationCaseResultSetSchema.parse(
              JSON.parse(row.artifact_json) as unknown,
            ),
          );
    const contaminationEvents =
      runIds.length === 0
        ? []
        : (
            this.#database
              .prepare(
                `SELECT artifact_json FROM learning_contamination_events
                 WHERE run_id IN (${runIds.map(() => "?").join(", ")})
                 ORDER BY detected_at, contamination_event_id`,
              )
              .all(...runIds) as ArtifactRow[]
          ).map((row) =>
            LearningContaminationEventSchema.parse(
              JSON.parse(row.artifact_json) as unknown,
            ),
          );
    const canaryAuthorizations = artifactRowsForCandidates(
      "learning_canary_authorizations",
      "candidate_id",
      "issued_at, authorization_id",
    ).map((row) =>
      CanaryAuthorizationSchema.parse(
        JSON.parse(row.artifact_json) as unknown,
      ),
    );
    const canaryRuns = artifactRowsForCandidates(
      "learning_canary_runs",
      "candidate_id",
      "started_at, canary_run_id",
    ).map((row) =>
      CanaryRunSchema.parse(JSON.parse(row.artifact_json) as unknown),
    );
    const releases = artifactRowsForCandidates(
      "learning_release_versions",
      "candidate_id",
      "activated_at, release_id",
    ).map((row) =>
      LearningReleaseVersionSchema.parse(
        JSON.parse(row.artifact_json) as unknown,
      ),
    );
    const releaseIds = releases.map((release) => release.release_id);
    const releaseSlots = [
      ...new Set(releases.map((release) => release.release_slot_hash)),
    ];
    const pointers =
      releaseSlots.length === 0
        ? []
        : (
            this.#database
              .prepare(
                `SELECT artifact_json FROM learning_release_pointers
                 WHERE release_slot_hash IN (${releaseSlots
                   .map(() => "?")
                   .join(", ")})
                 ORDER BY release_slot_hash`,
              )
              .all(...releaseSlots) as ArtifactRow[]
          ).map((row) =>
            ReleasePointerSchema.parse(
              JSON.parse(row.artifact_json) as unknown,
            ),
          );
    const monitors =
      releaseIds.length === 0
        ? []
        : (
            this.#database
              .prepare(
                `SELECT artifact_json FROM learning_monitor_results
                 WHERE release_id IN (${releaseIds.map(() => "?").join(", ")})
                 ORDER BY monitored_at, monitor_id`,
              )
              .all(...releaseIds) as ArtifactRow[]
          ).map((row) =>
            MonitorResultSchema.parse(
              JSON.parse(row.artifact_json) as unknown,
            ),
          );
    const controls = (
      this.#database
        .prepare(
          `SELECT artifact_json FROM learning_control_state
           WHERE principal_id = ? ORDER BY principal_id`,
        )
        .all(request.principal_id) as ArtifactRow[]
    ).map((row) =>
      LearningControlSchema.parse(JSON.parse(row.artifact_json) as unknown),
    );

    const receiptAggregateIds = [
      ...new Set([
        request.principal_id,
        ...candidateIds,
        ...runIds,
        ...releaseIds,
      ]),
    ];
    const receiptAccessRows = this.#database
      .prepare(
        `SELECT r.receipt_id, r.receipt_json, a.scope_kind, a.scope_id
         FROM learning_receipt_links AS l
         JOIN mutation_receipts AS r ON r.receipt_id = l.receipt_id
         JOIN receipt_access_scopes AS a ON a.receipt_id = r.receipt_id
         WHERE a.principal_id = ?
           AND l.aggregate_id IN (${receiptAggregateIds
             .map(() => "?")
             .join(", ")})
         ORDER BY r.resulting_epoch, l.receipt_id, a.scope_kind, a.scope_id`,
      )
      .all(request.principal_id, ...receiptAggregateIds) as Array<{
      receipt_id: string;
      receipt_json: string;
      scope_kind: string;
      scope_id: string;
    }>;
    const receiptGroups = new Map<
      string,
      { receipt_json: string; scopes: string[] }
    >();
    for (const row of receiptAccessRows) {
      const group = receiptGroups.get(row.receipt_id) ?? {
        receipt_json: row.receipt_json,
        scopes: [],
      };
      group.scopes.push(`${row.scope_kind}:${row.scope_id}`);
      receiptGroups.set(row.receipt_id, group);
    }
    const requestedScopeKeys = request.scopes.map(scopeKey).sort();
    const receiptRows = [...receiptGroups.values()].filter(
      (row) =>
        canonicalJson([...row.scopes].sort()) ===
        canonicalJson(requestedScopeKeys),
    );
    const receipts = receiptRows.map((row) => {
      const receipt = ReceiptSchema.parse(
        JSON.parse(row.receipt_json) as unknown,
      );
      if (!receiptHashIsValid(receipt)) {
        throw new StorageError("CORRUPTION");
      }
      return receipt;
    });
    const invalidCandidateIds =
      candidateIds.length === 0
        ? []
        : (
            this.#database
              .prepare(
                `SELECT DISTINCT candidate_id
                 FROM learning_target_invalidations
                 WHERE candidate_id IN (${candidateIds
                   .map(() => "?")
                   .join(", ")})
                 ORDER BY candidate_id`,
              )
              .all(...candidateIds) as Array<{ candidate_id: string }>
          ).map((row) => row.candidate_id);

    return LearningLedgerReadResultSchema.parse({
      traces,
      candidates,
      transitions,
      candidate_states: candidateStates,
      evaluation_identities: evaluationIdentities,
      evaluation_result_sets: evaluationResultSets,
      contamination_events: contaminationEvents,
      canary_authorizations: canaryAuthorizations,
      canary_runs: canaryRuns,
      releases,
      pointers,
      monitors,
      controls,
      receipts,
      invalid_candidate_ids: invalidCandidateIds,
    });
  }

  #insertTrace(trace: LearningTrace): void {
    this.#database
      .prepare(
        `INSERT INTO learning_traces (
           trace_id, episode_id, principal_id, scopes_json, trace_hash,
           control_epoch, artifact_json, captured_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.trace_id,
        trace.episode_id,
        trace.principal_id,
        scopesJson(trace.scopes),
        trace.trace_hash,
        trace.control_epoch,
        canonicalJson(trace),
        trace.captured_at,
      );
    const insertEvidence = this.#database.prepare(
      `INSERT INTO learning_trace_evidence_refs (
         trace_id, ordinal, step_id, evidence_id, content_hash, media_type
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const step of trace.trajectory) {
      if (step.retention.mode === "reference") {
        insertEvidence.run(
          trace.trace_id,
          step.ordinal,
          step.step_id,
          step.retention.evidence_id,
          step.retention.content_hash,
          step.retention.media_type,
        );
      }
    }
  }

  #validateStop(command: StopCommand): void {
    if (command.receipt.principal_id !== command.principal_id) {
      throw new StorageError("INVALID_INPUT");
    }
    if (command.receipt.trace_id !== null) {
      const trace = this.#database
        .prepare(
          `SELECT principal_id, scopes_json FROM learning_traces
           WHERE trace_id = ?`,
        )
        .get(command.receipt.trace_id) as
        | { principal_id: string; scopes_json: string }
        | undefined;
      if (
        trace === undefined ||
        trace.principal_id !== command.principal_id ||
        trace.scopes_json !== scopesJson(command.scopes)
      ) {
        throw new StorageError("INVALID_INPUT");
      }
    }
    if (command.receipt.candidate_id !== null) {
      this.#assertCandidateAccess(
        command.receipt.candidate_id,
        command.principal_id,
        command.scopes,
      );
    }
  }

  #insertCandidate(candidate: CandidateChange): void {
    for (const traceId of candidate.trace_ids) {
      const trace = this.#database
        .prepare(
          `SELECT principal_id, scopes_json FROM learning_traces
           WHERE trace_id = ?`,
        )
        .get(traceId) as
        | { principal_id: string; scopes_json: string }
        | undefined;
      if (
        trace === undefined ||
        trace.principal_id !== candidate.principal_id ||
        trace.scopes_json !== scopesJson(candidate.scopes)
      ) {
        throw new StorageError("INVALID_INPUT");
      }
    }
    let targetMemoryId: string | null = null;
    let targetRevisionId: string | null = null;
    let targetContentHash: string | null = null;
    if (
      candidate.target.kind === "memory" ||
      candidate.target.kind === "procedure"
    ) {
      const target = this.#database
        .prepare(
          `SELECT o.principal_id, o.scope_kind, o.scope_id, o.lifecycle,
                  o.current_revision_id, r.content_hash, r.purged_at
           FROM memory_objects AS o
           JOIN memory_revisions AS r ON r.revision_id = ?
           WHERE o.memory_id = ? AND r.memory_id = o.memory_id`,
        )
        .get(candidate.target.revision_id, candidate.target.memory_id) as
        | {
            principal_id: string;
            scope_kind: string;
            scope_id: string;
            lifecycle: string;
            current_revision_id: string | null;
            content_hash: string;
            purged_at: string | null;
          }
        | undefined;
      const candidateScopeKeys = new Set(candidate.scopes.map(scopeKey));
      if (
        target === undefined ||
        target.principal_id !== candidate.principal_id ||
        !candidateScopeKeys.has(`${target.scope_kind}:${target.scope_id}`) ||
        target.lifecycle === "revoked" ||
        target.lifecycle === "purged" ||
        target.current_revision_id !== candidate.target.revision_id ||
        target.content_hash !== candidate.target.content_hash ||
        target.purged_at !== null
      ) {
        throw new StorageError("INVALID_INPUT");
      }
      targetMemoryId = candidate.target.memory_id;
      targetRevisionId = candidate.target.revision_id;
      targetContentHash = candidate.target.content_hash;
    }
    this.#database
      .prepare(
        `INSERT INTO learning_candidates (
           candidate_id, principal_id, scopes_json, candidate_type,
           release_capability, release_slot_hash, target_kind,
           target_memory_id, target_revision_id, target_content_hash,
           candidate_hash, artifact_json, proposed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.candidate_id,
        candidate.principal_id,
        scopesJson(candidate.scopes),
        candidate.candidate_type,
        candidate.release_capability,
        candidate.release_slot?.slot_hash ?? null,
        candidate.target.kind,
        targetMemoryId,
        targetRevisionId,
        targetContentHash,
        candidate.candidate_hash,
        canonicalJson(candidate),
        candidate.proposed_at,
      );
    const insertTrace = this.#database.prepare(
      `INSERT INTO learning_candidate_traces (
         candidate_id, ordinal, trace_id
       ) VALUES (?, ?, ?)`,
    );
    candidate.trace_ids.forEach((traceId, ordinal) => {
      insertTrace.run(candidate.candidate_id, ordinal, traceId);
    });
    const insertEvidence = this.#database.prepare(
      `INSERT INTO learning_candidate_evidence (
         candidate_id, ordinal, evidence_id
       ) VALUES (?, ?, ?)`,
    );
    candidate.evidence_ids.forEach((evidenceId, ordinal) => {
      insertEvidence.run(candidate.candidate_id, ordinal, evidenceId);
    });
  }

  #insertTransition(transition: CandidateTransition): void {
    const latest = this.#database
      .prepare(
        `SELECT sequence, to_state, transition_hash
         FROM learning_candidate_transitions
         WHERE candidate_id = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(transition.candidate_id) as
      | {
          sequence: number;
          to_state: string;
          transition_hash: string;
        }
      | undefined;
    const expectedSequence = latest === undefined ? 1 : Number(latest.sequence) + 1;
    const expectedState = latest?.to_state ?? "proposed";
    const expectedHash = latest?.transition_hash ?? null;
    if (
      transition.sequence !== expectedSequence ||
      transition.from_state !== expectedState ||
      transition.expected_previous_transition_hash !== expectedHash
    ) {
      throw new StorageError("CONFLICT");
    }
    this.#database
      .prepare(
        `INSERT INTO learning_candidate_transitions (
           transition_id, candidate_id, sequence, from_state, to_state,
           expected_previous_transition_hash, transition_hash, artifact_json,
           transitioned_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transition.transition_id,
        transition.candidate_id,
        transition.sequence,
        transition.from_state,
        transition.to_state,
        transition.expected_previous_transition_hash,
        transition.transition_hash,
        canonicalJson(transition),
        transition.transitioned_at,
      );
  }

  #validateTransitionReceipt(
    transition: CandidateTransition,
    receipt: Extract<
      ReturnType<typeof ReceiptSchema.parse>,
      { kind: "learning_transition" }
    >,
  ): void {
    if (
      receipt.candidate_id !== transition.candidate_id ||
      receipt.transition_id !== transition.transition_id ||
      receipt.sequence !== transition.sequence ||
      receipt.from_state !== transition.from_state ||
      receipt.to_state !== transition.to_state ||
      receipt.authority_id !== transition.authority_id ||
      receipt.control_epoch !== transition.control_epoch ||
      canonicalJson(receipt.evidence_receipt_ids) !==
        canonicalJson(transition.evidence_receipt_ids)
    ) {
      throw new StorageError("INVALID_INPUT");
    }
  }

  #insertEvaluation(command: EvaluationCommand): void {
    this.#assertCandidateAccess(
      command.identity.candidate_id,
      command.principal_id,
      command.scopes,
    );
    const partitions = command.partition_seals.map((seal) => seal.partition);
    if (
      new Set(partitions).size !== 3 ||
      !["calibration", "holdout", "transfer"].every((partition) =>
        partitions.includes(
          partition as (typeof command.partition_seals)[number]["partition"],
        ),
      ) ||
      command.receipt.run_id !== command.identity.run_id ||
      command.receipt.candidate_id !== command.identity.candidate_id ||
      command.receipt.common_identity_hash !==
        command.identity.common_identity_hash ||
      command.result_sets.some(
        (resultSet) =>
          resultSet.run_id !== command.identity.run_id ||
          resultSet.common_identity_hash !==
            command.identity.common_identity_hash,
      )
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const resultSetHashes = command.result_sets.map(
      (resultSet) => resultSet.result_set_hash,
    );
    if (
      canonicalJson([...resultSetHashes].sort()) !==
      canonicalJson([...command.receipt.result_set_hashes].sort())
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const contaminationIds = command.contamination_events.map(
      (event) => event.contamination_event_id,
    );
    if (
      canonicalJson([...contaminationIds].sort()) !==
      canonicalJson([...command.receipt.contamination_event_ids].sort())
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const insertSeal = this.#database.prepare(
      `INSERT INTO learning_partition_seals (
         seal_id, partition, manifest_hash, case_hashes_json,
         oracle_hashes_json, sealed_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(seal_id) DO NOTHING`,
    );
    for (const seal of command.partition_seals) {
      insertSeal.run(
        seal.seal_id,
        seal.partition,
        seal.manifest_hash,
        canonicalJson(seal.case_hashes),
        canonicalJson(seal.oracle_hashes),
        seal.sealed_at,
      );
      const stored = this.#database
        .prepare(
          `SELECT partition, manifest_hash, case_hashes_json,
                  oracle_hashes_json, sealed_at
           FROM learning_partition_seals WHERE seal_id = ?`,
        )
        .get(seal.seal_id);
      if (
        canonicalJson(stored) !==
        canonicalJson({
          partition: seal.partition,
          manifest_hash: seal.manifest_hash,
          case_hashes_json: canonicalJson(seal.case_hashes),
          oracle_hashes_json: canonicalJson(seal.oracle_hashes),
          sealed_at: seal.sealed_at,
        })
      ) {
        throw new StorageError("CONFLICT");
      }
    }
    this.#database
      .prepare(
        `INSERT INTO learning_evaluation_runs (
           run_id, candidate_id, principal_id, scopes_json,
           common_identity_hash, identity_json, started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.identity.run_id,
        command.identity.candidate_id,
        command.principal_id,
        scopesJson(command.scopes),
        command.identity.common_identity_hash,
        canonicalJson(command.identity),
        command.receipt.created_at,
      );
    const insertSet = this.#database.prepare(
      `INSERT INTO learning_evaluation_result_sets (
         result_set_hash, run_id, case_id, partition, common_identity_hash,
         artifact_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertResult = this.#database.prepare(
      `INSERT INTO learning_evaluation_results (
         eval_result_id, result_set_hash, run_id, case_id, partition, arm,
         result_hash, artifact_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const resultSet of command.result_sets) {
      insertSet.run(
        resultSet.result_set_hash,
        resultSet.run_id,
        resultSet.case_id,
        resultSet.partition,
        resultSet.common_identity_hash,
        canonicalJson(resultSet),
      );
      for (const result of resultSet.results) {
        insertResult.run(
          result.eval_result_id,
          resultSet.result_set_hash,
          result.run_id,
          result.case_id,
          result.partition,
          result.arm,
          result.result_hash,
          canonicalJson(result),
        );
      }
    }
    const insertContamination = this.#database.prepare(
      `INSERT INTO learning_contamination_events (
         contamination_event_id, run_id, partition, case_id, code,
         event_hash, artifact_json, detected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of command.contamination_events) {
      if (
        event.run_id !== command.identity.run_id ||
        event.event_hash !==
          canonicalSha256Omitting(event, ["event_hash"])
      ) {
        throw new StorageError("INVALID_INPUT");
      }
      insertContamination.run(
        event.contamination_event_id,
        event.run_id,
        event.partition,
        event.case_id,
        event.code,
        event.event_hash,
        canonicalJson(event),
        event.detected_at,
      );
    }
  }

  #insertCanary(command: CanaryCommand): void {
    this.#assertCandidateAccess(
      command.run.candidate_id,
      command.principal_id,
      command.scopes,
    );
    const currentState = this.#currentCandidateState(command.run.candidate_id);
    const evaluationReceipt = this.#database
      .prepare(
        `SELECT receipt_hash FROM mutation_receipts WHERE receipt_id = ?`,
      )
      .get(command.authorization.evaluation_receipt_id) as
      | { receipt_hash: string }
      | undefined;
    if (
      (currentState !== "approved_for_canary" &&
        currentState !== "canary") ||
      command.authorization.principal_id !== command.principal_id ||
      scopesJson(command.authorization.scopes) !==
        scopesJson(command.scopes) ||
      command.authorization.candidate_id !== command.run.candidate_id ||
      command.authorization.authorization_id !== command.run.authorization_id ||
      command.authorization.canary_manifest_hash !==
        command.run.canary_manifest_hash ||
      command.authorization.base_release_id !== command.run.stable_release_id ||
      command.authorization.control_epoch !== command.run.control_epoch ||
      command.receipt.candidate_id !== command.run.candidate_id ||
      command.receipt.authorization_id !== command.authorization.authorization_id ||
      command.receipt.authorization_hash !==
        command.authorization.authorization_hash ||
      command.receipt.evaluation_receipt_id !==
        command.authorization.evaluation_receipt_id ||
      command.receipt.canary_manifest_hash !== command.run.canary_manifest_hash ||
      command.receipt.exposures !== command.run.exposure_count ||
      command.receipt.control_epoch !== command.run.control_epoch ||
      command.receipt.passed !== (command.run.status === "passed") ||
      command.run.status === "running" ||
      evaluationReceipt?.receipt_hash !==
        command.authorization.evaluation_receipt_hash
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    this.#database
      .prepare(
        `INSERT INTO learning_canary_authorizations (
           authorization_id, candidate_id, authorization_hash, artifact_json,
           issued_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        command.authorization.authorization_id,
        command.authorization.candidate_id,
        command.authorization.authorization_hash,
        canonicalJson(command.authorization),
        command.authorization.issued_at,
      );
    this.#database
      .prepare(
        `INSERT INTO learning_canary_runs (
           canary_run_id, candidate_id, authorization_id, run_hash,
           artifact_json, started_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.run.canary_run_id,
        command.run.candidate_id,
        command.run.authorization_id,
        command.run.run_hash,
        canonicalJson(command.run),
        command.run.started_at,
      );
  }

  #insertMonitor(command: MonitorCommand): void {
    const release = this.#database
      .prepare(
        `SELECT candidate_id FROM learning_release_versions
         WHERE release_id = ?`,
      )
      .get(command.monitor.release_id) as
      | { candidate_id: string }
      | undefined;
    if (release === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    this.#assertCandidateAccess(
      release.candidate_id,
      command.principal_id,
      command.scopes,
    );
    const pointer = this.#database
      .prepare(
        `SELECT pointer_revision FROM learning_release_pointers
         WHERE active_release_id = ?`,
      )
      .get(command.monitor.release_id) as
      | { pointer_revision: number }
      | undefined;
    if (
      pointer === undefined ||
      Number(pointer.pointer_revision) !== command.monitor.pointer_revision ||
      command.receipt.release_id !== command.monitor.release_id ||
      command.receipt.pointer_revision !== command.monitor.pointer_revision ||
      command.receipt.canary_receipt_id !== command.monitor.canary_receipt_id ||
      canonicalJson(command.receipt.replayed_case_ids) !==
        canonicalJson(command.monitor.replayed_case_ids) ||
      command.receipt.passed !== command.monitor.passed ||
      canonicalJson(command.receipt.failure_codes) !==
        canonicalJson(command.monitor.failure_codes) ||
      command.receipt.rollback_required !== command.monitor.rollback_required
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    this.#database
      .prepare(
        `INSERT INTO learning_monitor_results (
           monitor_id, release_id, monitor_hash, artifact_json, monitored_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        command.monitor.monitor_id,
        command.monitor.release_id,
        command.monitor.monitor_hash,
        canonicalJson(command.monitor),
        command.monitor.monitored_at,
      );
  }

  #insertControl(command: ControlCommand): void {
    const expectedTool =
      command.control.status === "paused"
        ? "learning_pause"
        : "learning_resume";
    if (
      command.approval_binding.tool !== expectedTool ||
      command.approval_binding.principal_id !== command.control.principal_id ||
      command.approval_binding.request_hash !== command.request_hash ||
      command.receipt.request_hash !== command.request_hash ||
      command.receipt.principal_id !== command.control.principal_id ||
      command.receipt.action !==
        (command.control.status === "paused" ? "pause" : "resume") ||
      command.receipt.frontier_hash !== command.control.frontier_hash ||
      command.receipt.runtime_identity_hash !==
        command.control.runtime_identity_hash ||
      command.receipt.configuration_hash !== command.control.configuration_hash ||
      command.receipt.corpus_hash !== command.control.corpus_hash ||
      command.receipt.resulting_epoch !== command.control.control_epoch
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const current = this.#database
      .prepare(
        `SELECT control_epoch, frontier_hash, status
         FROM learning_control_state WHERE principal_id = ?`,
      )
      .get(command.control.principal_id) as
      | { control_epoch: number; frontier_hash: string; status: string }
      | undefined;
    const currentEpoch = current === undefined ? 0 : Number(current.control_epoch);
    const currentFrontier =
      current?.frontier_hash ?? command.receipt.previous_frontier_hash;
    if (
      command.expected_control_epoch !== currentEpoch ||
      command.expected_frontier_hash !== currentFrontier ||
      command.receipt.previous_epoch !== currentEpoch ||
      command.receipt.previous_frontier_hash !== currentFrontier ||
      command.control.control_epoch !== currentEpoch + 1 ||
      (current !== undefined && current.status === command.control.status)
    ) {
      throw new StorageError("CONFLICT");
    }
    if (current === undefined) {
      this.#database
        .prepare(
          `INSERT INTO learning_control_state (
             principal_id, status, control_epoch, frontier_hash,
             runtime_identity_hash, configuration_hash, corpus_hash,
             artifact_json, changed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.control.principal_id,
          command.control.status,
          command.control.control_epoch,
          command.control.frontier_hash,
          command.control.runtime_identity_hash,
          command.control.configuration_hash,
          command.control.corpus_hash,
          canonicalJson(command.control),
          command.control.changed_at,
        );
    } else {
      const changed = this.#database
        .prepare(
          `UPDATE learning_control_state
           SET status = ?, control_epoch = ?, frontier_hash = ?,
               runtime_identity_hash = ?, configuration_hash = ?,
               corpus_hash = ?, artifact_json = ?, changed_at = ?
           WHERE principal_id = ? AND control_epoch = ? AND frontier_hash = ?`,
        )
        .run(
          command.control.status,
          command.control.control_epoch,
          command.control.frontier_hash,
          command.control.runtime_identity_hash,
          command.control.configuration_hash,
          command.control.corpus_hash,
          canonicalJson(command.control),
          command.control.changed_at,
          command.control.principal_id,
          command.expected_control_epoch,
          command.expected_frontier_hash,
        );
      if (changed.changes !== 1) {
        throw new StorageError("CONFLICT");
      }
    }
    this.#fail(command, "after_control");
  }

  #insertRelease(command: ReleaseCommand): void {
    this.#assertCandidateAccess(
      command.release.candidate_id,
      command.principal_id,
      command.scopes,
    );
    const control = this.#database
      .prepare(
        `SELECT status, control_epoch FROM learning_control_state
         WHERE principal_id = ?`,
      )
      .get(command.principal_id) as
      | { status: string; control_epoch: number }
      | undefined;
    const expectedTool =
      command.kind === "release"
        ? "learning_release"
        : "learning_rollback";
    if (
      Number(control?.control_epoch ?? 0) !== command.expected_control_epoch ||
      control?.status === "paused" ||
      command.approval_binding.tool !== expectedTool ||
      command.approval_binding.principal_id !== command.principal_id ||
      scopesJson(command.approval_binding.scopes) !==
        scopesJson(command.scopes) ||
      command.approval_binding.request_hash !== command.request_hash ||
      command.receipt.request_hash !== command.request_hash ||
      command.approval_artifact.principal_id !== command.principal_id ||
      scopesJson(command.approval_artifact.scopes) !==
        scopesJson(command.scopes) ||
      command.approval_artifact.request_hash !== command.request_hash ||
      command.approval_artifact.approval_id !==
        command.approval.grant.approval_id ||
      command.approval_binding.learning === undefined ||
      canonicalJson(command.approval_binding.learning) !==
        canonicalJson({
          action: command.approval_artifact.action,
          candidate_id: command.approval_artifact.candidate_id,
          release_slot_hash: command.approval_artifact.release_slot_hash,
          base_release_id: command.approval_artifact.base_release_id,
          evaluation_receipt_id:
            command.approval_artifact.evaluation_receipt_id,
          evaluation_receipt_hash:
            command.approval_artifact.evaluation_receipt_hash,
          canary_receipt_id: command.approval_artifact.canary_receipt_id,
          canary_receipt_hash: command.approval_artifact.canary_receipt_hash,
          expected_pointer_revision:
            command.approval_artifact.expected_pointer_revision,
          target_release_id: command.approval_artifact.target_release_id,
          control_epoch: command.approval_artifact.control_epoch,
          effect_manifest_hash:
            command.approval_artifact.effect_manifest_hash,
        }) ||
      command.release.release_slot_hash !==
        command.approval_artifact.release_slot_hash ||
      command.release.candidate_id !==
        command.approval_artifact.candidate_id ||
      command.release.approval_id !== command.approval_artifact.approval_id ||
      command.release.evaluation_receipt_id !==
        command.approval_artifact.evaluation_receipt_id ||
      command.release.canary_receipt_id !==
        command.approval_artifact.canary_receipt_id ||
      command.transition.candidate_id !== command.release.candidate_id ||
      command.transition.authority_id !==
        command.approval_artifact.approval_id ||
      (command.kind === "release" &&
        command.transition.to_state !== "released") ||
      (command.kind === "rollback" &&
        command.transition.to_state !== "rolled_back")
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const upstreamReceipts = this.#database
      .prepare(
        `SELECT l.receipt_kind, r.receipt_id, r.receipt_hash
         FROM learning_receipt_links AS l
         JOIN mutation_receipts AS r ON r.receipt_id = l.receipt_id
         WHERE r.receipt_id IN (?, ?)`,
      )
      .all(
        command.approval_artifact.evaluation_receipt_id,
        command.approval_artifact.canary_receipt_id,
      ) as Array<{
      receipt_kind: string;
      receipt_id: string;
      receipt_hash: string;
    }>;
    const evaluationReceipt = upstreamReceipts.find(
      (row) =>
        row.receipt_id ===
          command.approval_artifact.evaluation_receipt_id &&
        row.receipt_kind === "evaluation",
    );
    const canaryReceipt = upstreamReceipts.find(
      (row) =>
        row.receipt_id === command.approval_artifact.canary_receipt_id &&
        row.receipt_kind === "learning_canary",
    );
    if (
      evaluationReceipt?.receipt_hash !==
        command.approval_artifact.evaluation_receipt_hash ||
      canaryReceipt?.receipt_hash !==
        command.approval_artifact.canary_receipt_hash
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const currentPointer = this.#database
      .prepare(
        `SELECT active_release_id, pointer_revision FROM learning_release_pointers
         WHERE release_slot_hash = ?`,
      )
      .get(command.release.release_slot_hash) as
      | { active_release_id: string | null; pointer_revision: number }
      | undefined;
    const pointerRevision = Number(currentPointer?.pointer_revision ?? 0);
    if (
      pointerRevision !== command.expected_pointer_revision ||
      command.approval_artifact.expected_pointer_revision !== pointerRevision ||
      command.pointer.pointer_revision !== pointerRevision + 1 ||
      command.pointer.release_slot_hash !== command.release.release_slot_hash ||
      command.approval_artifact.base_release_id !==
        (currentPointer?.active_release_id ?? null) ||
      command.release.previous_release_id !==
        (currentPointer?.active_release_id ?? null) ||
      command.release.restored_release_id !==
        command.approval_artifact.target_release_id ||
      (command.kind === "release" &&
        command.pointer.active_release_id !== command.release.release_id) ||
      (command.kind === "rollback" &&
        command.pointer.active_release_id !== command.release.restored_release_id)
    ) {
      throw new StorageError("CONFLICT");
    }
    if (command.kind === "release") {
      if (
        command.receipt.kind !== "release" ||
        command.receipt.release_id !== command.release.release_id ||
        command.receipt.release_slot_hash !==
          command.release.release_slot_hash ||
        command.receipt.candidate_id !== command.release.candidate_id ||
        command.receipt.previous_release_id !==
          command.release.previous_release_id ||
        command.receipt.evaluation_receipt_id !==
          command.release.evaluation_receipt_id ||
        command.receipt.canary_receipt_id !==
          command.release.canary_receipt_id ||
        command.receipt.approval_id !== command.release.approval_id ||
        command.receipt.approval_hash !==
          command.approval_artifact.approval_hash ||
        command.receipt.resulting_pointer_revision !==
          command.pointer.pointer_revision ||
        command.receipt.control_epoch !== command.expected_control_epoch
      ) {
        throw new StorageError("INVALID_INPUT");
      }
    } else if (
      command.receipt.kind !== "rollback" ||
      command.receipt.release_id !== command.release.release_id ||
      command.receipt.rolled_back_release_id !==
        command.release.previous_release_id ||
      command.receipt.restored_release_id !==
        command.release.restored_release_id ||
      command.receipt.approval_id !== command.release.approval_id ||
      command.receipt.approval_hash !==
        command.approval_artifact.approval_hash ||
      command.receipt.resulting_pointer_revision !==
        command.pointer.pointer_revision ||
      command.receipt.control_epoch !== command.expected_control_epoch
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    this.#database
      .prepare(
        `INSERT INTO learning_release_versions (
           release_id, release_slot_hash, candidate_id, action,
           previous_release_id, restored_release_id, release_hash,
           artifact_json, activated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.release.release_id,
        command.release.release_slot_hash,
        command.release.candidate_id,
        command.release.action,
        command.release.previous_release_id,
        command.release.restored_release_id,
        command.release.release_hash,
        canonicalJson(command.release),
        command.release.activated_at,
      );
    this.#fail(command, "after_release");
    if (currentPointer === undefined) {
      this.#database
        .prepare(
          `INSERT INTO learning_release_pointers (
             release_slot_hash, active_release_id, pointer_revision,
             pointer_hash, artifact_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.pointer.release_slot_hash,
          command.pointer.active_release_id,
          command.pointer.pointer_revision,
          command.pointer.pointer_hash,
          canonicalJson(command.pointer),
          command.pointer.updated_at,
        );
    } else {
      const changed = this.#database
        .prepare(
          `UPDATE learning_release_pointers
           SET active_release_id = ?, pointer_revision = ?, pointer_hash = ?,
               artifact_json = ?, updated_at = ?
           WHERE release_slot_hash = ? AND pointer_revision = ?`,
        )
        .run(
          command.pointer.active_release_id,
          command.pointer.pointer_revision,
          command.pointer.pointer_hash,
          canonicalJson(command.pointer),
          command.pointer.updated_at,
          command.pointer.release_slot_hash,
          command.expected_pointer_revision,
        );
      if (changed.changes !== 1) {
        throw new StorageError("CONFLICT");
      }
    }
    this.#fail(command, "after_pointer");
    this.#insertTransition(command.transition);
    this.#fail(command, "after_transition");
  }

  #insertReceipt(
    command: ParsedLearningLedgerWriteCommand,
    receipt: ReturnType<typeof ReceiptSchema.parse>,
    aggregateId: string,
    ledgerEpoch: number,
  ): void {
    if (!receiptHashIsValid(receipt)) {
      throw new StorageError("INVALID_INPUT");
    }
    let access: {
      principal_id: string;
      scopes: readonly { kind: string; id: string }[];
    } | null;
    if (command.kind === "trace" || command.kind === "candidate") {
      access = null;
    } else if (command.kind === "transition") {
      const candidate = this.#database
        .prepare(
          `SELECT principal_id, scopes_json FROM learning_candidates
           WHERE candidate_id = ?`,
        )
        .get(command.transition.candidate_id) as
        | { principal_id: string; scopes_json: string }
        | undefined;
      access =
        candidate === undefined
          ? null
          : {
              principal_id: candidate.principal_id,
              scopes: JSON.parse(candidate.scopes_json) as Array<{
                kind: string;
                id: string;
              }>,
            };
    } else if (command.kind === "control") {
      access = {
        principal_id: command.control.principal_id,
        scopes: command.approval_binding.scopes,
      };
    } else {
      access = {
        principal_id: command.principal_id,
        scopes: command.scopes,
      };
    }
    if (access === null) {
      throw new StorageError("INVALID_INPUT");
    }
    this.#database
      .prepare(
        `INSERT INTO mutation_receipts (
           receipt_id, idempotency_key, request_hash, receipt_hash, state,
           resulting_epoch, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        command.idempotency_key,
        receipt.request_hash,
        receipt.receipt_hash,
        receipt.state,
        ledgerEpoch,
        canonicalJson(receipt),
        receipt.created_at,
      );
    this.#database
      .prepare(
        `INSERT INTO learning_receipt_links (
           receipt_id, aggregate_kind, aggregate_id, receipt_kind,
           receipt_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        command.kind,
        aggregateId,
        receipt.kind,
        receipt.receipt_hash,
        receipt.created_at,
      );
    const insertAccess = this.#database.prepare(
      `INSERT INTO receipt_access_scopes (
         receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
         created_at
       ) VALUES (?, 'mutation', ?, ?, ?, ?)`,
    );
    for (const scope of access.scopes) {
      insertAccess.run(
        receipt.receipt_id,
        access.principal_id,
        scope.kind,
        scope.id,
        receipt.created_at,
      );
    }
  }

  #consumeApproval(
    command: ControlCommand | ReleaseCommand,
    receiptId: string,
  ): void {
    this.#assertApprovalAvailable(command);
    try {
      this.#database
        .prepare(
          `INSERT INTO approval_consumptions (
             approval_id, idempotency_key, request_hash, manifest_hash,
             principal_id, tool, scopes_json, consumed_at, receipt_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.approval.grant.approval_id,
          command.idempotency_key,
          command.request_hash,
          command.approval.grant.manifest_hash,
          command.approval_binding.principal_id,
          command.approval_binding.tool,
          scopesJson(command.approval_binding.scopes),
          command.approval.verified_at,
          receiptId,
        );
    } catch {
      throw new StorageError("APPROVAL_INVALID");
    }
  }

  #assertApprovalAvailable(command: ControlCommand | ReleaseCommand): void {
    if (
      !approvalGrantMatches(
        command.approval_binding,
        command.approval.grant,
        command.approval.verified_at,
      ) ||
      this.#database
        .prepare(
          "SELECT 1 FROM approval_consumptions WHERE approval_id = ?",
        )
        .get(command.approval.grant.approval_id) !== undefined
    ) {
      throw new StorageError("APPROVAL_INVALID");
    }
  }

  #assertCandidateAccess(
    candidateId: string,
    principalId: string,
    scopes: readonly { kind: string; id: string }[],
  ): void {
    const candidate = this.#database
      .prepare(
        `SELECT principal_id, scopes_json FROM learning_candidates
         WHERE candidate_id = ?`,
      )
      .get(candidateId) as
      | { principal_id: string; scopes_json: string }
      | undefined;
    if (
      candidate === undefined ||
      candidate.principal_id !== principalId ||
      candidate.scopes_json !== scopesJson(scopes)
    ) {
      throw new StorageError("INVALID_INPUT");
    }
  }

  #currentCandidateState(candidateId: string): string {
    const row = this.#database
      .prepare(
        `SELECT to_state FROM learning_candidate_transitions
         WHERE candidate_id = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(candidateId) as { to_state: string } | undefined;
    return row?.to_state ?? "proposed";
  }

  #readIdempotency(idempotencyKey: string): IdempotencyRow | undefined {
    return this.#database
      .prepare(
        `SELECT request_hash, result_json
         FROM learning_idempotency_results WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as IdempotencyRow | undefined;
  }

  #replay(
    row: IdempotencyRow,
    expectedHash: string,
  ): LearningLedgerWriteResult {
    if (row.request_hash !== expectedHash) {
      throw new StorageError("CONFLICT");
    }
    const stored = LearningLedgerWriteResultSchema.parse(
      JSON.parse(row.result_json) as unknown,
    );
    return { ...stored, replayed: true };
  }

  #openGuard(operation: string): void {
    this.#database
      .prepare(
        `INSERT INTO learning_write_guard (singleton, operation, opened_at)
         VALUES (1, ?, ?)`,
      )
      .run(operation, new Date().toISOString());
  }

  #closeGuard(): void {
    this.#database
      .prepare("DELETE FROM learning_write_guard WHERE singleton = 1")
      .run();
  }

  #advanceEpoch(): number {
    const changedAt = new Date().toISOString();
    this.#database
      .prepare(
        `UPDATE ledger_state
         SET ledger_epoch = ledger_epoch + 1, updated_at = ?
         WHERE singleton = 1`,
      )
      .run(changedAt);
    return Number(
      (
        this.#database
          .prepare(
            "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
          )
          .get() as { ledger_epoch: number }
      ).ledger_epoch,
    );
  }

  #fail(
    command: ParsedLearningLedgerWriteCommand,
    point: string,
  ): void {
    if (failurePoint(command) === point) {
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
  }

  #tableExists(name: string): boolean {
    return (
      this.#database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) !== undefined
    );
  }
}

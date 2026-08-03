import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  AutomaticMemoryPolicyDecisionSchema,
  RedactionReportSchema,
  canonicalJson,
  canonicalSha256,
  logicalKeyHash,
  type AutomaticMemoryEvent,
  type Lifecycle,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import {
  AutomaticMemoryCaptureReceiptSchema,
  AutomaticMemoryFormationJobMutationResultSchema,
  AutomaticMemoryFormationJobSchema,
  AutomaticMemoryProjectIdentitySchema,
  AutomaticMemoryProjectSchema,
  AutomaticMemoryStatusSchema,
  AutomaticMemoryActivityQuerySchema,
  AutomaticMemoryActivityResultSchema,
  AutomaticMemoryAdmissionLookupInputSchema,
  AutomaticMemoryAdmissionLookupResultSchema,
  CheckAutomaticMemoryConflictInputSchema,
  CheckAutomaticMemoryConflictResultSchema,
  CaptureAutomaticMemoryEventCommandSchema,
  ClaimAutomaticMemoryFormationJobsInputSchema,
  ClaimAutomaticMemoryFormationJobsResultSchema,
  CompleteAutomaticMemoryFormationJobCommandSchema,
  FailAutomaticMemoryFormationJobCommandSchema,
  MAX_AUTOMATIC_MEMORY_FORMATION_ATTEMPTS,
  RegisterAutomaticMemoryProjectCommandSchema,
  RecordAutomaticMemoryFormationAuditCommandSchema,
  RecordAutomaticMemoryFormationAuditResultSchema,
  RecordAutomaticMemoryRecallUseCommandSchema,
  RecordAutomaticMemoryRecallUseResultSchema,
  type AutomaticMemoryCaptureReceipt,
  type AutomaticMemoryFormationJob,
  type AutomaticMemoryFormationJobMutationResult,
  type AutomaticMemoryProject,
  type AutomaticMemoryProjectIdentity,
  type AutomaticMemoryStatus,
  type AutomaticMemoryActivityResult,
  type AutomaticMemoryAdmissionLookupResult,
  type ClaimAutomaticMemoryFormationJobsResult,
  type CheckAutomaticMemoryConflictResult,
  type ParsedCaptureAutomaticMemoryEventCommand,
  type RecordAutomaticMemoryFormationAuditResult,
  type RecordAutomaticMemoryRecallUseResult,
} from "./protocol.js";

type ProjectRow = {
  project_id: string;
  principal_id: string;
  identity_kind: "git_common_dir" | "canonical_root";
  identity_hash: string;
  scope_kind: "workspace";
  scope_id: string;
  registered_at: string;
};

type ExistingCaptureRow = {
  request_hash: string;
  receipt_json: string;
};

type EvidenceRow = {
  principal_id: string;
  scope_kind: string;
  scope_id: string;
  payload_storage: "inline" | "blob";
  payload_inline: string | null;
  sensitivity: string;
};

type TurnRow = {
  turn_key: string;
  user_event_id: string | null;
  user_evidence_id: string | null;
  assistant_event_id: string | null;
  assistant_evidence_id: string | null;
  active_generation: number;
  stabilization_due_at: string | null;
};

type JobMutationRow = {
  job_id: string;
  generation: number;
  status: "pending" | "processing" | "completed" | "quarantined";
  attempts: number;
  claimed_by: string | null;
  result_hash: string | null;
};

type FormationJobRow = {
  job_id: string;
  turn_key: string;
  project_id: string;
  project_identity_hash: string;
  principal_id: string;
  scope_kind: "workspace";
  scope_id: string;
  session_id: string;
  turn_id: string;
  generation: number;
  user_event_id: string;
  assistant_event_id: string;
  user_evidence_id: string;
  assistant_evidence_id: string;
  status: "pending" | "processing" | "completed" | "quarantined";
  attempts: number;
  available_at: string;
  claimed_by: string | null;
  lease_expires_at: string | null;
};

type ActivityRow = {
  turn_key: string;
  project_id: string;
  scope_kind: "workspace";
  scope_id: string;
  session_id: string;
  turn_id: string;
  active_generation: number;
  state: "open" | "stabilizing" | "ready" | "completed" | "quarantined";
  user_captured_at: string | null;
  assistant_captured_at: string | null;
  job_id: string | null;
  job_status: "pending" | "processing" | "completed" | "quarantined" | null;
  attempts: number | null;
  job_updated_at: string | null;
};

function stableIdentifier(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `${prefix}:${digest.slice(0, 48)}`;
}

function resolveGitCommonDirectory(cwd: string): string | null {
  try {
    const output = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (output.length === 0) {
      return null;
    }
    return realpathSync(isAbsolute(output) ? output : resolve(cwd, output));
  } catch {
    return null;
  }
}

export function resolveAutomaticMemoryProjectIdentity(
  cwdInput: string,
): AutomaticMemoryProjectIdentity {
  if (cwdInput.length === 0 || cwdInput.length > 4_096) {
    throw new StorageError("INVALID_INPUT");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(cwdInput);
  } catch {
    throw new StorageError("INVALID_INPUT");
  }
  const gitCommonDirectory = resolveGitCommonDirectory(canonicalRoot);
  const identityKind =
    gitCommonDirectory === null ? "canonical_root" : "git_common_dir";
  const locator = gitCommonDirectory ?? canonicalRoot;
  const locatorStat = statSync(locator, { bigint: true });
  const identityHash = canonicalSha256({
    identity_kind: identityKind,
    device: locatorStat.dev.toString(10),
    inode: locatorStat.ino.toString(10),
  });
  return AutomaticMemoryProjectIdentitySchema.parse({
    identity_kind: identityKind,
    identity_hash: identityHash,
    scope: {
      kind: "workspace",
      id: `workspace_${identityHash.slice("sha256:".length)}`,
    },
  });
}

function eventTurnIdentity(event: AutomaticMemoryEvent): {
  turnId: string;
  generation: number;
} | null {
  return event.event_kind === "user_prompt_submit" ||
    event.event_kind === "assistant_stop"
    ? { turnId: event.turn_id, generation: event.generation }
    : null;
}

function eventText(event: AutomaticMemoryEvent): string | null {
  if (event.event_kind === "user_prompt_submit") {
    return event.prompt;
  }
  if (event.event_kind === "assistant_stop") {
    return event.last_assistant_message;
  }
  return null;
}

const SECRET_SIGNAL =
  /(?:\b(?:ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,})\b|\bBearer\s+[A-Za-z0-9._~-]{16,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;

function eventContainsSecretSignal(event: AutomaticMemoryEvent): boolean {
  const text = eventText(event);
  return text !== null && SECRET_SIGNAL.test(text);
}

function count(
  database: Database.Database,
  table: string,
  where = "",
): number {
  return Number(
    (
      database
        .prepare(`SELECT count(*) AS count FROM ${table} ${where}`)
        .get() as { count: number }
    ).count,
  );
}

export class AutomaticMemoryRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  registerProject(input: unknown): AutomaticMemoryProject {
    const command = RegisterAutomaticMemoryProjectCommandSchema.parse(input);
    const projectId = stableIdentifier("project", {
      principal_id: command.principal_id,
      identity_hash: command.identity.identity_hash,
    });
    this.#database
      .prepare(
        `INSERT INTO automatic_memory_projects (
           project_id, principal_id, identity_kind, identity_hash,
           scope_kind, scope_id, registered_at, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(principal_id, identity_hash) DO NOTHING`,
      )
      .run(
        projectId,
        command.principal_id,
        command.identity.identity_kind,
        command.identity.identity_hash,
        command.identity.scope.kind,
        command.identity.scope.id,
        command.registered_at,
        command.schema_version,
      );
    const row = this.#projectByIdentity(
      command.principal_id,
      command.identity.identity_hash,
    );
    if (
      row === undefined ||
      row.project_id !== projectId ||
      row.identity_kind !== command.identity.identity_kind ||
      row.scope_kind !== command.identity.scope.kind ||
      row.scope_id !== command.identity.scope.id
    ) {
      throw new StorageError("CONFLICT");
    }
    return this.#project(row);
  }

  capture(input: unknown): AutomaticMemoryCaptureReceipt {
    const command = CaptureAutomaticMemoryEventCommandSchema.parse(input);
    if (eventContainsSecretSignal(command.event)) {
      throw new StorageError("INVALID_INPUT");
    }
    const requestHash = canonicalSha256({
      schema_version: command.schema_version,
      idempotency_key: command.idempotency_key,
      principal_id: command.principal_id,
      project_id: command.project_id,
      evidence_id: command.evidence_id,
      captured_at: command.captured_at,
      stabilization_delay_ms: command.stabilization_delay_ms,
      event: command.event,
    });
    const existing = this.#existingCapture(command.idempotency_key);
    if (existing !== undefined) {
      return this.#parseExistingCapture(existing, requestHash);
    }
    const eventReplay = this.#database
      .prepare(
        `SELECT request_hash, receipt_json FROM automatic_memory_events
         WHERE event_id = ?`,
      )
      .get(command.event.event_id) as ExistingCaptureRow | undefined;
    if (eventReplay !== undefined) {
      return this.#parseExistingCapture(eventReplay, requestHash);
    }

    const project = this.#projectById(command.project_id);
    if (project === undefined || project.principal_id !== command.principal_id) {
      throw new StorageError("INVALID_INPUT");
    }
    this.#validateEvidence(command, project);

    const turnIdentity = eventTurnIdentity(command.event);
    const turnKey =
      turnIdentity === null
        ? null
        : stableIdentifier("turn", {
            principal_id: command.principal_id,
            project_id: command.project_id,
            session_id: command.event.session_id,
            turn_id: turnIdentity.turnId,
          });
    const jobId = turnKey === null ? null : stableIdentifier("formation", turnKey);
    const existingTurn =
      turnKey === null ? undefined : this.#turn(turnKey);
    const isSuperseded =
      command.event.event_kind === "assistant_stop" &&
      existingTurn !== undefined &&
      command.event.generation < existingTurn.active_generation;
    const willPair =
      !isSuperseded &&
      turnKey !== null &&
      (command.event.event_kind === "user_prompt_submit"
        ? existingTurn?.assistant_event_id !== null &&
          existingTurn?.assistant_event_id !== undefined
        : command.event.event_kind === "assistant_stop"
          ? existingTurn?.user_event_id !== null &&
            existingTurn?.user_event_id !== undefined
          : false);
    const receipt = AutomaticMemoryCaptureReceiptSchema.parse({
      schema_version: "1.0.0",
      capture_id: stableIdentifier("capture", {
        idempotency_key: command.idempotency_key,
        request_hash: requestHash,
      }),
      project_id: command.project_id,
      event_id: command.event.event_id,
      turn_key: turnKey,
      formation_job_id: willPair ? jobId : null,
      state:
        turnKey === null
          ? "recorded"
          : isSuperseded
            ? "superseded"
            : willPair
              ? "stabilizing"
              : "waiting_for_pair",
      recorded_at: command.captured_at,
    });

    try {
      return this.#database
        .transaction(() => {
          const repeated = this.#existingCapture(command.idempotency_key);
          if (repeated !== undefined) {
            return this.#parseExistingCapture(repeated, requestHash);
          }
          this.#insertEvent(command, requestHash, receipt);
          if (turnKey !== null && !isSuperseded) {
            this.#upsertTurn(command, turnKey);
            this.#upsertJobIfPaired(command, turnKey, jobId as string);
          }
          return receipt;
        })
        .immediate();
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("UNIQUE constraint failed") ||
          error.message.includes("FOREIGN KEY constraint failed"))
      ) {
        throw new StorageError("CONFLICT");
      }
      throw error;
    }
  }

  claim(input: unknown): ClaimAutomaticMemoryFormationJobsResult {
    const command = ClaimAutomaticMemoryFormationJobsInputSchema.parse(input);
    return this.#database
      .transaction(() => {
        const exhausted = this.#database
          .prepare(
            `SELECT job_id, turn_key, generation, attempts
             FROM automatic_memory_formation_jobs
             WHERE status = 'processing' AND lease_expires_at <= ?
               AND attempts >= ?
             ORDER BY job_id`,
          )
          .all(
            command.claimed_at,
            MAX_AUTOMATIC_MEMORY_FORMATION_ATTEMPTS,
          ) as Array<{
          job_id: string;
          turn_key: string;
          generation: number;
          attempts: number;
        }>;
        for (const job of exhausted) {
          this.#database
            .prepare(
              `UPDATE automatic_memory_formation_jobs
               SET status = 'quarantined', claimed_by = NULL,
                   lease_expires_at = NULL, updated_at = ?
               WHERE job_id = ?`,
            )
            .run(command.claimed_at, job.job_id);
          this.#database
            .prepare(
              `UPDATE automatic_memory_turns
               SET state = 'quarantined', updated_at = ? WHERE turn_key = ?`,
            )
            .run(command.claimed_at, job.turn_key);
          this.#database
            .prepare(
              `INSERT INTO automatic_memory_failures (
                 failure_id, job_id, event_id, generation, stage,
                 error_code, retryable, recorded_at
               ) VALUES (?, ?, NULL, ?, 'formation',
                         'lease_retry_exhausted', 0, ?)`,
            )
            .run(
              stableIdentifier("failure", {
                job_id: job.job_id,
                generation: job.generation,
                attempt: job.attempts,
                error_code: "lease_retry_exhausted",
              }),
              job.job_id,
              job.generation,
              command.claimed_at,
            );
        }
        const rows = this.#database
          .prepare(
            `SELECT job_id FROM automatic_memory_formation_jobs
             WHERE (
               status = 'pending' AND available_at <= ? AND attempts < ?
             ) OR (
               status = 'processing' AND lease_expires_at <= ? AND attempts < ?
             )
             ORDER BY available_at, job_id
             LIMIT ?`,
          )
          .all(
            command.claimed_at,
            MAX_AUTOMATIC_MEMORY_FORMATION_ATTEMPTS,
            command.claimed_at,
            MAX_AUTOMATIC_MEMORY_FORMATION_ATTEMPTS,
            command.limit,
          ) as Array<{
          job_id: string;
        }>;
        for (const row of rows) {
          this.#database
            .prepare(
              `UPDATE automatic_memory_formation_jobs
               SET status = 'processing', attempts = attempts + 1,
                   claimed_by = ?, lease_expires_at = ?, updated_at = ?
               WHERE job_id = ?`,
            )
            .run(
              command.worker_id,
              command.lease_expires_at,
              command.claimed_at,
              row.job_id,
            );
          this.#database
            .prepare(
              `UPDATE automatic_memory_turns
               SET state = 'ready', updated_at = ? WHERE turn_key = (
                 SELECT turn_key FROM automatic_memory_formation_jobs
                 WHERE job_id = ?
               )`,
            )
            .run(command.claimed_at, row.job_id);
        }
        return ClaimAutomaticMemoryFormationJobsResultSchema.parse({
          jobs: rows.map((row) => this.#formationJob(row.job_id)),
        });
      })
      .immediate();
  }

  complete(input: unknown): AutomaticMemoryFormationJobMutationResult {
    const command = CompleteAutomaticMemoryFormationJobCommandSchema.parse(input);
    return this.#database
      .transaction(() => {
        const job = this.#jobMutation(command.job_id);
        if (
          job.status === "completed" &&
          job.generation === command.generation &&
          job.result_hash === command.result_hash
        ) {
          return AutomaticMemoryFormationJobMutationResultSchema.parse({
            job_id: job.job_id,
            generation: job.generation,
            state: "completed",
            attempts: job.attempts,
          });
        }
        if (
          job.status !== "processing" ||
          job.generation !== command.generation ||
          job.claimed_by !== command.worker_id
        ) {
          throw new StorageError("CONFLICT");
        }
        this.#database
          .prepare(
            `UPDATE automatic_memory_formation_jobs
             SET status = 'completed', claimed_by = NULL,
                 lease_expires_at = NULL, result_hash = ?,
                 completed_at = ?, updated_at = ?
             WHERE job_id = ?`,
          )
          .run(
            command.result_hash,
            command.completed_at,
            command.completed_at,
            command.job_id,
          );
        this.#database
          .prepare(
            `UPDATE automatic_memory_turns
             SET state = 'completed', updated_at = ? WHERE turn_key = (
               SELECT turn_key FROM automatic_memory_formation_jobs
               WHERE job_id = ?
             )`,
          )
          .run(command.completed_at, command.job_id);
        return AutomaticMemoryFormationJobMutationResultSchema.parse({
          job_id: command.job_id,
          generation: command.generation,
          state: "completed",
          attempts: job.attempts,
        });
      })
      .immediate();
  }

  fail(input: unknown): AutomaticMemoryFormationJobMutationResult {
    const command = FailAutomaticMemoryFormationJobCommandSchema.parse(input);
    return this.#database
      .transaction(() => {
        const job = this.#jobMutation(command.job_id);
        if (
          job.status !== "processing" ||
          job.generation !== command.generation ||
          job.claimed_by !== command.worker_id
        ) {
          throw new StorageError("CONFLICT");
        }
        const terminal = job.attempts >= command.max_attempts;
        const state = terminal ? "quarantined" : "pending";
        this.#database
          .prepare(
            `UPDATE automatic_memory_formation_jobs
             SET status = ?, available_at = ?, claimed_by = NULL,
                 lease_expires_at = NULL, updated_at = ?
             WHERE job_id = ?`,
          )
          .run(
            state,
            command.next_available_at,
            command.failed_at,
            command.job_id,
          );
        this.#database
          .prepare(
            `INSERT INTO automatic_memory_failures (
               failure_id, job_id, event_id, generation, stage,
               error_code, retryable, recorded_at
             ) VALUES (?, ?, NULL, ?, 'formation', ?, ?, ?)`,
          )
          .run(
            stableIdentifier("failure", {
              job_id: command.job_id,
              generation: command.generation,
              attempt: job.attempts,
            }),
            command.job_id,
            command.generation,
            command.error_code,
            terminal ? 0 : 1,
            command.failed_at,
          );
        if (terminal) {
          this.#database
            .prepare(
              `UPDATE automatic_memory_turns
               SET state = 'quarantined', updated_at = ? WHERE turn_key = (
                 SELECT turn_key FROM automatic_memory_formation_jobs
                 WHERE job_id = ?
               )`,
            )
            .run(command.failed_at, command.job_id);
        }
        return AutomaticMemoryFormationJobMutationResultSchema.parse({
          job_id: command.job_id,
          generation: command.generation,
          state,
          attempts: job.attempts,
        });
      })
      .immediate();
  }

  recordFormationAudit(input: unknown): RecordAutomaticMemoryFormationAuditResult {
    const command = RecordAutomaticMemoryFormationAuditCommandSchema.parse(input);
    return this.#database
      .transaction(() => {
        const job = this.#jobMutation(command.job_id);
        if (
          job.generation !== command.generation ||
          job.attempts !== command.attempt ||
          (job.status !== "processing" && job.status !== "completed")
        ) {
          throw new StorageError("CONFLICT");
        }
        const attemptId = stableIdentifier("provider_attempt", {
          job_id: command.job_id,
          generation: command.generation,
          attempt: command.attempt,
        });
        let inserted = 0;
        inserted += this.#database
          .prepare(
            `INSERT INTO automatic_memory_provider_attempts (
               attempt_id, job_id, generation, attempt, provider_id, model,
               prompt_version, policy_version, schema_revision, request_hash,
               result_hash, redaction_json, input_tokens, output_tokens,
               latency_ms, cost_microusd, state, started_at, completed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                       'succeeded', ?, ?)
             ON CONFLICT(job_id, generation, attempt) DO NOTHING`,
          )
          .run(
            attemptId,
            command.job_id,
            command.generation,
            command.attempt,
            command.provider_id,
            command.model,
            command.prompt_version,
            command.policy_version,
            command.schema_revision,
            command.request_hash,
            command.result_hash,
            canonicalJson(command.redaction),
            command.input_tokens,
            command.output_tokens,
            command.latency_ms,
            command.cost_microusd,
            command.started_at,
            command.completed_at,
          ).changes;
        const attempt = this.#database
          .prepare(
            `SELECT attempt_id, provider_id, model, prompt_version,
                    policy_version, schema_revision, request_hash, result_hash,
                    redaction_json, input_tokens, output_tokens, latency_ms,
                    cost_microusd, state, started_at, completed_at
             FROM automatic_memory_provider_attempts
             WHERE job_id = ? AND generation = ? AND attempt = ?`,
          )
          .get(
            command.job_id,
            command.generation,
            command.attempt,
          ) as {
          attempt_id: string;
          provider_id: string;
          model: string;
          prompt_version: string;
          policy_version: string;
          schema_revision: string;
          request_hash: string;
          result_hash: string | null;
          redaction_json: string;
          input_tokens: number;
          output_tokens: number;
          latency_ms: number;
          cost_microusd: number | null;
          state: string;
          started_at: string;
          completed_at: string | null;
        } | undefined;
        if (
          attempt === undefined ||
          attempt.attempt_id !== attemptId ||
          attempt.provider_id !== command.provider_id ||
          attempt.model !== command.model ||
          attempt.prompt_version !== command.prompt_version ||
          attempt.policy_version !== command.policy_version ||
          attempt.schema_revision !== command.schema_revision ||
          attempt.request_hash !== command.request_hash ||
          attempt.result_hash !== command.result_hash ||
          attempt.redaction_json !== canonicalJson(command.redaction) ||
          attempt.input_tokens !== command.input_tokens ||
          attempt.output_tokens !== command.output_tokens ||
          attempt.latency_ms !== command.latency_ms ||
          attempt.cost_microusd !== command.cost_microusd ||
          attempt.state !== "succeeded" ||
          attempt.started_at !== command.started_at ||
          attempt.completed_at !== command.completed_at
        ) {
          throw new StorageError("CONFLICT");
        }

        let decisionCount = 0;
        let admissionCount = 0;
        for (const item of command.decisions) {
          const decision = item.decision;
          const decisionHash = canonicalSha256(decision);
          const decisionInsert = this.#database
            .prepare(
              `INSERT INTO automatic_memory_policy_decisions (
                 decision_id, job_id, generation, proposal_id,
                 decision_hash, decision_json, disposition, decided_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(job_id, generation, proposal_id) DO NOTHING`,
            )
            .run(
              decision.decision_id,
              command.job_id,
              command.generation,
              decision.proposal_id,
              decisionHash,
              canonicalJson(decision),
              decision.disposition,
              decision.decided_at,
            ).changes;
          inserted += decisionInsert;
          decisionCount += 1;
          const persistedDecision = this.#database
            .prepare(
              `SELECT decision_id, decision_hash, decision_json,
                      disposition, decided_at
               FROM automatic_memory_policy_decisions
               WHERE job_id = ? AND generation = ? AND proposal_id = ?`,
            )
            .get(
              command.job_id,
              command.generation,
              decision.proposal_id,
            ) as {
            decision_id: string;
            decision_hash: string;
            decision_json: string;
            disposition: string;
            decided_at: string;
          } | undefined;
          if (
            persistedDecision === undefined ||
            persistedDecision.decision_id !== decision.decision_id ||
            persistedDecision.decision_hash !== decisionHash ||
            persistedDecision.decision_json !== canonicalJson(decision) ||
            persistedDecision.disposition !== decision.disposition ||
            persistedDecision.decided_at !== decision.decided_at
          ) {
            throw new StorageError("CONFLICT");
          }
          if (item.admission === null) {
            continue;
          }
          const linkId = stableIdentifier("admission_link", decision.decision_id);
          const linkInsert = this.#database
            .prepare(
              `INSERT INTO automatic_memory_admission_links (
                 link_id, decision_id, candidate_id, memory_id, revision_id,
                 admission_receipt_id, linked_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(decision_id) DO NOTHING`,
            )
            .run(
              linkId,
              decision.decision_id,
              item.admission.candidate_id,
              item.admission.memory_id,
              item.admission.revision_id,
              item.admission.receipt_id,
              command.completed_at,
            ).changes;
          inserted += linkInsert;
          admissionCount += 1;
          const persistedLink = this.#database
            .prepare(
              `SELECT link_id, candidate_id, memory_id, revision_id,
                      admission_receipt_id, linked_at
               FROM automatic_memory_admission_links WHERE decision_id = ?`,
            )
            .get(decision.decision_id) as {
            link_id: string;
            candidate_id: string | null;
            memory_id: string | null;
            revision_id: string | null;
            admission_receipt_id: string | null;
            linked_at: string;
          } | undefined;
          if (
            persistedLink === undefined ||
            persistedLink.link_id !== linkId ||
            persistedLink.candidate_id !== item.admission.candidate_id ||
            persistedLink.memory_id !== item.admission.memory_id ||
            persistedLink.revision_id !== item.admission.revision_id ||
            persistedLink.admission_receipt_id !== item.admission.receipt_id ||
            persistedLink.linked_at !== command.completed_at
          ) {
            throw new StorageError("CONFLICT");
          }
        }
        return RecordAutomaticMemoryFormationAuditResultSchema.parse({
          attempt_id: attemptId,
          policy_decisions: decisionCount,
          admission_links: admissionCount,
          replayed: inserted === 0,
        });
      })
      .immediate();
  }

  checkConflict(input: unknown): CheckAutomaticMemoryConflictResult {
    const query = CheckAutomaticMemoryConflictInputSchema.parse(input);
    const row = this.#database
      .prepare(
        `SELECT 1
         FROM memory_objects AS o
         JOIN memory_revisions AS r ON r.revision_id = o.current_revision_id
         WHERE o.principal_id = ?
           AND o.scope_kind = ?
           AND o.scope_id = ?
           AND o.logical_key_hash = ?
           AND o.lifecycle IN ('active', 'candidate')
           AND r.purged_at IS NULL
           AND r.content_hash <> ?
         LIMIT 1`,
      )
      .get(
        query.principal_id,
        query.scope.kind,
        query.scope.id,
        logicalKeyHash(query.logical_key),
        query.proposed_content_hash,
      );
    return CheckAutomaticMemoryConflictResultSchema.parse({
      has_conflict: row !== undefined,
    });
  }

  recordRecallUse(input: unknown): RecordAutomaticMemoryRecallUseResult {
    const command = RecordAutomaticMemoryRecallUseCommandSchema.parse(input);
    const recallUseId = stableIdentifier("recall_use", {
      project_id: command.project_id,
      session_id: command.session_id,
      turn_id: command.turn_id,
      request_hash: command.request_hash,
    });
    const result = this.#database
      .prepare(
        `INSERT INTO automatic_memory_recall_uses (
           recall_use_id, project_id, session_id, turn_id, request_hash,
           retrieval_receipt_id, context_slice_id, memory_count,
           token_count, used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, session_id, turn_id, request_hash) DO NOTHING`,
      )
      .run(
        recallUseId,
        command.project_id,
        command.session_id,
        command.turn_id,
        command.request_hash,
        command.retrieval_receipt_id,
        command.context_slice_id,
        command.memory_count,
        command.token_count,
        command.used_at,
      );
    const persisted = this.#database
      .prepare(
        `SELECT recall_use_id, retrieval_receipt_id, context_slice_id,
                memory_count, token_count, used_at
         FROM automatic_memory_recall_uses
         WHERE project_id = ? AND session_id = ? AND turn_id = ?
           AND request_hash = ?`,
      )
      .get(
        command.project_id,
        command.session_id,
        command.turn_id,
        command.request_hash,
      ) as {
      recall_use_id: string;
      retrieval_receipt_id: string | null;
      context_slice_id: string | null;
      memory_count: number;
      token_count: number;
      used_at: string;
    } | undefined;
    if (
      persisted === undefined ||
      persisted.recall_use_id !== recallUseId ||
      persisted.retrieval_receipt_id !== command.retrieval_receipt_id ||
      persisted.context_slice_id !== command.context_slice_id ||
      persisted.memory_count !== command.memory_count ||
      persisted.token_count !== command.token_count ||
      persisted.used_at !== command.used_at
    ) {
      throw new StorageError("CONFLICT");
    }
    return RecordAutomaticMemoryRecallUseResultSchema.parse({
      recall_use_id: recallUseId,
      replayed: result.changes === 0,
    });
  }

  listActivity(input: unknown): AutomaticMemoryActivityResult {
    const query = AutomaticMemoryActivityQuerySchema.parse(input);
    const rows = this.#database
      .prepare(
        `SELECT t.turn_key, t.project_id, p.scope_kind, p.scope_id,
                t.session_id, t.turn_id, t.active_generation, t.state,
                ue.captured_at AS user_captured_at,
                ae.captured_at AS assistant_captured_at,
                j.job_id, j.status AS job_status, j.attempts,
                j.updated_at AS job_updated_at
         FROM automatic_memory_turns AS t
         JOIN automatic_memory_projects AS p ON p.project_id = t.project_id
         LEFT JOIN automatic_memory_events AS ue
           ON ue.event_id = t.user_event_id
         LEFT JOIN automatic_memory_events AS ae
           ON ae.event_id = t.assistant_event_id
         LEFT JOIN automatic_memory_formation_jobs AS j
           ON j.turn_key = t.turn_key
         WHERE t.principal_id = ?
         ORDER BY t.updated_at DESC, t.turn_key
         LIMIT ?`,
      )
      .all(
        query.principal_id,
        query.limit,
      ) as ActivityRow[];
    const items = rows.map((row) => {
      const provider = row.job_id === null
        ? undefined
        : this.#database
            .prepare(
              `SELECT provider_id, model, state, redaction_json, input_tokens,
                      output_tokens, latency_ms, completed_at
               FROM automatic_memory_provider_attempts
               WHERE job_id = ? AND generation = ?
               ORDER BY attempt DESC LIMIT 1`,
            )
            .get(row.job_id, row.active_generation) as {
            provider_id: string;
            model: string;
            state: "started" | "succeeded" | "failed";
            redaction_json: string;
            input_tokens: number;
            output_tokens: number;
            latency_ms: number;
            completed_at: string | null;
          } | undefined;
      const decisionRows = row.job_id === null
        ? []
        : this.#database
            .prepare(
              `SELECT d.decision_json, l.candidate_id, l.memory_id,
                      l.revision_id, l.admission_receipt_id,
                      o.scope_kind AS memory_scope_kind,
                      o.scope_id AS memory_scope_id,
                      o.lifecycle AS current_lifecycle
               FROM automatic_memory_policy_decisions AS d
               LEFT JOIN automatic_memory_admission_links AS l
                 ON l.decision_id = d.decision_id
               LEFT JOIN memory_objects AS o ON o.memory_id = l.memory_id
               WHERE d.job_id = ? AND d.generation = ?
               ORDER BY d.decision_id`,
            )
            .all(row.job_id, row.active_generation) as Array<{
            decision_json: string;
            candidate_id: string | null;
            memory_id: string | null;
            revision_id: string | null;
            admission_receipt_id: string | null;
            memory_scope_kind: "thread" | "topic" | "scenario" | "user" | "workspace" | "agent" | null;
            memory_scope_id: string | null;
            current_lifecycle: Lifecycle | null;
          }>;
      return {
        turn_key: row.turn_key,
        project_id: row.project_id,
        scope: { kind: row.scope_kind, id: row.scope_id },
        session_id: row.session_id,
        turn_id: row.turn_id,
        generation: row.active_generation,
        state: row.state,
        user_captured_at: row.user_captured_at,
        assistant_captured_at: row.assistant_captured_at,
        job: row.job_id === null || row.job_status === null ||
            row.attempts === null || row.job_updated_at === null
          ? null
          : {
              job_id: row.job_id,
              status: row.job_status,
              attempts: row.attempts,
              updated_at: row.job_updated_at,
            },
        provider: provider === undefined
          ? null
          : {
              provider_id: provider.provider_id,
              model: provider.model,
              state: provider.state,
              redaction_action: RedactionReportSchema.parse(
                JSON.parse(provider.redaction_json) as unknown,
              ).action,
              input_tokens: provider.input_tokens,
              output_tokens: provider.output_tokens,
              latency_ms: provider.latency_ms,
              completed_at: provider.completed_at,
            },
        decisions: decisionRows.map((decisionRow) => {
          const decision = AutomaticMemoryPolicyDecisionSchema.parse(
            JSON.parse(decisionRow.decision_json) as unknown,
          );
          return {
            decision_id: decision.decision_id,
            proposal_id: decision.proposal_id,
            disposition: decision.disposition,
            reason_codes: decision.reason_codes,
            requires_user_confirmation: decision.requires_user_confirmation,
            decided_at: decision.decided_at,
            candidate_id: decisionRow.candidate_id,
            memory_id: decisionRow.memory_id,
            revision_id: decisionRow.revision_id,
            receipt_id: decisionRow.admission_receipt_id,
            memory_scope:
              decisionRow.memory_scope_kind === null ||
                decisionRow.memory_scope_id === null
                ? null
                : {
                    kind: decisionRow.memory_scope_kind,
                    id: decisionRow.memory_scope_id,
                  },
            current_lifecycle: decisionRow.current_lifecycle,
          };
        }),
      };
    });
    const status = this.status();
    return AutomaticMemoryActivityResultSchema.parse({
      status: items.length === 0 ? "ready_empty" : "ready",
      overview: {
        projects: status.projects,
        events: status.events,
        turns: status.turns,
        pending: status.jobs_pending + status.jobs_processing,
        completed: status.jobs_completed,
        quarantined: status.jobs_quarantined,
        recall_uses: status.recall_uses,
      },
      items,
      warnings: [],
    });
  }

  lookupAutomaticAdmission(input: unknown): AutomaticMemoryAdmissionLookupResult {
    const query = AutomaticMemoryAdmissionLookupInputSchema.parse(input);
    const row = this.#database
      .prepare(
        `SELECT o.scope_kind, o.scope_id, d.decision_id
         FROM automatic_memory_admission_links AS l
         JOIN automatic_memory_policy_decisions AS d
           ON d.decision_id = l.decision_id
         JOIN automatic_memory_formation_jobs AS j ON j.job_id = d.job_id
         JOIN automatic_memory_turns AS t ON t.turn_key = j.turn_key
         JOIN automatic_memory_projects AS p ON p.project_id = t.project_id
         JOIN memory_objects AS o ON o.memory_id = l.memory_id
         WHERE t.principal_id = ? AND l.memory_id = ? AND l.revision_id = ?
           AND d.disposition = 'activate'
         LIMIT 1`,
      )
      .get(
        query.principal_id,
        query.memory_id,
        query.revision_id,
      ) as {
      scope_kind: "thread" | "topic" | "scenario" | "user" | "workspace" | "agent";
      scope_id: string;
      decision_id: string;
    } | undefined;
    if (row === undefined) {
      return null;
    }
    const scope = { kind: row.scope_kind, id: row.scope_id } as const;
    return AutomaticMemoryAdmissionLookupResultSchema.parse({
      scope,
      decision_id: row.decision_id,
    });
  }

  status(): AutomaticMemoryStatus {
    return AutomaticMemoryStatusSchema.parse({
      projects: count(this.#database, "automatic_memory_projects"),
      events: count(this.#database, "automatic_memory_events"),
      turns: count(this.#database, "automatic_memory_turns"),
      jobs_pending: count(
        this.#database,
        "automatic_memory_formation_jobs",
        "WHERE status = 'pending'",
      ),
      jobs_processing: count(
        this.#database,
        "automatic_memory_formation_jobs",
        "WHERE status = 'processing'",
      ),
      jobs_completed: count(
        this.#database,
        "automatic_memory_formation_jobs",
        "WHERE status = 'completed'",
      ),
      jobs_quarantined: count(
        this.#database,
        "automatic_memory_formation_jobs",
        "WHERE status = 'quarantined'",
      ),
      provider_attempts: count(
        this.#database,
        "automatic_memory_provider_attempts",
      ),
      policy_decisions: count(
        this.#database,
        "automatic_memory_policy_decisions",
      ),
      admission_links: count(
        this.#database,
        "automatic_memory_admission_links",
      ),
      recall_uses: count(this.#database, "automatic_memory_recall_uses"),
      failures: count(this.#database, "automatic_memory_failures"),
    });
  }

  #validateEvidence(
    command: ParsedCaptureAutomaticMemoryEventCommand,
    project: ProjectRow,
  ): void {
    if (command.evidence_id === null) {
      return;
    }
    const evidence = this.#database
      .prepare(
        `SELECT principal_id, scope_kind, scope_id, payload_storage,
                payload_inline, sensitivity
         FROM evidence_events WHERE evidence_id = ?`,
      )
      .get(command.evidence_id) as EvidenceRow | undefined;
    if (
      evidence === undefined ||
      evidence.principal_id !== command.principal_id ||
      evidence.scope_kind !== project.scope_kind ||
      evidence.scope_id !== project.scope_id ||
      evidence.payload_storage !== "inline" ||
      evidence.payload_inline !== eventText(command.event) ||
      ["sensitive", "secret"].includes(evidence.sensitivity)
    ) {
      throw new StorageError("INVALID_INPUT");
    }
  }

  #insertEvent(
    command: ParsedCaptureAutomaticMemoryEventCommand,
    requestHash: string,
    receipt: AutomaticMemoryCaptureReceipt,
  ): void {
    const identity = eventTurnIdentity(command.event);
    this.#database
      .prepare(
        `INSERT INTO automatic_memory_events (
           capture_id, event_id, idempotency_key, request_hash, principal_id,
           project_id, session_id, turn_id, event_kind, generation,
           evidence_id, payload_hash, source, occurred_at, captured_at,
           receipt_json, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.capture_id,
        command.event.event_id,
        command.idempotency_key,
        requestHash,
        command.principal_id,
        command.project_id,
        command.event.session_id,
        identity?.turnId ?? null,
        command.event.event_kind,
        identity?.generation ?? null,
        command.evidence_id,
        canonicalSha256(command.event),
        command.source,
        command.event.occurred_at,
        command.captured_at,
        canonicalJson(receipt),
        command.schema_version,
      );
  }

  #upsertTurn(
    command: ParsedCaptureAutomaticMemoryEventCommand,
    turnKey: string,
  ): void {
    if (
      command.event.event_kind !== "user_prompt_submit" &&
      command.event.event_kind !== "assistant_stop"
    ) {
      return;
    }
    const existing = this.#turn(turnKey);
    if (existing === undefined) {
      const assistant = command.event.event_kind === "assistant_stop";
      const dueAt = assistant
        ? new Date(
            Date.parse(command.captured_at) + command.stabilization_delay_ms,
          ).toISOString()
        : null;
      this.#database
        .prepare(
          `INSERT INTO automatic_memory_turns (
             turn_key, principal_id, project_id, session_id, turn_id,
             user_event_id, user_evidence_id, assistant_event_id,
             assistant_evidence_id, active_generation, state,
             stabilization_due_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turnKey,
          command.principal_id,
          command.project_id,
          command.event.session_id,
          command.event.turn_id,
          assistant ? null : command.event.event_id,
          assistant ? null : command.evidence_id,
          assistant ? command.event.event_id : null,
          assistant ? command.evidence_id : null,
          assistant ? command.event.generation : 0,
          "open",
          dueAt,
          command.captured_at,
          command.captured_at,
        );
      return;
    }
    if (command.event.event_kind === "user_prompt_submit") {
      if (
        existing.user_event_id !== null &&
        existing.user_event_id !== command.event.event_id
      ) {
        throw new StorageError("CONFLICT");
      }
      this.#database
        .prepare(
          `UPDATE automatic_memory_turns
           SET user_event_id = ?, user_evidence_id = ?, updated_at = ?
           WHERE turn_key = ?`,
        )
        .run(
          command.event.event_id,
          command.evidence_id,
          command.captured_at,
          turnKey,
        );
      return;
    }
    const dueAt = new Date(
      Date.parse(command.captured_at) + command.stabilization_delay_ms,
    ).toISOString();
    this.#database
      .prepare(
        `UPDATE automatic_memory_turns
         SET assistant_event_id = ?, assistant_evidence_id = ?,
             active_generation = ?, stabilization_due_at = ?,
             state = CASE WHEN user_event_id IS NULL THEN 'open'
                          ELSE 'stabilizing' END,
             updated_at = ?
         WHERE turn_key = ?`,
      )
      .run(
        command.event.event_id,
        command.evidence_id,
        command.event.generation,
        dueAt,
        command.captured_at,
        turnKey,
      );
  }

  #upsertJobIfPaired(
    command: ParsedCaptureAutomaticMemoryEventCommand,
    turnKey: string,
    jobId: string,
  ): void {
    const turn = this.#turn(turnKey);
    if (
      turn === undefined ||
      turn.user_event_id === null ||
      turn.user_evidence_id === null ||
      turn.assistant_event_id === null ||
      turn.assistant_evidence_id === null ||
      turn.stabilization_due_at === null
    ) {
      return;
    }
    const existing = this.#database
      .prepare(
        `SELECT generation FROM automatic_memory_formation_jobs
         WHERE job_id = ?`,
      )
      .get(jobId) as { generation: number } | undefined;
    if (existing === undefined) {
      this.#database
        .prepare(
          `INSERT INTO automatic_memory_formation_jobs (
             job_id, turn_key, generation, status, attempts, available_at,
             claimed_by, lease_expires_at, result_hash, created_at,
             updated_at, completed_at
           ) VALUES (?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          jobId,
          turnKey,
          turn.active_generation,
          turn.stabilization_due_at,
          command.captured_at,
          command.captured_at,
        );
    } else if (turn.active_generation > existing.generation) {
      this.#database
        .prepare(
          `UPDATE automatic_memory_formation_jobs
           SET generation = ?, status = 'pending', attempts = 0,
               available_at = ?, claimed_by = NULL, lease_expires_at = NULL,
               result_hash = NULL, completed_at = NULL, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(
          turn.active_generation,
          turn.stabilization_due_at,
          command.captured_at,
          jobId,
        );
    }
    this.#database
      .prepare(
        `UPDATE automatic_memory_turns
         SET state = 'stabilizing', updated_at = ? WHERE turn_key = ?`,
      )
      .run(command.captured_at, turnKey);
  }

  #formationJob(jobId: string): AutomaticMemoryFormationJob {
    const row = this.#database
      .prepare(
        `SELECT j.job_id, j.turn_key, t.project_id,
                p.identity_hash AS project_identity_hash, t.principal_id,
                p.scope_kind, p.scope_id, t.session_id, t.turn_id,
                j.generation, t.user_event_id, t.assistant_event_id,
                t.user_evidence_id, t.assistant_evidence_id, j.status,
                j.attempts, j.available_at, j.claimed_by, j.lease_expires_at
         FROM automatic_memory_formation_jobs AS j
         JOIN automatic_memory_turns AS t ON t.turn_key = j.turn_key
         JOIN automatic_memory_projects AS p ON p.project_id = t.project_id
         WHERE j.job_id = ?`,
      )
      .get(jobId) as FormationJobRow | undefined;
    if (row === undefined) {
      throw new StorageError("CORRUPTION");
    }
    return AutomaticMemoryFormationJobSchema.parse({
      schema_version: "1.0.0",
      job_id: row.job_id,
      turn_key: row.turn_key,
      project_id: row.project_id,
      project_identity_hash: row.project_identity_hash,
      principal_id: row.principal_id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      session_id: row.session_id,
      turn_id: row.turn_id,
      generation: row.generation,
      user_event_id: row.user_event_id,
      assistant_event_id: row.assistant_event_id,
      user_evidence_id: row.user_evidence_id,
      assistant_evidence_id: row.assistant_evidence_id,
      status: row.status,
      attempts: row.attempts,
      available_at: row.available_at,
      claimed_by: row.claimed_by,
      lease_expires_at: row.lease_expires_at,
    });
  }

  #jobMutation(jobId: string): JobMutationRow {
    const row = this.#database
      .prepare(
        `SELECT job_id, generation, status, attempts, claimed_by, result_hash
         FROM automatic_memory_formation_jobs WHERE job_id = ?`,
      )
      .get(jobId) as JobMutationRow | undefined;
    if (row === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    return row;
  }

  #turn(turnKey: string): TurnRow | undefined {
    return this.#database
      .prepare(
        `SELECT turn_key, user_event_id, user_evidence_id,
                assistant_event_id, assistant_evidence_id,
                active_generation, stabilization_due_at
         FROM automatic_memory_turns WHERE turn_key = ?`,
      )
      .get(turnKey) as TurnRow | undefined;
  }

  #existingCapture(idempotencyKey: string): ExistingCaptureRow | undefined {
    return this.#database
      .prepare(
        `SELECT request_hash, receipt_json FROM automatic_memory_events
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as ExistingCaptureRow | undefined;
  }

  #parseExistingCapture(
    row: ExistingCaptureRow,
    requestHash: string,
  ): AutomaticMemoryCaptureReceipt {
    if (row.request_hash !== requestHash) {
      throw new StorageError("CONFLICT");
    }
    return AutomaticMemoryCaptureReceiptSchema.parse(
      JSON.parse(row.receipt_json) as unknown,
    );
  }

  #projectById(projectId: string): ProjectRow | undefined {
    return this.#database
      .prepare(
        `SELECT project_id, principal_id, identity_kind, identity_hash,
                scope_kind, scope_id, registered_at
         FROM automatic_memory_projects WHERE project_id = ?`,
      )
      .get(projectId) as ProjectRow | undefined;
  }

  #projectByIdentity(
    principalId: string,
    identityHash: string,
  ): ProjectRow | undefined {
    return this.#database
      .prepare(
        `SELECT project_id, principal_id, identity_kind, identity_hash,
                scope_kind, scope_id, registered_at
         FROM automatic_memory_projects
         WHERE principal_id = ? AND identity_hash = ?`,
      )
      .get(principalId, identityHash) as ProjectRow | undefined;
  }

  #project(row: ProjectRow): AutomaticMemoryProject {
    return AutomaticMemoryProjectSchema.parse({
      schema_version: "1.0.0",
      project_id: row.project_id,
      principal_id: row.principal_id,
      identity_kind: row.identity_kind,
      identity_hash: row.identity_hash,
      scope: { kind: row.scope_kind, id: row.scope_id },
      registered_at: row.registered_at,
    });
  }
}

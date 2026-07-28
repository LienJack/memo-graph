import {
  candidateHasPromptInjectionSignal,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  logicalKeyHash,
  normalizeLogicalKey,
  MutationReceiptSchema,
  approvalGrantMatches,
  receiptHashIsValid,
  scopeKey,
  sealReceipt,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import {
  enqueueProjectionRefresh,
  suppressProjectionDescendants,
} from "./projection-effects.js";
import {
  GovernanceMutationResultSchema,
  MemoryCorrectionBasisSchema,
  type ContentReferenceCounts,
  type GovernanceCounts,
  type GovernanceMutationResult,
  type MemoryCorrectionBasis,
  type ParsedMemoryCorrectionBasisInput,
  type ParsedAdmitMemoryCommand,
  type ParsedMemoryRevisionCommand,
} from "./protocol.js";

type AdmissionDecision = "activate" | "candidate_only" | "quarantine";
type GovernedLifecycle = "active" | "candidate" | "quarantined";

type EvidenceAdmissionRow = {
  evidence_id: string;
  principal_id: string;
  actor_authority: string;
  authority: string;
  sensitivity: string;
  scope_kind: string;
  scope_id: string;
  purged_at: string | null;
};

type MemoryRow = {
  memory_id: string;
  principal_id: string;
  scope_kind: string;
  scope_id: string;
  kind: string;
  lifecycle: GovernedLifecycle;
  current_revision_id: string | null;
};

type RevisionRow = {
  revision_id: string;
  memory_id: string;
  revision: number;
  lifecycle: GovernedLifecycle;
  content_hash: string;
};

type ExistingGovernanceMutation = {
  request_hash: string;
  receipt_json: string;
  result_json: string | null;
};

type CorrectionBasisRow = {
  current_revision_id: string;
  logical_key: string;
  kind: "episodic" | "semantic" | "procedural";
  scope_kind:
    | "thread"
    | "topic"
    | "scenario"
    | "user"
    | "workspace"
    | "agent";
  scope_id: string;
  sensitivity: "public" | "internal" | "personal" | "sensitive" | "secret";
  inferred: number;
  injection_risk: "none" | "suspected" | "confirmed";
  requires_user_confirmation: number;
  transform_name: string;
  transform_version: string;
};

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

function stableIdentifier(prefix: string, value: unknown): string {
  return `${prefix}:${canonicalSha256(value).slice("sha256:".length, 55)}`;
}

function lifecycleFor(decision: AdmissionDecision): GovernedLifecycle {
  switch (decision) {
    case "activate":
      return "active";
    case "candidate_only":
      return "candidate";
    case "quarantine":
      return "quarantined";
  }
}

function decisionRank(decision: AdmissionDecision): number {
  switch (decision) {
    case "activate":
      return 0;
    case "candidate_only":
      return 1;
    case "quarantine":
      return 2;
  }
}

function authorityFor(evidence: EvidenceAdmissionRow[]): string {
  const rank = new Map([
    ["user_stated", 0],
    ["inferred", 1],
    ["derived", 2],
    ["observed", 3],
    ["tool_result", 4],
    ["imported", 5],
  ]);
  return evidence
    .flatMap((item) => [item.actor_authority, item.authority])
    .sort(
      (left, right) =>
        (rank.get(right) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(left) ?? Number.MAX_SAFE_INTEGER),
    )[0] ?? "derived";
}

function sensitivityFor(
  candidateSensitivity: string,
  evidence: EvidenceAdmissionRow[],
): string {
  const ordered = [
    "public",
    "internal",
    "personal",
    "sensitive",
    "secret",
  ];
  return [candidateSensitivity, ...evidence.map((item) => item.sensitivity)]
    .sort(
      (left, right) =>
        ordered.indexOf(right) - ordered.indexOf(left),
  )[0] ?? candidateSensitivity;
}

function evidenceIndicatesInference(
  evidence: EvidenceAdmissionRow[],
): boolean {
  return evidence.some(
    (item) =>
      ["inferred", "derived"].includes(item.actor_authority) ||
      ["inferred", "derived"].includes(item.authority),
  );
}

export class GovernanceRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  counts(): GovernanceCounts {
    return {
      memory_candidates: count(this.#database, "memory_candidates"),
      memory_objects: count(this.#database, "memory_objects"),
      memory_revisions: count(this.#database, "memory_revisions"),
      admission_decisions: count(this.#database, "admission_decisions"),
      conflict_groups: count(this.#database, "memory_conflict_groups"),
      status_events: count(this.#database, "memory_status_events"),
      pin_events: count(this.#database, "memory_pin_events"),
      usage_rules: count(this.#database, "memory_usage_rules"),
    };
  }

  contentReferenceCounts(contentHash: string): ContentReferenceCounts {
    const countHash = (table: string): number =>
      Number(
        (
          this.#database
            .prepare(
              `SELECT count(*) AS count FROM ${table} WHERE content_hash = ?`,
            )
            .get(contentHash) as { count: number }
        ).count,
      );
    const evidenceEvents = countHash("evidence_events");
    const memoryCandidates = countHash("memory_candidates");
    const memoryRevisions = countHash("memory_revisions");
    const artifacts = countHash("artifacts");
    const liveRevisionLinks = Number(
      (
        this.#database
          .prepare(
            `SELECT count(DISTINCT r.revision_id) AS count
             FROM memory_revision_evidence AS re
             JOIN evidence_events AS e
               ON e.evidence_id = re.evidence_id
             JOIN memory_revisions AS r
               ON r.revision_id = re.revision_id
             JOIN memory_objects AS m
               ON m.memory_id = r.memory_id
             WHERE e.content_hash = ?
               AND m.lifecycle = 'active'
               AND r.lifecycle = 'active'`,
          )
          .get(contentHash) as { count: number }
      ).count,
    );

    return {
      content_hash: contentHash,
      evidence_events: evidenceEvents,
      memory_candidates: memoryCandidates,
      memory_revisions: memoryRevisions,
      live_revision_links: liveRevisionLinks,
      artifacts,
      total:
        evidenceEvents + memoryCandidates + memoryRevisions + artifacts,
    };
  }

  admitMemory(
    command: ParsedAdmitMemoryCommand,
  ): GovernanceMutationResult {
    const requestHash = canonicalSha256(command.request);
    const existing = this.#readMutation(
      command.request.envelope.idempotency_key,
    );
    if (existing !== undefined) {
      return this.#parseExistingResult(existing, requestHash);
    }

    return this.governedWrite("admit_memory", () => {
      const repeated = this.#readMutation(
        command.request.envelope.idempotency_key,
      );
      if (repeated !== undefined) {
        return this.#parseExistingResult(repeated, requestHash);
      }
      const candidate = command.request.candidate;
      const evidence = this.#validateCandidate(
        candidate,
        command.request.envelope.actor_claim.principal_id,
        command.evaluation.decision,
      );
      this.#insertCandidate(
        candidate,
        command.request.envelope.actor_claim.principal_id,
        evidence,
      );

      const logicalHash = logicalKeyHash(candidate.logical_key);
      const existingMemory = this.#database
        .prepare(
          `SELECT memory_id, principal_id, scope_kind, scope_id, kind,
                  lifecycle, current_revision_id
           FROM memory_objects
           WHERE principal_id = ?
             AND scope_kind = ?
             AND scope_id = ?
             AND kind = ?
             AND logical_key_hash = ?`,
        )
        .get(
          command.request.envelope.actor_claim.principal_id,
          candidate.scope.kind,
          candidate.scope.id,
          candidate.kind,
          logicalHash,
        ) as MemoryRow | undefined;

      if (existingMemory === undefined) {
        return this.#createMemory({
          idempotencyKey: command.request.envelope.idempotency_key,
          requestHash,
          principalId:
            command.request.envelope.actor_claim.principal_id,
          actorAuthority:
            command.request.envelope.actor_claim.authority,
          requestedAt: command.request.envelope.requested_at,
          candidate,
          evidence,
          logicalHash,
          decision: command.evaluation.decision,
          reason: command.evaluation.reason,
          outcome: "CREATED",
          supersedes: null,
          revisionNumber: 1,
        });
      }
      if (existingMemory.current_revision_id === null) {
        throw new StorageError("CORRUPTION");
      }
      const current = this.#readRevision(
        existingMemory.current_revision_id,
      );
      if (current.content_hash === candidate.content_hash) {
        this.#linkCandidate(
          candidate.candidate_id,
          existingMemory.memory_id,
          current.revision_id,
          command.request.envelope.requested_at,
        );
        const currentDecision = this.#readAdmission(current.revision_id);
        return this.#sealMutation({
          idempotencyKey: command.request.envelope.idempotency_key,
          requestHash,
          principalId:
            command.request.envelope.actor_claim.principal_id,
          scope: candidate.scope,
          requestedAt: command.request.envelope.requested_at,
          outcome: "REUSED",
          candidateId: candidate.candidate_id,
          memoryId: existingMemory.memory_id,
          currentRevisionId: current.revision_id,
          conflictGroupId: null,
          lifecycle: existingMemory.lifecycle,
          decision: currentDecision,
          previousRevisionId: null,
          projectionJobs: [],
          warnings: [],
        });
      }
      return this.#openConflict({
        idempotencyKey: command.request.envelope.idempotency_key,
        requestHash,
        principalId:
          command.request.envelope.actor_claim.principal_id,
        requestedAt: command.request.envelope.requested_at,
        candidateId: candidate.candidate_id,
        memory: existingMemory,
        current,
        logicalHash,
        scope: candidate.scope,
      });
    });
  }

  applyMemoryRevision(
    command: ParsedMemoryRevisionCommand,
  ): GovernanceMutationResult {
    const requestHash =
      command.request_hash ??
      canonicalSha256Omitting(command, [
        "evaluation",
        "request_hash",
        "approval_binding",
        "approval",
      ]);
    const existing = this.#readMutation(command.idempotency_key);
    if (existing !== undefined) {
      return this.#parseExistingResult(existing, requestHash);
    }

    return this.governedWrite("apply_memory_revision", () => {
      const repeated = this.#readMutation(command.idempotency_key);
      if (repeated !== undefined) {
        return this.#parseExistingResult(repeated, requestHash);
      }
      this.#validateRevisionApproval(command, requestHash);
      const memory = this.#database
        .prepare(
          `SELECT memory_id, principal_id, scope_kind, scope_id, kind,
                  lifecycle, current_revision_id
           FROM memory_objects WHERE memory_id = ?`,
        )
        .get(command.memory_id) as MemoryRow | undefined;
      if (
        memory === undefined ||
        memory.principal_id !== command.principal_id ||
        memory.scope_kind !== command.scope.kind ||
        memory.scope_id !== command.scope.id ||
        memory.kind !== command.candidate.kind ||
        logicalKeyHash(command.candidate.logical_key) !==
          String(
            (
              this.#database
                .prepare(
                  `SELECT logical_key_hash FROM memory_objects
                   WHERE memory_id = ?`,
                )
                .get(command.memory_id) as { logical_key_hash: string }
            ).logical_key_hash,
          )
      ) {
        throw new StorageError("INVALID_INPUT");
      }
      if (memory.current_revision_id !== command.expected_revision_id) {
        throw new StorageError("STALE_REVISION");
      }
      const conflict = this.#database
        .prepare(
          `SELECT 1 FROM memory_conflict_groups
           WHERE principal_id = ? AND scope_kind = ? AND scope_id = ?
             AND logical_key_hash = ? AND status = 'open'`,
        )
        .get(
          command.principal_id,
          command.scope.kind,
          command.scope.id,
          logicalKeyHash(command.candidate.logical_key),
        );
      if (conflict !== undefined) {
        throw new StorageError("CONFLICT");
      }
      const evidence = this.#validateCandidate(
        command.candidate,
        command.principal_id,
        command.evaluation.decision,
      );
      const current = this.#readRevision(command.expected_revision_id);
      if (command.dry_run) {
        return this.#sealMutation({
          idempotencyKey: command.idempotency_key,
          requestHash,
          principalId: command.principal_id,
          scope: command.scope,
          requestedAt: command.requested_at,
          outcome: "DRY_RUN",
          candidateId: command.candidate.candidate_id,
          memoryId: command.memory_id,
          currentRevisionId: current.revision_id,
          conflictGroupId: null,
          lifecycle: memory.lifecycle,
          decision: command.evaluation.decision,
          previousRevisionId: null,
          projectionJobs: [],
          warnings: ["DRY_RUN"],
          advanceEpoch: false,
        });
      }
      this.#insertCandidate(
        command.candidate,
        command.principal_id,
        evidence,
      );
      if (current.content_hash === command.candidate.content_hash) {
        this.#linkCandidate(
          command.candidate.candidate_id,
          command.memory_id,
          current.revision_id,
          command.requested_at,
        );
        const result = this.#sealMutation({
          idempotencyKey: command.idempotency_key,
          requestHash,
          principalId: command.principal_id,
          scope: command.scope,
          requestedAt: command.requested_at,
          outcome: "REUSED",
          candidateId: command.candidate.candidate_id,
          memoryId: command.memory_id,
          currentRevisionId: current.revision_id,
          conflictGroupId: null,
          lifecycle: memory.lifecycle,
          decision: this.#readAdmission(current.revision_id),
          previousRevisionId: null,
          projectionJobs: [],
          warnings: [],
        });
        this.#consumeRevisionApproval(command, requestHash, result);
        return result;
      }
      const result = this.#createMemory({
        idempotencyKey: command.idempotency_key,
        requestHash,
        principalId: command.principal_id,
        actorAuthority: command.actor_authority,
        requestedAt: command.requested_at,
        candidate: command.candidate,
        evidence,
        logicalHash: logicalKeyHash(command.candidate.logical_key),
        decision: command.evaluation.decision,
        reason: command.evaluation.reason,
        outcome: "REVISED",
        supersedes: current,
        revisionNumber: Number(current.revision) + 1,
        existingMemory: memory,
      });
      this.#consumeRevisionApproval(command, requestHash, result);
      return result;
    });
  }

  correctionBasis(
    input: ParsedMemoryCorrectionBasisInput,
  ): MemoryCorrectionBasis | null {
    const row = this.#database
      .prepare(
        `SELECT m.current_revision_id, c.logical_key, m.kind,
                m.scope_kind, m.scope_id, r.sensitivity, r.inferred,
                c.injection_risk, c.requires_user_confirmation,
                r.transform_name, r.transform_version
         FROM memory_objects AS m
         JOIN memory_revisions AS r
           ON r.revision_id = m.current_revision_id
         JOIN memory_candidate_links AS l
           ON l.memory_id = m.memory_id
          AND l.revision_id = r.revision_id
         JOIN memory_candidates AS c
           ON c.candidate_id = l.candidate_id
         WHERE m.memory_id = ?
           AND m.principal_id = ?
           AND m.scope_kind = ?
           AND m.scope_id = ?
           AND m.current_revision_id = ?`,
      )
      .get(
        input.memory_id,
        input.principal_id,
        input.scope.kind,
        input.scope.id,
        input.expected_revision_id,
      ) as CorrectionBasisRow | undefined;
    return row === undefined
      ? null
      : MemoryCorrectionBasisSchema.parse({
          current_revision_id: row.current_revision_id,
          logical_key: row.logical_key,
          kind: row.kind,
          scope: { kind: row.scope_kind, id: row.scope_id },
          sensitivity: row.sensitivity,
          inferred: row.inferred === 1,
          injection_risk: row.injection_risk,
          requires_user_confirmation:
            row.requires_user_confirmation === 1,
          transform: {
            name: row.transform_name,
            version: row.transform_version,
          },
        });
  }

  #validateRevisionApproval(
    command: ParsedMemoryRevisionCommand,
    requestHash: string,
  ): void {
    const approval = command.approval;
    const binding = command.approval_binding;
    if (
      approval === undefined &&
      binding === undefined &&
      command.request_hash === undefined
    ) {
      return;
    }
    if (
      approval === undefined ||
      binding === undefined ||
      command.request_hash !== requestHash ||
      binding.request_hash !== requestHash ||
      binding.principal_id !== command.principal_id ||
      binding.tool !== "memory_correct" ||
      !binding.scopes.some(
        (scope) => scopeKey(scope) === scopeKey(command.scope),
      ) ||
      !approvalGrantMatches(
        binding,
        approval.grant,
        approval.verified_at,
      ) ||
      this.#database
        .prepare(
          "SELECT 1 FROM approval_consumptions WHERE approval_id = ?",
        )
        .get(approval.grant.approval_id) !== undefined
    ) {
      throw new StorageError("APPROVAL_INVALID");
    }
  }

  #consumeRevisionApproval(
    command: ParsedMemoryRevisionCommand,
    requestHash: string,
    result: GovernanceMutationResult,
  ): void {
    const approval = command.approval;
    const binding = command.approval_binding;
    if (approval === undefined && binding === undefined) {
      return;
    }
    if (approval === undefined || binding === undefined) {
      throw new StorageError("APPROVAL_INVALID");
    }
    try {
      this.#database
        .prepare(
          `INSERT INTO approval_consumptions (
             approval_id, idempotency_key, request_hash, manifest_hash,
             principal_id, tool, scopes_json, consumed_at, receipt_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          approval.grant.approval_id,
          command.idempotency_key,
          requestHash,
          approval.grant.manifest_hash,
          command.principal_id,
          binding.tool,
          canonicalJson(
            [...binding.scopes].sort((left, right) =>
              scopeKey(left).localeCompare(scopeKey(right)),
            ),
          ),
          approval.verified_at,
          result.receipt.receipt_id,
        );
    } catch {
      throw new StorageError("APPROVAL_INVALID");
    }
  }

  replayMutation(
    idempotencyKey: string,
    requestHash: string,
  ): GovernanceMutationResult | null {
    const existing = this.#readMutation(idempotencyKey);
    return existing === undefined
      ? null
      : this.#parseExistingResult(existing, requestHash);
  }

  governedWrite<T>(operation: string, effect: () => T): T {
    return this.#database
      .transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO governance_write_guard (
               singleton, operation, opened_at
             ) VALUES (1, ?, ?)`,
          )
          .run(operation, new Date().toISOString());
        try {
          return effect();
        } finally {
          this.#database
            .prepare(
              "DELETE FROM governance_write_guard WHERE singleton = 1",
            )
            .run();
        }
      })
      .immediate();
  }

  #validateCandidate(
    candidate: ParsedAdmitMemoryCommand["request"]["candidate"],
    principalId: string,
    requestedDecision: AdmissionDecision,
  ): EvidenceAdmissionRow[] {
    if (
      new Set(candidate.evidence_ids).size !==
      candidate.evidence_ids.length
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    if (
      candidate.content.storage === "inline" &&
      canonicalSha256(candidate.content) !== candidate.content_hash
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    if (
      candidate.content.storage === "blob" &&
      candidate.content.content_hash !== candidate.content_hash
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    if (candidate.sensitivity === "secret") {
      throw new StorageError("ENCRYPTION_REQUIRED");
    }
    const evidence = this.#database
      .prepare(
        `SELECT evidence_id, principal_id, actor_authority, authority,
                sensitivity, scope_kind, scope_id, purged_at
         FROM evidence_events
         WHERE evidence_id IN (
           SELECT value FROM json_each(?)
         )
         ORDER BY evidence_id`,
      )
      .all(canonicalJson(candidate.evidence_ids)) as EvidenceAdmissionRow[];
    if (
      evidence.length !== candidate.evidence_ids.length ||
      evidence.some(
        (item) =>
          item.principal_id !== principalId ||
          item.scope_kind !== candidate.scope.kind ||
          item.scope_id !== candidate.scope.id ||
          item.purged_at !== null,
      )
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const required = this.#minimumAdmission(candidate, evidence);
    if (decisionRank(requestedDecision) < decisionRank(required)) {
      throw new StorageError("INVALID_INPUT");
    }
    return evidence;
  }

  #minimumAdmission(
    candidate: ParsedAdmitMemoryCommand["request"]["candidate"],
    evidence: EvidenceAdmissionRow[],
  ): AdmissionDecision {
    const authorities = evidence.flatMap((item) => [
      item.actor_authority,
      item.authority,
    ]);
    if (
      candidateHasPromptInjectionSignal(candidate) ||
      candidate.sensitivity === "sensitive" ||
      evidence.some((item) => item.sensitivity === "sensitive") ||
      authorities.some((authority) =>
        ["observed", "tool_result", "imported"].includes(authority),
      )
    ) {
      return "quarantine";
    }
    if (
      candidate.inferred ||
      candidate.requires_user_confirmation ||
      authorities.some((authority) =>
        ["inferred", "derived"].includes(authority),
      )
    ) {
      return "candidate_only";
    }
    return "activate";
  }

  #insertCandidate(
    candidate: ParsedAdmitMemoryCommand["request"]["candidate"],
    principalId: string,
    evidence: EvidenceAdmissionRow[],
  ): void {
    const injectionRisk =
      candidate.injection_risk === "none" &&
      candidateHasPromptInjectionSignal(candidate)
        ? "suspected"
        : candidate.injection_risk;
    this.#database
      .prepare(
        `INSERT INTO memory_candidates (
           candidate_id, logical_key, logical_key_hash, principal_id,
           scope_kind, scope_id, kind, sensitivity, inferred,
           content_storage, content_inline, content_blob_hash, media_type,
           content_hash, valid_from, valid_to, recorded_at, injection_risk,
           requires_user_confirmation, transform_name, transform_version,
           created_at, purged_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, NULL
         )`,
      )
      .run(
        candidate.candidate_id,
        normalizeLogicalKey(candidate.logical_key),
        logicalKeyHash(candidate.logical_key),
        principalId,
        candidate.scope.kind,
        candidate.scope.id,
        candidate.kind,
        sensitivityFor(candidate.sensitivity, evidence),
        candidate.inferred || evidenceIndicatesInference(evidence) ? 1 : 0,
        candidate.content.storage,
        candidate.content.storage === "inline"
          ? candidate.content.text
          : null,
        candidate.content.storage === "blob"
          ? candidate.content.content_hash
          : null,
        candidate.content.media_type,
        candidate.content_hash,
        candidate.validity.valid_from,
        candidate.validity.valid_to,
        candidate.validity.recorded_at,
        injectionRisk,
        candidate.requires_user_confirmation || injectionRisk !== "none"
          ? 1
          : 0,
        candidate.transform.name,
        candidate.transform.version,
        candidate.validity.recorded_at,
      );
    const insertEvidence = this.#database.prepare(
      `INSERT INTO memory_candidate_evidence (candidate_id, evidence_id)
       VALUES (?, ?)`,
    );
    for (const evidenceId of [...candidate.evidence_ids].sort()) {
      insertEvidence.run(candidate.candidate_id, evidenceId);
    }
  }

  #createMemory(options: {
    idempotencyKey: string;
    requestHash: string;
    principalId: string;
    actorAuthority: string;
    requestedAt: string;
    candidate: ParsedAdmitMemoryCommand["request"]["candidate"];
    evidence: EvidenceAdmissionRow[];
    logicalHash: string;
    decision: AdmissionDecision;
    reason: string;
    outcome: "CREATED" | "REVISED";
    supersedes: RevisionRow | null;
    revisionNumber: number;
    existingMemory?: MemoryRow;
  }): GovernanceMutationResult {
    const lifecycle = lifecycleFor(options.decision);
    const memoryId =
      options.existingMemory?.memory_id ??
      stableIdentifier("memory", {
        principal_id: options.principalId,
        scope: options.candidate.scope,
        kind: options.candidate.kind,
        logical_key_hash: options.logicalHash,
      });
    const revisionId = stableIdentifier("revision", {
      memory_id: memoryId,
      revision: options.revisionNumber,
      content_hash: options.candidate.content_hash,
      evidence_ids: [...options.candidate.evidence_ids].sort(),
      transform: options.candidate.transform,
    });
    if (options.existingMemory === undefined) {
      this.#database
        .prepare(
          `INSERT INTO memory_objects (
             memory_id, logical_key_hash, principal_id, scope_kind, scope_id,
             kind, lifecycle, current_revision_id, pinned, context_eligible,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          memoryId,
          options.logicalHash,
          options.principalId,
          options.candidate.scope.kind,
          options.candidate.scope.id,
          options.candidate.kind,
          lifecycle,
          revisionId,
          lifecycle === "active" ? 1 : 0,
          options.requestedAt,
          options.requestedAt,
        );
    }
    this.#insertRevision({
      revisionId,
      memoryId,
      revisionNumber: options.revisionNumber,
      lifecycle,
      candidate: options.candidate,
      evidence: options.evidence,
      supersedesRevisionId: options.supersedes?.revision_id ?? null,
      createdAt: options.requestedAt,
    });
    this.#linkCandidate(
      options.candidate.candidate_id,
      memoryId,
      revisionId,
      options.requestedAt,
    );
    this.#insertAdmission({
      memoryId,
      revisionId,
      candidateId: options.candidate.candidate_id,
      principalId: options.principalId,
      actorAuthority: options.actorAuthority,
      decidedAt: options.requestedAt,
      decision: options.decision,
      reason: options.reason,
      requiresUserConfirmation:
        options.candidate.requires_user_confirmation ||
        candidateHasPromptInjectionSignal(options.candidate),
    });

    if (options.existingMemory !== undefined) {
      const updated = this.#database
        .prepare(
          `UPDATE memory_objects
           SET lifecycle = ?, current_revision_id = ?,
               context_eligible = ?, updated_at = ?
           WHERE memory_id = ? AND current_revision_id = ?`,
        )
        .run(
          lifecycle,
          revisionId,
          lifecycle === "active" ? 1 : 0,
          options.requestedAt,
          memoryId,
          options.supersedes?.revision_id,
        );
      if (updated.changes !== 1) {
        throw new StorageError("STALE_REVISION");
      }
      this.#insertStatus({
        memoryId,
        revisionId: options.supersedes?.revision_id as string,
        action: "suppress",
        lifecycle: "superseded",
        principalId: options.principalId,
        actorAuthority: options.actorAuthority,
        reason: "A governed successor replaced this revision",
        occurredAt: options.requestedAt,
      });
    }
    if (lifecycle === "active") {
      this.#insertStatus({
        memoryId,
        revisionId,
        action: "activate",
        lifecycle,
        principalId: options.principalId,
        actorAuthority: options.actorAuthority,
        reason: options.reason,
        occurredAt: options.requestedAt,
      });
    } else if (lifecycle === "candidate") {
      this.#insertStatus({
        memoryId,
        revisionId,
        action: "demote",
        lifecycle,
        principalId: options.principalId,
        actorAuthority: options.actorAuthority,
        reason: options.reason,
        occurredAt: options.requestedAt,
      });
    }

    const ftsProjectionJobs =
      lifecycle === "active"
        ? [
            ...(options.supersedes === null
              ? []
              : [
                  this.#insertOutbox(
                    "fts_memory_delete",
                    options.supersedes.revision_id,
                    options.requestedAt,
                  ),
                ]),
            this.#insertOutbox(
              "fts_memory_upsert",
              revisionId,
              options.requestedAt,
            ),
          ]
        : options.supersedes === null
          ? []
          : [
              this.#insertOutbox(
                "fts_memory_delete",
                options.supersedes.revision_id,
                options.requestedAt,
              ),
            ];
    const layeredProjectionJobs = [
      ...(options.supersedes === null
        ? []
        : [
            suppressProjectionDescendants(this.#database, {
              causeId: options.idempotencyKey,
              memoryId,
              revisionId: options.supersedes.revision_id,
              principalId: options.principalId,
              scope: options.candidate.scope,
              occurredAt: options.requestedAt,
            }),
          ]),
      ...(lifecycle === "active"
        ? [
            enqueueProjectionRefresh(this.#database, {
              causeId: options.idempotencyKey,
              memoryId,
              revisionId,
              principalId: options.principalId,
              scope: options.candidate.scope,
              occurredAt: options.requestedAt,
            }),
          ]
        : []),
    ];
    const projectionJobs = [
      ...ftsProjectionJobs,
      ...layeredProjectionJobs,
    ];

    return this.#sealMutation({
      idempotencyKey: options.idempotencyKey,
      requestHash: options.requestHash,
      principalId: options.principalId,
      scope: options.candidate.scope,
      requestedAt: options.requestedAt,
      outcome: options.outcome,
      candidateId: options.candidate.candidate_id,
      memoryId,
      currentRevisionId: revisionId,
      conflictGroupId: null,
      lifecycle,
      decision: options.decision,
      previousRevisionId: options.supersedes?.revision_id ?? null,
      projectionJobs,
      warnings: [],
    });
  }

  #insertRevision(options: {
    revisionId: string;
    memoryId: string;
    revisionNumber: number;
    lifecycle: GovernedLifecycle;
    candidate: ParsedAdmitMemoryCommand["request"]["candidate"];
    evidence: EvidenceAdmissionRow[];
    supersedesRevisionId: string | null;
    createdAt: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO memory_revisions (
           revision_id, memory_id, revision, abstraction, lifecycle, kind,
           scope_kind, scope_id, authority, sensitivity, valid_from, valid_to,
           recorded_at, inferred, content_storage, content_inline,
           content_blob_hash, media_type, content_hash,
           supersedes_revision_id, transform_name, transform_version,
           created_at, purged_at
         ) VALUES (
           ?, ?, ?, 'l1_memory', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, NULL
         )`,
      )
      .run(
        options.revisionId,
        options.memoryId,
        options.revisionNumber,
        options.lifecycle,
        options.candidate.kind,
        options.candidate.scope.kind,
        options.candidate.scope.id,
        authorityFor(options.evidence),
        sensitivityFor(
          options.candidate.sensitivity,
          options.evidence,
        ),
        options.candidate.validity.valid_from,
        options.candidate.validity.valid_to,
        options.candidate.validity.recorded_at,
        options.candidate.inferred ||
          evidenceIndicatesInference(options.evidence)
          ? 1
          : 0,
        options.candidate.content.storage,
        options.candidate.content.storage === "inline"
          ? options.candidate.content.text
          : null,
        options.candidate.content.storage === "blob"
          ? options.candidate.content.content_hash
          : null,
        options.candidate.content.media_type,
        options.candidate.content_hash,
        options.supersedesRevisionId,
        options.candidate.transform.name,
        options.candidate.transform.version,
        options.createdAt,
      );
    const insertEvidence = this.#database.prepare(
      `INSERT INTO memory_revision_evidence (revision_id, evidence_id)
       VALUES (?, ?)`,
    );
    for (const evidenceId of [...options.candidate.evidence_ids].sort()) {
      insertEvidence.run(options.revisionId, evidenceId);
    }
  }

  #insertAdmission(options: {
    memoryId: string;
    revisionId: string;
    candidateId: string;
    principalId: string;
    actorAuthority: string;
    decidedAt: string;
    decision: AdmissionDecision;
    reason: string;
    requiresUserConfirmation: boolean;
  }): void {
    const decisionId = stableIdentifier("decision", {
      candidate_id: options.candidateId,
      revision_id: options.revisionId,
      decision: options.decision,
    });
    this.#database
      .prepare(
        `INSERT INTO admission_decisions (
           decision_id, memory_id, revision_id, decision, principal_id,
           actor_authority, decided_at, reason, conflict_group_id,
           requires_user_confirmation, decision_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        decisionId,
        options.memoryId,
        options.revisionId,
        options.decision,
        options.principalId,
        options.actorAuthority,
        options.decidedAt,
        options.reason,
        options.requiresUserConfirmation ? 1 : 0,
        canonicalJson({
          schema_version: "1.0.0",
          decision_id: decisionId,
          memory_id: options.memoryId,
          revision_id: options.revisionId,
          decision: options.decision,
          decided_by: {
            principal_id: options.principalId,
            authority: options.actorAuthority,
          },
          decided_at: options.decidedAt,
          reason: options.reason,
          conflict_group_id: null,
          requires_user_confirmation:
            options.requiresUserConfirmation,
        }),
      );
  }

  #insertStatus(options: {
    memoryId: string;
    revisionId: string;
    action: "activate" | "demote" | "suppress";
    lifecycle: "active" | "candidate" | "superseded";
    principalId: string;
    actorAuthority: string;
    reason: string;
    occurredAt: string;
  }): void {
    const statusId = stableIdentifier("status", options);
    this.#database
      .prepare(
        `INSERT INTO memory_status_events (
           status_event_id, memory_id, revision_id, action, lifecycle,
           principal_id, actor_authority, reason, tombstone_epoch, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        statusId,
        options.memoryId,
        options.revisionId,
        options.action,
        options.lifecycle,
        options.principalId,
        options.actorAuthority,
        options.reason,
        options.occurredAt,
      );
  }

  #openConflict(options: {
    idempotencyKey: string;
    requestHash: string;
    principalId: string;
    requestedAt: string;
    candidateId: string;
    memory: MemoryRow;
    current: RevisionRow;
    logicalHash: string;
    scope: { kind: string; id: string };
  }): GovernanceMutationResult {
    const currentCandidate = this.#database
      .prepare(
        `SELECT candidate_id FROM memory_candidate_links
         WHERE memory_id = ? AND revision_id = ?
         ORDER BY linked_at, candidate_id LIMIT 1`,
      )
      .get(options.memory.memory_id, options.current.revision_id) as
      | { candidate_id: string }
      | undefined;
    if (currentCandidate === undefined) {
      throw new StorageError("CORRUPTION");
    }
    const existingGroup = this.#database
      .prepare(
        `SELECT conflict_group_id FROM memory_conflict_groups
         WHERE principal_id = ? AND scope_kind = ? AND scope_id = ?
           AND logical_key_hash = ? AND status = 'open'
         ORDER BY created_at, conflict_group_id LIMIT 1`,
      )
      .get(
        options.principalId,
        options.scope.kind,
        options.scope.id,
        options.logicalHash,
      ) as { conflict_group_id: string } | undefined;
    const conflictGroupId =
      existingGroup?.conflict_group_id ??
      stableIdentifier("conflict", {
        memory_id: options.memory.memory_id,
        current_revision_id: options.current.revision_id,
        candidate_id: options.candidateId,
      });
    if (existingGroup === undefined) {
      this.#database
        .prepare(
          `INSERT INTO memory_conflict_groups (
             conflict_group_id, logical_key_hash, principal_id, scope_kind,
             scope_id, status, resolved_revision_id, created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL)`,
        )
        .run(
          conflictGroupId,
          options.logicalHash,
          options.principalId,
          options.scope.kind,
          options.scope.id,
          options.requestedAt,
        );
    }
    const insertMember = this.#database.prepare(
      `INSERT INTO memory_conflict_candidates (
         conflict_group_id, candidate_id
       ) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    );
    insertMember.run(conflictGroupId, currentCandidate.candidate_id);
    insertMember.run(conflictGroupId, options.candidateId);
    this.#linkCandidate(
      options.candidateId,
      options.memory.memory_id,
      null,
      options.requestedAt,
    );
    const projectionJob = this.#insertOutbox(
      "fts_memory_invalidate",
      options.memory.memory_id,
      options.requestedAt,
    );
    const layeredProjectionJob = suppressProjectionDescendants(
      this.#database,
      {
        causeId: options.idempotencyKey,
        memoryId: options.memory.memory_id,
        revisionId: options.current.revision_id,
        principalId: options.principalId,
        scope: options.scope,
        occurredAt: options.requestedAt,
      },
    );
    return this.#sealMutation({
      idempotencyKey: options.idempotencyKey,
      requestHash: options.requestHash,
      principalId: options.principalId,
      scope: options.scope,
      requestedAt: options.requestedAt,
      outcome: "CONFLICT",
      candidateId: options.candidateId,
      memoryId: options.memory.memory_id,
      currentRevisionId: options.current.revision_id,
      conflictGroupId,
      lifecycle: options.memory.lifecycle,
      decision: null,
      previousRevisionId: null,
      projectionJobs: [projectionJob, layeredProjectionJob],
      warnings: ["OPEN_CONFLICT"],
    });
  }

  #linkCandidate(
    candidateId: string,
    memoryId: string,
    revisionId: string | null,
    linkedAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO memory_candidate_links (
           candidate_id, memory_id, revision_id, linked_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(candidateId, memoryId, revisionId, linkedAt);
  }

  #readRevision(revisionId: string): RevisionRow {
    const row = this.#database
      .prepare(
        `SELECT revision_id, memory_id, revision, lifecycle, content_hash
         FROM memory_revisions WHERE revision_id = ?`,
      )
      .get(revisionId) as RevisionRow | undefined;
    if (row === undefined) {
      throw new StorageError("CORRUPTION");
    }
    return row;
  }

  #readAdmission(revisionId: string): AdmissionDecision {
    const row = this.#database
      .prepare(
        `SELECT decision FROM admission_decisions
         WHERE revision_id = ?
         ORDER BY decided_at, decision_id LIMIT 1`,
      )
      .get(revisionId) as { decision: AdmissionDecision } | undefined;
    if (row === undefined) {
      throw new StorageError("CORRUPTION");
    }
    return row.decision;
  }

  #insertOutbox(
    kind: string,
    aggregateId: string,
    createdAt: string,
  ): string {
    const jobId = stableIdentifier("job", {
      kind,
      aggregate_id: aggregateId,
      created_at: createdAt,
    });
    this.#database
      .prepare(
        `INSERT INTO outbox_jobs (
           job_id, kind, aggregate_id, status, attempts, available_at,
           created_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(jobId, kind, aggregateId, createdAt, createdAt);
    this.#database
      .prepare(
        `UPDATE projection_state
         SET status = 'pending', updated_at = ?, error_code = NULL
         WHERE projection_name = 'memory_fts'`,
      )
      .run(createdAt);
    return jobId;
  }

  #sealMutation(options: {
    idempotencyKey: string;
    requestHash: string;
    principalId: string;
    scope: { kind: string; id: string };
    requestedAt: string;
    outcome: GovernanceMutationResult["outcome"];
    candidateId: string;
    memoryId: string;
    currentRevisionId: string;
    conflictGroupId: string | null;
    lifecycle: GovernedLifecycle;
    decision: AdmissionDecision | null;
    previousRevisionId: string | null;
    projectionJobs: string[];
    warnings: string[];
    advanceEpoch?: boolean;
  }): GovernanceMutationResult {
    const advancesEpoch = options.advanceEpoch ?? true;
    if (advancesEpoch) {
      this.#database
        .prepare(
          `UPDATE ledger_state
           SET ledger_epoch = ledger_epoch + 1, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(options.requestedAt);
    }
    const epoch = Number(
      (
        this.#database
          .prepare(
            "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
          )
          .get() as { ledger_epoch: number }
      ).ledger_epoch,
    );
    const receipt = MutationReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: stableIdentifier("receipt", {
          idempotency_key: options.idempotencyKey,
          request_hash: options.requestHash,
        }),
        created_at: options.requestedAt,
        state:
          options.projectionJobs.length > 0
            ? "projection_pending"
            : "durable",
        request_hash: options.requestHash,
        receipt_hash: `sha256:${"0".repeat(64)}`,
        kind: "mutation",
        idempotency_key: options.idempotencyKey,
        affected_memory_ids: advancesEpoch ? [options.memoryId] : [],
        affected_revision_ids:
          !advancesEpoch || options.outcome === "CONFLICT"
            ? []
            : [
                ...(options.previousRevisionId === null
                  ? []
                  : [options.previousRevisionId]),
                options.currentRevisionId,
              ],
        resulting_epoch: epoch,
        projection_jobs: options.projectionJobs,
        warnings: options.warnings,
      }),
    );
    this.#database
      .prepare(
        `INSERT INTO mutation_receipts (
           receipt_id, idempotency_key, request_hash, receipt_hash, state,
           resulting_epoch, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        receipt.idempotency_key,
        receipt.request_hash,
        receipt.receipt_hash,
        receipt.state,
        receipt.resulting_epoch,
        canonicalJson(receipt),
        receipt.created_at,
      );
    this.#database
      .prepare(
        `INSERT INTO idempotency_keys (
           idempotency_key, request_hash, receipt_id, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        options.idempotencyKey,
        options.requestHash,
        receipt.receipt_id,
        receipt.created_at,
      );
    this.#database
      .prepare(
        `INSERT INTO receipt_access_scopes (
           receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
           created_at
         ) VALUES (?, 'mutation', ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        options.principalId,
        options.scope.kind,
        options.scope.id,
        options.requestedAt,
      );
    const result = GovernanceMutationResultSchema.parse({
      receipt,
      replayed: false,
      outcome: options.outcome,
      candidate_id: options.candidateId,
      memory_id: options.memoryId,
      current_revision_id: options.currentRevisionId,
      conflict_group_id: options.conflictGroupId,
      lifecycle: options.lifecycle,
      decision: options.decision,
    });
    this.#database
      .prepare(
        `INSERT INTO governance_mutation_results (
           receipt_id, result_json, created_at
         ) VALUES (?, ?, ?)`,
      )
      .run(receipt.receipt_id, canonicalJson(result), options.requestedAt);
    return result;
  }

  #readMutation(
    idempotencyKey: string,
  ): ExistingGovernanceMutation | undefined {
    return this.#database
      .prepare(
        `SELECT i.request_hash, r.receipt_json, g.result_json
         FROM idempotency_keys AS i
         JOIN mutation_receipts AS r ON r.receipt_id = i.receipt_id
         LEFT JOIN governance_mutation_results AS g
           ON g.receipt_id = r.receipt_id
         WHERE i.idempotency_key = ?`,
      )
      .get(idempotencyKey) as ExistingGovernanceMutation | undefined;
  }

  #parseExistingResult(
    existing: ExistingGovernanceMutation,
    requestHash: string,
  ): GovernanceMutationResult {
    if (
      existing.request_hash !== requestHash ||
      existing.result_json === null
    ) {
      throw new StorageError("CONFLICT");
    }
    const receipt = MutationReceiptSchema.parse(
      JSON.parse(existing.receipt_json) as unknown,
    );
    const result = GovernanceMutationResultSchema.parse(
      JSON.parse(existing.result_json) as unknown,
    );
    if (
      !receiptHashIsValid(receipt) ||
      result.receipt.receipt_hash !== receipt.receipt_hash
    ) {
      throw new StorageError("CORRUPTION");
    }
    return { ...result, replayed: true };
  }
}

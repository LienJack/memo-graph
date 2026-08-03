import {
  AutomaticMemoryPolicyInputSchema,
  MemoryCandidateSchema,
  ProviderFormationRequestSchema,
  canonicalSha256,
  type AutomaticMemoryExclusionReason,
  type AutomaticMemoryPolicyDecision,
  type AutomaticMemoryPolicyMode,
  type EvidenceRecord,
  type FormationProposal,
  type MemoryCandidate,
  type ProviderFormationRequest,
  type Scope,
} from "@memo-graph/contracts";
import type { AutomaticMemoryFormationJob } from "@memo-graph/storage-sqlite";

import { evaluateAutomaticMemoryPolicy } from "./policy.js";
import type { MemoryFormationProvider } from "./provider.js";
import { redactProviderFormationTurns } from "./redaction.js";

export const AUTOMATIC_MEMORY_PROMPT_VERSION = "1.0.0";
export const AUTOMATIC_MEMORY_POLICY_VERSION = "1.0.0";
export const AUTOMATIC_MEMORY_SCHEMA_REVISION = "1.0.0";

export type AutomaticMemoryAdmissionReference = {
  decision_id?: string;
  candidate_id: string;
  memory_id: string | null;
  revision_id: string | null;
  receipt_id: string | null;
};

export type AutomaticMemoryFormationResult = {
  request: ProviderFormationRequest;
  decisions: AutomaticMemoryPolicyDecision[];
  admissions: AutomaticMemoryAdmissionReference[];
  provider_result_hash: `sha256:${string}`;
  provider_completed_at: string;
  provider_usage: { input_tokens: number; output_tokens: number };
  result_hash: `sha256:${string}`;
};

type FormationEvidenceLoader = (
  evidenceId: string,
  scope: Scope,
) => Promise<EvidenceRecord | null>;

const TEMPORARY_SIGNAL =
  /(?:\b(?:for this|this time|temporar(?:y|ily)|right now|one[- ]off)\b|(?:这次|本次|暂时|临时|先这样|仅当前))/iu;
const PROGRESS_SIGNAL =
  /(?:\b(?:implemented|finished|completed|tests? passed|done)\b|(?:已完成|实现完|测试通过|处理完))/iu;
const INJECTION_SIGNAL =
  /(?:\b(?:ignore|disregard|override|bypass)\b.{0,80}\b(?:instruction|prompt|policy|system|developer)\b|(?:忽略|绕过|覆盖).{0,40}(?:系统|开发者|提示词|策略))/iu;
const GLOBAL_PROCEDURAL_SIGNAL =
  /(?:\b(?:always|never)\b.{0,80}\b(?:tool|command|skill|instruction|workflow)\b|(?:以后|始终|永远).{0,40}(?:工具|命令|技能|指令|流程))/iu;

function stableIdentifier(prefix: string, value: unknown): string {
  return `${prefix}:${canonicalSha256(value).slice("sha256:".length, 48)}`;
}

function targetScope(
  proposal: FormationProposal,
  job: AutomaticMemoryFormationJob,
): Scope {
  return proposal.recommended_scope === "repository"
    ? job.scope
    : { kind: "user", id: job.principal_id };
}

function exclusions(
  proposal: FormationProposal,
  citedText: string,
): AutomaticMemoryExclusionReason[] {
  const result = new Set<AutomaticMemoryExclusionReason>();
  if (proposal.temporariness === "temporary" || TEMPORARY_SIGNAL.test(citedText)) {
    result.add("temporary_instruction");
  }
  if (PROGRESS_SIGNAL.test(`${proposal.summary}\n${citedText}`)) {
    result.add("task_progress");
  }
  if (proposal.authority_basis === "assistant_context_only") {
    result.add("assistant_speculation");
  }
  if (
    proposal.category === "confirmed_project_decision" &&
    proposal.authority_basis !== "user_confirmation"
  ) {
    result.add("unconfirmed_conclusion");
  }
  if (["sensitive", "secret"].includes(proposal.sensitivity)) {
    result.add("secret_or_sensitive");
  }
  if (
    proposal.recommended_scope === "global_user" &&
    proposal.category !== "stable_user_preference"
  ) {
    result.add("global_procedural_change");
  }
  return [...result];
}

export class MemoryFormationService {
  readonly #provider: MemoryFormationProvider;
  readonly #mode: AutomaticMemoryPolicyMode;
  readonly #model: string;
  readonly #loadEvidence: FormationEvidenceLoader;
  readonly #hasLocalConflict: (
    logicalKey: string,
    scope: Scope,
    proposedContentHash: `sha256:${string}`,
  ) => Promise<boolean>;
  readonly #propose: (
    candidate: MemoryCandidate,
    decision: AutomaticMemoryPolicyDecision,
    job: AutomaticMemoryFormationJob,
  ) => Promise<AutomaticMemoryAdmissionReference>;
  readonly #sensitiveIdentifiers: readonly string[];
  readonly #prepareEvidence: (
    evidenceIds: readonly string[],
    targetScope: Scope,
    job: AutomaticMemoryFormationJob,
  ) => Promise<string[]>;
  readonly #clock: () => string;

  constructor(options: {
    provider: MemoryFormationProvider;
    mode: AutomaticMemoryPolicyMode;
    model: string;
    loadEvidence: FormationEvidenceLoader;
    hasLocalConflict?: (
      logicalKey: string,
      scope: Scope,
      proposedContentHash: `sha256:${string}`,
    ) => Promise<boolean>;
    propose: (
      candidate: MemoryCandidate,
      decision: AutomaticMemoryPolicyDecision,
      job: AutomaticMemoryFormationJob,
    ) => Promise<AutomaticMemoryAdmissionReference>;
    sensitiveIdentifiers?: readonly string[];
    prepareEvidence?: (
      evidenceIds: readonly string[],
      targetScope: Scope,
      job: AutomaticMemoryFormationJob,
    ) => Promise<string[]>;
    clock?: () => string;
  }) {
    this.#provider = options.provider;
    this.#mode = options.mode;
    this.#model = options.model;
    this.#loadEvidence = options.loadEvidence;
    this.#hasLocalConflict = options.hasLocalConflict ?? (async () => false);
    this.#propose = options.propose;
    this.#sensitiveIdentifiers = options.sensitiveIdentifiers ?? [];
    this.#prepareEvidence = options.prepareEvidence ?? (
      async (evidenceIds) => [...evidenceIds]
    );
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async process(job: AutomaticMemoryFormationJob): Promise<AutomaticMemoryFormationResult> {
    const evidence = await Promise.all([
      this.#loadEvidence(job.user_evidence_id, job.scope),
      this.#loadEvidence(job.assistant_evidence_id, job.scope),
    ]);
    if (evidence.some((item) => item === null)) {
      throw new Error("FORMATION_EVIDENCE_MISSING");
    }
    const exactEvidence = evidence.filter(
      (item): item is EvidenceRecord => item !== null,
    );
    const rawTurns = exactEvidence.map((item) => ({
      evidence_id: item.evidence_id,
      role: item.authority === "user_stated" ? "user" as const : "assistant" as const,
      text: item.payload.storage === "inline" ? item.payload.text : "",
      content_hash: item.content_hash,
    }));
    if (rawTurns.some((turn) => turn.text.length === 0)) {
      throw new Error("FORMATION_EVIDENCE_NOT_INLINE");
    }
    const redacted = redactProviderFormationTurns({
      turns: rawTurns,
      sensitiveIdentifiers: this.#sensitiveIdentifiers,
    });
    const requestedAt = this.#clock();
    const request = ProviderFormationRequestSchema.parse({
      schema_version: "1.0.0",
      request_id: stableIdentifier("formation_request", {
        job_id: job.job_id,
        generation: job.generation,
        attempt: job.attempts,
      }),
      provider_id: this.#provider.id,
      model: this.#model,
      prompt_version: AUTOMATIC_MEMORY_PROMPT_VERSION,
      policy_version: AUTOMATIC_MEMORY_POLICY_VERSION,
      schema_revision: AUTOMATIC_MEMORY_SCHEMA_REVISION,
      requested_at: requestedAt,
      project_identity_hash: job.project_identity_hash,
      redaction: redacted.report,
      turns: redacted.turns,
    });
    const providerResult = await this.#provider.extract(request);
    if (
      providerResult.request_id !== request.request_id ||
      providerResult.provider_id !== request.provider_id ||
      providerResult.model !== request.model
    ) {
      throw new Error("FORMATION_PROVIDER_IDENTITY_MISMATCH");
    }
    const supplied = new Map(
      request.turns.map((turn) => [turn.evidence_id, turn]),
    );
    const originalById = new Map(exactEvidence.map((item) => [item.evidence_id, item]));
    const decisions: AutomaticMemoryPolicyDecision[] = [];
    const admissions: AutomaticMemoryAdmissionReference[] = [];
    for (const proposal of providerResult.proposals) {
      if (
        proposal.evidence.some((reference) => {
          const turn = supplied.get(reference.evidence_id);
          const original = originalById.get(reference.evidence_id);
          return turn === undefined ||
            original === undefined ||
            turn.content_hash !== reference.content_hash ||
            turn.role !== reference.speaker ||
            original.authority !== reference.authority;
        })
      ) {
        throw new Error("FORMATION_PROPOSAL_EVIDENCE_INVALID");
      }
      if (
        proposal.authority_basis === "user_confirmation" &&
        !proposal.evidence.some((item) => item.speaker === "assistant")
      ) {
        throw new Error("FORMATION_CONFIRMATION_CONTEXT_MISSING");
      }
      const scope = targetScope(proposal, job);
      const proposedContentHash = canonicalSha256({
        storage: "inline",
        text: proposal.summary,
        media_type: "text/plain",
      });
      const citedText = proposal.evidence
        .map((reference) => supplied.get(reference.evidence_id)?.text ?? "")
        .join("\n");
      const injectionRisk = INJECTION_SIGNAL.test(citedText)
        ? "confirmed" as const
        : "none" as const;
      const decision = evaluateAutomaticMemoryPolicy(
        AutomaticMemoryPolicyInputSchema.parse({
          schema_version: "1.0.0",
          decision_id: stableIdentifier("automatic_decision", {
            job_id: job.job_id,
            generation: job.generation,
            proposal_id: proposal.proposal_id,
          }),
          mode: this.#mode,
          policy_version: AUTOMATIC_MEMORY_POLICY_VERSION,
          decided_at: requestedAt,
          target_scope: scope,
          proposal,
          exclusions: exclusions(proposal, citedText),
          has_local_conflict: await this.#hasLocalConflict(
            proposal.logical_key,
            scope,
            proposedContentHash,
          ),
          injection_risk: injectionRisk,
          changes_global_behavior:
            proposal.recommended_scope === "global_user" &&
            GLOBAL_PROCEDURAL_SIGNAL.test(proposal.summary),
        }),
      );
      decisions.push(decision);
      if (decision.disposition === "reject") {
        continue;
      }
      const content = {
        storage: "inline" as const,
        text: proposal.summary,
        media_type: "text/plain",
      };
      const candidateEvidenceIds = await this.#prepareEvidence(
        proposal.evidence.map((item) => item.evidence_id),
        scope,
        job,
      );
      const candidate = MemoryCandidateSchema.parse({
        schema_version: "1.0.0",
        candidate_id: stableIdentifier("automatic_candidate", {
          job_id: job.job_id,
          generation: job.generation,
          proposal_id: proposal.proposal_id,
        }),
        logical_key: proposal.logical_key,
        kind: decision.memory_kind,
        scope,
        sensitivity: proposal.sensitivity,
        inferred: decision.disposition !== "activate",
        content,
        content_hash: proposedContentHash,
        evidence_ids: candidateEvidenceIds,
        validity: {
          valid_from: requestedAt,
          valid_to: null,
          recorded_at: requestedAt,
        },
        injection_risk: injectionRisk,
        requires_user_confirmation: decision.requires_user_confirmation,
        transform: {
          name: "automatic-memory-formation",
          version: AUTOMATIC_MEMORY_SCHEMA_REVISION,
        },
      });
      admissions.push({
        ...(await this.#propose(candidate, decision, job)),
        decision_id: decision.decision_id,
      });
    }
    return {
      request,
      decisions,
      admissions,
      provider_result_hash: canonicalSha256(providerResult),
      provider_completed_at: providerResult.completed_at,
      provider_usage: providerResult.usage,
      result_hash: canonicalSha256({
        provider_result: providerResult,
        decisions,
        admissions,
      }),
    };
  }
}

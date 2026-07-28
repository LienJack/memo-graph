import { createHash } from "node:crypto";

import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_POLICY_VERSION,
  compileContext,
  l0MemoryIdentity,
  type ContextCandidate,
  type ContextExclusion,
} from "@memo-graph/context-compiler";
import {
  GovernedResponseSchema,
  LocalPrincipalSchema,
  MemoryContextCompileInputSchema,
  MemoryCorrectInputSchema,
  MemoryCandidateSchema,
  MemoryDeleteInputSchema,
  MemoryDemoteInputSchema,
  MemoryEpisodeCommitInputSchema,
  MemoryExplainInputSchema,
  MemoryGetInputSchema,
  MemoryPinInputSchema,
  MemoryReceiptGetInputSchema,
  MemoryRevokeInputSchema,
  MemorySearchInputSchema,
  MemoryProposeInputSchema,
  MemoryUsageSetInputSchema,
  RecallRequestSchema,
  RetrievalReceiptSchema,
  authorizeRequestClaims,
  canonicalJson,
  canonicalSha256,
  scopeKey,
  sealReceipt,
} from "@memo-graph/contracts";
import type {
  EvidenceRecordSchema,
  MutationRequestEnvelopeSchema,
  ProposalRequestEnvelopeSchema,
  ReadRequestEnvelopeSchema,
  ScopeSchema,
} from "@memo-graph/contracts";
import {
  StorageError,
} from "@memo-graph/storage-sqlite";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { z } from "zod";

import { evaluateAdmission } from "./governance.js";
import {
  ApprovalBindingSchema,
  ApprovalError,
  DenyAllApprovalRegistry,
  type ApprovalRegistry,
  type VerifiedApproval,
} from "./approval.js";

export { evaluateAdmission } from "./governance.js";
export {
  ApprovalBindingSchema,
  ApprovalError,
  DenyAllApprovalRegistry,
  assertApprovalGrant,
  approvalRegistryHash,
  type ApprovalBinding,
  type ApprovalRegistry,
  type VerifiedApproval,
} from "./approval.js";

export const MemoryRuntimePolicySchema = z
  .object({
    principal: LocalPrincipalSchema,
    default_token_budget: z.number().int().positive().max(32_000).default(1_800),
  })
  .strict();

export type MemoryRuntimePolicy = z.input<typeof MemoryRuntimePolicySchema>;
export type GovernedResponse = z.infer<typeof GovernedResponseSchema>;

type ReadEnvelope = z.output<typeof ReadRequestEnvelopeSchema>;
type ProposalEnvelope = z.output<typeof ProposalRequestEnvelopeSchema>;
type MutationEnvelope = z.output<typeof MutationRequestEnvelopeSchema>;
type RuntimeEnvelope = ReadEnvelope | ProposalEnvelope | MutationEnvelope;
type MemoryControlRequest =
  | z.output<typeof MemoryPinInputSchema>
  | z.output<typeof MemoryDemoteInputSchema>
  | z.output<typeof MemoryUsageSetInputSchema>
  | z.output<typeof MemoryRevokeInputSchema>;
type L0ContextCandidate = Extract<
  ContextCandidate,
  { abstraction: "l0_evidence" }
>;
type RetrievalAuditItem = {
  evidence?: z.output<typeof EvidenceRecordSchema>;
  memory_identity?: {
    memory_id: string;
    revision_id: string;
  };
  decision: "included" | "excluded";
  reason_codes: string[];
  lane: string;
  score: number | null;
};

function stableIdentifier(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `${prefix}:${digest.slice(0, 48)}`;
}

function publicFailure(
  code:
    | "INVALID_INPUT"
    | "PERMISSION_DENIED"
    | "CONFLICT"
    | "STALE_REVISION"
    | "APPROVAL_REQUIRED"
    | "APPROVAL_INVALID"
    | "INCOMPLETE_PURGE"
    | "PROJECTION_UNAVAILABLE"
    | "INTERNAL_FAILURE",
  message: string,
  retryable = false,
): GovernedResponse {
  return GovernedResponseSchema.parse({
    status: "FAILED",
    receipt_id: null,
    error: { code, message, retryable, details: {} },
  });
}

function storageFailure(error: StorageError): GovernedResponse {
  if (error.code === "CONFLICT") {
    return publicFailure("CONFLICT", error.message, error.retryable);
  }
  if (error.code === "STALE_REVISION") {
    return publicFailure(
      "STALE_REVISION",
      error.message,
      error.retryable,
    );
  }
  if (error.code === "APPROVAL_INVALID") {
    return publicFailure(
      "APPROVAL_INVALID",
      error.message,
      error.retryable,
    );
  }
  if (error.code === "INCOMPLETE_PURGE") {
    return publicFailure(
      "INCOMPLETE_PURGE",
      error.message,
      error.retryable,
    );
  }
  if (
    error.code === "INVALID_INPUT" ||
    error.code === "INVALID_DATA_ROOT" ||
    error.code === "ENCRYPTION_REQUIRED"
  ) {
    return publicFailure("INVALID_INPUT", error.message, error.retryable);
  }
  if (error.code === "FTS_UNAVAILABLE") {
    return publicFailure(
      "PROJECTION_UNAVAILABLE",
      error.message,
      error.retryable,
    );
  }
  return publicFailure("INTERNAL_FAILURE", error.message, error.retryable);
}

function approvalFailureCode(
  error: unknown,
): "APPROVAL_REQUIRED" | "APPROVAL_INVALID" | null {
  if (error instanceof ApprovalError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ApprovalError" &&
    "code" in error &&
    (error.code === "APPROVAL_REQUIRED" ||
      error.code === "APPROVAL_INVALID")
  ) {
    return error.code;
  }
  return null;
}

function sameScope(left: z.input<typeof ScopeSchema>, right: z.input<typeof ScopeSchema>): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export class MemoryRuntime {
  readonly #storage: SqliteStorageClient;
  readonly #policy: z.output<typeof MemoryRuntimePolicySchema>;
  readonly #approvalRegistry: ApprovalRegistry;
  readonly #clock: () => string;

  constructor(options: {
    storage: SqliteStorageClient;
    policy: MemoryRuntimePolicy;
    approvalRegistry?: ApprovalRegistry;
    clock?: () => string;
  }) {
    this.#storage = options.storage;
    this.#policy = MemoryRuntimePolicySchema.parse(options.policy);
    this.#approvalRegistry =
      options.approvalRegistry ?? new DenyAllApprovalRegistry();
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  memorySearch(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemorySearchInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }

      const searched = await this.#searchContextScopes(
        request.query,
        request.envelope.scopes,
        request.limit,
        request.envelope.requested_at,
        request.include_sensitive,
      );
      const allowed: RetrievalAuditItem[] = [];
      const excluded: RetrievalAuditItem[] = [];
      const outputItems: unknown[] = [];
      for (const candidate of searched.candidates) {
        if (candidate.abstraction === "l1_memory") {
          allowed.push({
            memory_identity: {
              memory_id: candidate.memory.memory_id,
              revision_id: candidate.memory.revision_id,
            },
            decision: "included",
            reason_codes: candidate.memory.reason_codes,
            lane: candidate.lane,
            score: candidate.rank,
          });
          outputItems.push(candidate.memory);
        } else if (
          (candidate.evidence.sensitivity === "sensitive" &&
            !request.include_sensitive) ||
          candidate.evidence.sensitivity === "secret"
        ) {
          excluded.push({
            evidence: candidate.evidence,
            decision: "excluded",
            reason_codes: [
              candidate.evidence.sensitivity === "secret"
                ? "SECRET_EXCLUDED"
                : "SENSITIVE_EXCLUDED",
            ],
            lane: candidate.lane,
            score: candidate.rank,
          });
        } else {
          allowed.push({
            evidence: candidate.evidence,
            decision: "included",
            reason_codes: ["RANKED_EVIDENCE"],
            lane: candidate.lane,
            score: candidate.rank,
          });
          outputItems.push(candidate.evidence);
        }
      }
      for (const item of searched.exclusions) {
        excluded.push({
          memory_identity: {
            memory_id: item.memory_id,
            revision_id: item.revision_id,
          },
          decision: "excluded",
          reason_codes: [item.reason_code],
          lane: item.lane,
          score: item.score,
        });
      }
      const audit = await this.#recordAudit({
        envelope: request.envelope,
        query: request.query,
        includeSensitive: request.include_sensitive,
        items: [...allowed, ...excluded],
        partial: searched.degraded.length > 0,
      });
      const data = {
        items: outputItems,
        receipt: audit.receipt,
      };
      if (searched.degraded.length > 0) {
        return GovernedResponseSchema.parse({
          status: "DEGRADED",
          receipt_id: audit.receipt.receipt_id,
          fallback_lane:
            allowed.length > 0 ? "partial_sqlite_fts" : "none",
          warnings: searched.degraded,
          data,
        });
      }
      if (allowed.length > 0) {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: audit.receipt.receipt_id,
          data,
        });
      }
      if (excluded.length > 0) {
        return GovernedResponseSchema.parse({
          status: "POLICY_EXCLUDED",
          receipt_id: audit.receipt.receipt_id,
          excluded_count: excluded.length,
          reason_codes: [
            ...new Set(excluded.flatMap((item) => item.reason_codes)),
          ].sort(),
        });
      }
      return GovernedResponseSchema.parse({
        status: "NO_MATCH",
        receipt_id: audit.receipt.receipt_id,
        reason: "no exact-scope evidence matched the query",
      });
    });
  }

  memoryGet(input: unknown): Promise<GovernedResponse> {
    return this.#evidenceRead(input, MemoryGetInputSchema, "get");
  }

  memoryExplain(input: unknown): Promise<GovernedResponse> {
    return this.#evidenceRead(input, MemoryExplainInputSchema, "explain");
  }

  memoryReceiptGet(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryReceiptGetInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const receipt = await this.#storage.getReceipt({
        receipt_id: request.receipt_id,
        principal_id: request.envelope.actor_claim.principal_id,
        scopes: request.envelope.scopes,
      });
      const audit = await this.#recordAudit({
        envelope: request.envelope,
        query: `receipt:${request.receipt_id}`,
        includeSensitive: false,
        items: [],
        partial: false,
      });
      if (receipt === null) {
        return GovernedResponseSchema.parse({
          status: "NO_MATCH",
          receipt_id: audit.receipt.receipt_id,
          reason: "the requested receipt does not exist",
        });
      }
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: audit.receipt.receipt_id,
        data: { receipt, audit_receipt: audit.receipt },
      });
    });
  }

  memoryContextCompile(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryContextCompileInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const searched = await this.#searchContextScopes(
        request.recall.query,
        request.recall.scopes,
        100,
        request.recall.as_of,
        request.recall.include_sensitive,
      );
      const compiled = compileContext({
        request: request.recall,
        candidates: searched.candidates,
        exclusions: searched.exclusions,
        created_at: request.envelope.requested_at,
        degraded_lanes: searched.degraded,
      });
      const stored = await this.#storage.recordRecall({
        principal_id: request.envelope.actor_claim.principal_id,
        request: request.recall,
        receipt: compiled.receipt,
        ...(compiled.context_slice === null
          ? {}
          : { context_slice: compiled.context_slice }),
      });
      const data = {
        context_slice: stored.context_slice,
        receipt: stored.receipt,
        replayed: stored.replayed,
      };
      if (stored.replayed) {
        if (stored.receipt.state === "partial") {
          return GovernedResponseSchema.parse({
            status: "DEGRADED",
            receipt_id: stored.receipt.receipt_id,
            fallback_lane:
              stored.context_slice === null ? "none" : "partial_sqlite_fts",
            warnings: ["frozen replay of a partial retrieval"],
            data,
          });
        }
        if (stored.context_slice !== null) {
          return GovernedResponseSchema.parse({
            status: "OK",
            receipt_id: stored.receipt.receipt_id,
            data,
          });
        }
        const excluded = stored.receipt.items.filter(
          (item) => item.decision === "excluded",
        );
        if (excluded.length > 0) {
          return GovernedResponseSchema.parse({
            status: "POLICY_EXCLUDED",
            receipt_id: stored.receipt.receipt_id,
            excluded_count: excluded.length,
            reason_codes: [
              ...new Set(
                excluded.flatMap((item) => item.reason_codes),
              ),
            ].sort(),
          });
        }
        return GovernedResponseSchema.parse({
          status: "NO_MATCH",
          receipt_id: stored.receipt.receipt_id,
          reason: "the frozen replay contains no matched evidence",
        });
      }
      if (compiled.status === "DEGRADED") {
        return GovernedResponseSchema.parse({
          status: "DEGRADED",
          receipt_id: stored.receipt.receipt_id,
          fallback_lane:
            stored.context_slice === null ? "none" : "partial_sqlite_fts",
          warnings: compiled.warnings,
          data,
        });
      }
      if (compiled.status === "OK") {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: stored.receipt.receipt_id,
          data,
        });
      }
      if (compiled.status === "POLICY_EXCLUDED") {
        return GovernedResponseSchema.parse({
          status: "POLICY_EXCLUDED",
          receipt_id: stored.receipt.receipt_id,
          excluded_count: compiled.excluded_count,
          reason_codes: compiled.reason_codes,
        });
      }
      return GovernedResponseSchema.parse({
        status: "NO_MATCH",
        receipt_id: stored.receipt.receipt_id,
        reason: "no exact-scope evidence matched the recall request",
      });
    });
  }

  memoryPropose(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryProposeInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const replay = await this.#storage.governanceReplay({
        idempotency_key: request.envelope.idempotency_key,
        request_hash: canonicalSha256(request),
      });
      if (replay !== null) {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: replay.receipt.receipt_id,
          data: replay,
        });
      }
      const evidence = await Promise.all(
        request.candidate.evidence_ids.map((evidenceId) =>
          this.#storage.getEvidence({
            evidence_id: evidenceId,
            principal_id: this.#policy.principal.principal_id,
            scope: request.candidate.scope,
          }),
        ),
      );
      if (
        new Set(request.candidate.evidence_ids).size !==
          request.candidate.evidence_ids.length ||
        evidence.some((item) => item === null)
      ) {
        return publicFailure(
          "INVALID_INPUT",
          "candidate evidence is missing, deleted, or outside the exact scope",
        );
      }
      const liveEvidence = evidence.filter(
        (item): item is NonNullable<typeof item> => item !== null,
      );
      const evaluation = evaluateAdmission(
        request.candidate,
        liveEvidence,
      );
      if (evaluation.decision === "reject") {
        return publicFailure("INVALID_INPUT", evaluation.reason);
      }
      const result = await this.#storage.admitMemory({
        request,
        evaluation,
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: result.receipt.receipt_id,
        data: result,
      });
    });
  }

  memoryPin(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#memoryControl(MemoryPinInputSchema.parse(input)),
    );
  }

  memoryCorrect(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryCorrectInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const requestHash = canonicalSha256(request);
      const replay = await this.#storage.governanceReplay({
        idempotency_key: request.envelope.idempotency_key,
        request_hash: requestHash,
      });
      if (replay !== null) {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: replay.receipt.receipt_id,
          data: replay,
        });
      }
      const expectedRevisionId = request.envelope.expected_revision_id;
      if (expectedRevisionId === null) {
        throw new StorageError("STALE_REVISION");
      }
      let basis:
        | NonNullable<Awaited<
            ReturnType<SqliteStorageClient["getMemoryCorrectionBasis"]>
          >>
        | undefined;
      for (const scope of request.envelope.scopes) {
        const candidateBasis =
          await this.#storage.getMemoryCorrectionBasis({
            memory_id: request.memory_id,
            principal_id:
              request.envelope.actor_claim.principal_id,
            scope,
            expected_revision_id: expectedRevisionId,
          });
        if (candidateBasis !== null) {
          basis = candidateBasis;
          break;
        }
      }
      if (basis === undefined) {
        throw new StorageError("STALE_REVISION");
      }
      const candidate = MemoryCandidateSchema.parse({
        schema_version: "1.0.0",
        candidate_id: stableIdentifier("candidate", {
          idempotency_key: request.envelope.idempotency_key,
          request_hash: requestHash,
        }),
        logical_key: basis.logical_key,
        kind: basis.kind,
        scope: basis.scope,
        sensitivity: basis.sensitivity,
        inferred: basis.inferred,
        content: request.replacement.content,
        content_hash: request.replacement.content_hash,
        evidence_ids: request.replacement.evidence_ids,
        validity: request.replacement.validity,
        injection_risk: "none",
        requires_user_confirmation: false,
        transform: {
          name: "memory-correction",
          version: "1.0.0",
        },
      });
      const evidence = await Promise.all(
        candidate.evidence_ids.map((evidenceId) =>
          this.#storage.getEvidence({
            evidence_id: evidenceId,
            principal_id:
              request.envelope.actor_claim.principal_id,
            scope: candidate.scope,
          }),
        ),
      );
      if (
        new Set(candidate.evidence_ids).size !==
          candidate.evidence_ids.length ||
        evidence.some((item) => item === null)
      ) {
        return publicFailure(
          "INVALID_INPUT",
          "correction evidence is missing, deleted, or outside the exact scope",
        );
      }
      const evaluation = evaluateAdmission(
        candidate,
        evidence.filter(
          (item): item is NonNullable<typeof item> => item !== null,
        ),
      );
      if (evaluation.decision === "reject") {
        return publicFailure("INVALID_INPUT", evaluation.reason);
      }

      let approval: VerifiedApproval | undefined;
      let binding:
        | z.output<typeof ApprovalBindingSchema>
        | undefined;
      if (!request.envelope.dry_run) {
        if (request.envelope.approval_id === null) {
          throw new ApprovalError("APPROVAL_REQUIRED");
        }
        binding = ApprovalBindingSchema.parse({
          approval_id: request.envelope.approval_id,
          principal_id:
            request.envelope.actor_claim.principal_id,
          tool: request.envelope.tool,
          safety_class: request.envelope.safety_class,
          scopes: request.envelope.scopes,
          request_hash: requestHash,
        });
        approval = await this.#approvalRegistry.verify(binding);
        await this.#approvalRegistry.confirmUnchanged(approval);
      }
      const result = await this.#storage.applyMemoryRevision({
        idempotency_key: request.envelope.idempotency_key,
        principal_id:
          request.envelope.actor_claim.principal_id,
        actor_authority: request.envelope.actor_claim.authority,
        scope: basis.scope,
        requested_at: request.envelope.requested_at,
        memory_id: request.memory_id,
        expected_revision_id: expectedRevisionId,
        candidate,
        evaluation,
        dry_run: request.envelope.dry_run,
        ...(approval === undefined || binding === undefined
          ? {}
          : {
              request_hash: requestHash,
              approval_binding: binding,
              approval: {
                grant: approval.grant,
                registry_hash: approval.registry_hash,
                verified_at: this.#clock(),
              },
            }),
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: result.receipt.receipt_id,
        data: result,
      });
    });
  }

  memoryDemote(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#memoryControl(MemoryDemoteInputSchema.parse(input)),
    );
  }

  memoryUsageSet(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#memoryControl(MemoryUsageSetInputSchema.parse(input)),
    );
  }

  memoryRevoke(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#memoryControl(MemoryRevokeInputSchema.parse(input)),
    );
  }

  memoryDelete(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryDeleteInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const requestHash = canonicalSha256(request);
      const replay = await this.#storage.memoryDeleteReplay({
        idempotency_key: request.envelope.idempotency_key,
        request_hash: requestHash,
      });
      if (replay !== null) {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: replay.receipt.receipt_id,
          data: replay,
        });
      }
      let approval: VerifiedApproval | null = null;
      if (!request.envelope.dry_run) {
        if (request.envelope.approval_id === null) {
          throw new ApprovalError("APPROVAL_REQUIRED");
        }
        const binding = ApprovalBindingSchema.parse({
          approval_id: request.envelope.approval_id,
          principal_id:
            request.envelope.actor_claim.principal_id,
          tool: request.envelope.tool,
          safety_class: request.envelope.safety_class,
          scopes: request.envelope.scopes,
          request_hash: requestHash,
        });
        approval = await this.#approvalRegistry.verify(binding);
        await this.#approvalRegistry.confirmUnchanged(approval);
      }
      const result = await this.#storage.deleteMemory({
        request,
        approval:
          approval === null
            ? null
            : {
                grant: approval.grant,
                registry_hash: approval.registry_hash,
                verified_at: this.#clock(),
              },
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: result.receipt.receipt_id,
        data: result,
      });
    });
  }

  memoryEpisodeCommit(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryEpisodeCommitInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const allowedScopes = new Set(request.envelope.scopes.map(scopeKey));
      const allowedAuthorities = new Set(
        this.#policy.principal.allowed_authorities,
      );
      if (
        !allowedScopes.has(scopeKey(request.episode.scope)) ||
        request.evidence.some(
          (evidence) =>
            !allowedScopes.has(scopeKey(evidence.scope)) ||
            evidence.actor.principal_id !==
              this.#policy.principal.principal_id ||
            !allowedAuthorities.has(evidence.actor.authority) ||
            !allowedAuthorities.has(evidence.authority),
        )
      ) {
        return publicFailure(
          "PERMISSION_DENIED",
          "episode evidence is outside the configured principal",
        );
      }
      const receipt = await this.#storage.commitEpisode({
        idempotencyKey: request.envelope.idempotency_key,
        episode: request.episode,
        evidence: request.evidence,
        blobs: request.blobs.map((blob) => ({
          content_hash: blob.content_hash,
          media_type: blob.media_type,
          bytes: new Uint8Array(Buffer.from(blob.data_base64, "base64")),
        })),
      });
      await this.#storage.drainFtsOutbox();
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: receipt.receipt_id,
        data: { receipt },
      });
    });
  }

  async #evidenceRead(
    input: unknown,
    schema: typeof MemoryGetInputSchema | typeof MemoryExplainInputSchema,
    kind: "get" | "explain",
  ): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = schema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      if (
        !request.envelope.scopes.some((scope) =>
          sameScope(scope, request.scope),
        )
      ) {
        return publicFailure(
          "PERMISSION_DENIED",
          "lookup scope is outside the request envelope",
        );
      }
      if ("memory_id" in request) {
        return this.#governedMemoryRead(request, kind);
      }
      const storedResult =
        kind === "get"
          ? await this.#storage.getEvidence({
              evidence_id: request.evidence_id,
              principal_id: this.#policy.principal.principal_id,
              scope: request.scope,
            })
          : await this.#storage.explainEvidence({
              evidence_id: request.evidence_id,
              principal_id: this.#policy.principal.principal_id,
              scope: request.scope,
            });
      const storedEvidence =
        storedResult !== null && "evidence" in storedResult
          ? storedResult.evidence
          : storedResult;
      const result =
        storedEvidence !== null &&
        !this.#evidenceIsAllowed(storedEvidence)
          ? null
          : storedResult;
      const evidence =
        result !== null && "evidence" in result ? result.evidence : result;
      const auditItems: RetrievalAuditItem[] =
        evidence === null
          ? []
          : [
              {
                evidence,
                decision: "included",
                reason_codes: ["EXACT_ID"],
                lane: "sqlite_authority",
                score: null,
              },
            ];
      const audit = await this.#recordAudit({
        envelope: request.envelope,
        query: `${kind}:${request.evidence_id}`,
        includeSensitive: true,
        items: auditItems,
        partial: false,
      });
      if (result === null) {
        return GovernedResponseSchema.parse({
          status: "NO_MATCH",
          receipt_id: audit.receipt.receipt_id,
          reason: "the requested evidence does not exist in the exact scope",
        });
      }
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: audit.receipt.receipt_id,
        data: { result, receipt: audit.receipt },
      });
    });
  }

  async #governedMemoryRead(
    request: Extract<
      z.output<typeof MemoryGetInputSchema>,
      { memory_id: unknown }
    >,
    kind: "get" | "explain",
  ): Promise<GovernedResponse> {
    const result = await this.#storage.getGovernedMemory({
      memory_id: request.memory_id,
      principal_id: this.#policy.principal.principal_id,
      scope: request.scope,
      as_of: request.envelope.requested_at,
      include_sensitive: request.include_sensitive,
      context_scope: request.scope,
    });
    const audit = await this.#recordAudit({
      envelope: request.envelope,
      query: `${kind}:${request.memory_id}`,
      includeSensitive: request.include_sensitive,
      items:
        result === null
          ? []
          : [
              {
                memory_identity: result.eligible
                  ? {
                      memory_id: result.item.memory_id,
                      revision_id: result.item.revision_id,
                    }
                  : {
                      memory_id: result.memory_id,
                      revision_id: result.revision_id,
                    },
                decision: result.eligible ? "included" : "excluded",
                reason_codes: result.eligible
                  ? result.item.reason_codes
                  : [result.reason_code],
                lane: "sqlite_canonical",
                score: null,
              },
            ],
      partial: false,
    });
    if (result === null) {
      return GovernedResponseSchema.parse({
        status: "NO_MATCH",
        receipt_id: audit.receipt.receipt_id,
        reason: "the requested governed memory does not exist",
      });
    }
    if (!result.eligible) {
      return GovernedResponseSchema.parse({
        status: "POLICY_EXCLUDED",
        receipt_id: audit.receipt.receipt_id,
        excluded_count: 1,
        reason_codes: [result.reason_code],
      });
    }
    return GovernedResponseSchema.parse({
      status: "OK",
      receipt_id: audit.receipt.receipt_id,
      data: {
        result:
          kind === "get"
            ? result.item
            : {
                memory: result.item,
                evidence_ids: result.item.evidence_ids,
                transform: result.item.transform,
                eligibility: result.item.reason_codes,
              },
        receipt: audit.receipt,
      },
    });
  }

  #authorize(envelope: RuntimeEnvelope): GovernedResponse | null {
    const decision = authorizeRequestClaims(
      this.#policy.principal,
      envelope,
    );
    return decision.authorized
      ? null
      : publicFailure("PERMISSION_DENIED", decision.reason);
  }

  async #memoryControl(
    request: MemoryControlRequest,
  ): Promise<GovernedResponse> {
    const unauthorized = this.#authorize(request.envelope);
    if (unauthorized !== null) {
      return unauthorized;
    }
    const requestHash = canonicalSha256(request);
    const replay = await this.#storage.memoryControlReplay({
      idempotency_key: request.envelope.idempotency_key,
      request_hash: requestHash,
    });
    if (replay !== null) {
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: replay.receipt.receipt_id,
        data: replay,
      });
    }

    let approval: VerifiedApproval | null = null;
    if (!request.envelope.dry_run) {
      if (request.envelope.approval_id === null) {
        throw new ApprovalError("APPROVAL_REQUIRED");
      }
      const binding = ApprovalBindingSchema.parse({
        approval_id: request.envelope.approval_id,
        principal_id: request.envelope.actor_claim.principal_id,
        tool: request.envelope.tool,
        safety_class: request.envelope.safety_class,
        scopes: request.envelope.scopes,
        request_hash: requestHash,
      });
      approval = await this.#approvalRegistry.verify(binding);
      await this.#approvalRegistry.confirmUnchanged(approval);
    }

    const result = await this.#storage.applyMemoryControl({
      request,
      approval:
        approval === null
          ? null
          : {
              grant: approval.grant,
              registry_hash: approval.registry_hash,
              verified_at: this.#clock(),
            },
    });
    return GovernedResponseSchema.parse({
      status: "OK",
      receipt_id: result.receipt.receipt_id,
      data: result,
    });
  }

  async #searchScopes(
    query: string,
    scopes: ReadEnvelope["scopes"],
    limit: number,
  ): Promise<{ candidates: L0ContextCandidate[]; degraded: string[] }> {
    const candidates: L0ContextCandidate[] = [];
    const degraded: string[] = [];
    for (const scope of scopes) {
      const result = await this.#storage.searchEvidence({
        query,
        principal_id: this.#policy.principal.principal_id,
        scope,
        limit,
      });
      if (result.status === "DEGRADED") {
        degraded.push(`${scopeKey(scope)}:${result.reason_code}`);
        continue;
      }
      for (const item of result.items) {
        const evidence = await this.#storage.getEvidence({
          evidence_id: item.evidence_id,
          principal_id: this.#policy.principal.principal_id,
          scope,
        });
        if (evidence === null) {
          throw new StorageError("CORRUPTION");
        }
        if (!this.#evidenceIsAllowed(evidence)) {
          continue;
        }
        candidates.push({
          abstraction: "l0_evidence",
          evidence,
          rank: item.rank,
          lane: "sqlite_fts",
        });
      }
    }
    candidates.sort(
      (left, right) =>
        left.rank - right.rank ||
        right.evidence.occurred_at.localeCompare(
          left.evidence.occurred_at,
        ) ||
        left.evidence.evidence_id.localeCompare(
          right.evidence.evidence_id,
        ),
    );
    return {
      candidates: candidates.slice(0, limit),
      degraded: [...new Set(degraded)].sort(),
    };
  }

  async #searchContextScopes(
    query: string,
    scopes: ReadEnvelope["scopes"],
    limit: number,
    asOf: string,
    includeSensitive: boolean,
  ): Promise<{
    candidates: ContextCandidate[];
    exclusions: ContextExclusion[];
    degraded: string[];
  }> {
    const evidence = await this.#searchScopes(query, scopes, limit);
    const candidates: ContextCandidate[] = [...evidence.candidates];
    const exclusions: ContextExclusion[] = [];
    const degraded = [...evidence.degraded];
    for (const scope of scopes) {
      const result = await this.#storage.searchGovernedMemory({
        query,
        principal_id: this.#policy.principal.principal_id,
        scope,
        as_of: asOf,
        include_sensitive: includeSensitive,
        context_scope: scope,
        limit,
      });
      degraded.push(...result.degraded_lanes.map(
        (lane) => `${scopeKey(scope)}:${lane}`,
      ));
      for (const item of result.items) {
        candidates.push({
          abstraction: "l1_memory",
          memory: item.item,
          rank: item.rank - 1_000,
          lane: item.lane,
        });
      }
      exclusions.push(...result.exclusions);
    }
    const governedEvidenceIds = new Set(
      candidates.flatMap((candidate) =>
        candidate.abstraction === "l1_memory"
          ? candidate.memory.evidence_ids
          : [],
      ),
    );
    const deduplicated = candidates.filter(
      (candidate) =>
        candidate.abstraction === "l1_memory" ||
        !governedEvidenceIds.has(candidate.evidence.evidence_id),
    );
    return {
      candidates: deduplicated
        .sort((left, right) => left.rank - right.rank)
        .slice(0, limit),
      exclusions,
      degraded: [...new Set(degraded)].sort(),
    };
  }

  async #recordAudit(options: {
    envelope: ReadEnvelope;
    query: string;
    includeSensitive: boolean;
    items: RetrievalAuditItem[];
    partial: boolean;
  }) {
    const recall = RecallRequestSchema.parse({
      schema_version: "1.0.0",
      request_id: options.envelope.request_id,
      goal: options.envelope.purpose,
      query: options.query,
      scopes: options.envelope.scopes,
      as_of: options.envelope.requested_at,
      token_budget: this.#policy.default_token_budget,
      include_sensitive: options.includeSensitive,
    });
    const receiptItems = options.items.map((item) => {
      const identity =
        item.memory_identity ??
        (item.evidence === undefined
          ? null
          : l0MemoryIdentity(item.evidence));
      if (identity === null) {
        throw new StorageError("CORRUPTION");
      }
      return {
        memory_id: identity.memory_id,
        revision_id: identity.revision_id,
        decision: item.decision,
        reason_codes: item.reason_codes,
        lane: item.lane,
        score: item.score,
      };
    });
    const receipt = RetrievalReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: stableIdentifier("retrieval", {
          request_id: recall.request_id,
          items: receiptItems,
          partial: options.partial,
        }),
        created_at: options.envelope.requested_at,
        state: options.partial ? "partial" : "durable",
        request_hash: canonicalSha256(recall),
        receipt_hash: `sha256:${"0".repeat(64)}`,
        kind: "retrieval",
        context_slice_id: null,
        compiler_version: CONTEXT_COMPILER_VERSION,
        policy_version: CONTEXT_POLICY_VERSION,
        items: receiptItems,
      }),
    );
    return this.#storage.recordRecall({
      principal_id: options.envelope.actor_claim.principal_id,
      request: recall,
      receipt,
    });
  }

  #evidenceIsAllowed(
    evidence: z.output<typeof EvidenceRecordSchema>,
  ): boolean {
    return (
      evidence.actor.principal_id === this.#policy.principal.principal_id &&
      this.#policy.principal.allowed_authorities.includes(
        evidence.actor.authority,
      ) &&
      this.#policy.principal.allowed_authorities.includes(
        evidence.authority,
      )
    );
  }

  async #execute(
    operation: () => Promise<GovernedResponse>,
  ): Promise<GovernedResponse> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return publicFailure(
          "INVALID_INPUT",
          "the tool request does not satisfy its runtime contract",
        );
      }
      if (error instanceof StorageError) {
        return storageFailure(error);
      }
      const approvalCode = approvalFailureCode(error);
      if (approvalCode !== null) {
        return publicFailure(
          approvalCode,
          approvalCode === "APPROVAL_REQUIRED"
            ? "a trusted approval was not found"
            : "the trusted approval does not authorize this request",
        );
      }
      return publicFailure(
        "INTERNAL_FAILURE",
        "the memory runtime could not complete the request",
      );
    }
  }
}

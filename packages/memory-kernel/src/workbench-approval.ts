import {
  ApprovalBindingSchema,
  ApprovalGrantSchema,
  CanonicalHashSchema,
  approvalGrantMatches,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  type ApprovalBinding,
  type ApprovalGrant,
  type CanonicalHash,
  type MemoryDemoteInput,
  type WorkbenchCorrectionPreviewResult,
  type WorkbenchAutomaticMemoryUndoPreviewResult,
} from "@memo-graph/contracts";
import type { MemoryRevisionCommand } from "@memo-graph/storage-sqlite";

import {
  ApprovalError,
  type ApprovalRegistry,
  type VerifiedApproval,
} from "./approval.js";

type ReadyPreview = Extract<
  WorkbenchCorrectionPreviewResult,
  { status: "ready" }
>;

export type PreparedWorkbenchCorrection = {
  session_id: string;
  preview: ReadyPreview;
  command: MemoryRevisionCommand;
  binding: ApprovalBinding;
  grant: ApprovalGrant;
  request_hash: CanonicalHash;
};

type StoredPreparedCorrection = PreparedWorkbenchCorrection & {
  state: "prepared" | "confirmed";
  confirmed_at: string | null;
};

type ConfirmedWorkbenchCorrection = PreparedWorkbenchCorrection & {
  confirmed_at: string;
};

type ReadyAutomaticUndoPreview = Extract<
  WorkbenchAutomaticMemoryUndoPreviewResult,
  { status: "ready" }
>;

type StoredAutomaticUndo = {
  session_id: string;
  preview: ReadyAutomaticUndoPreview;
  request: MemoryDemoteInput;
  binding: ApprovalBinding;
  grant: ApprovalGrant;
  request_hash: CanonicalHash;
  confirmed_at: string | null;
};

export type ConfirmedAutomaticUndo = Omit<
  StoredAutomaticUndo,
  "confirmed_at"
> & { confirmed_at: string };

export type WorkbenchPreviewFailureCode =
  | "PREVIEW_NOT_FOUND"
  | "PREVIEW_SESSION_MISMATCH"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_INVALID";

export class WorkbenchPreviewError extends Error {
  readonly code: WorkbenchPreviewFailureCode;

  constructor(code: WorkbenchPreviewFailureCode) {
    super(code);
    this.name = "WorkbenchPreviewError";
    this.code = code;
  }
}

export class WorkbenchApprovalRegistry implements ApprovalRegistry {
  readonly #clock: () => string;
  readonly #byPreview = new Map<string, StoredPreparedCorrection>();
  readonly #previewByApproval = new Map<string, string>();

  constructor(options?: { clock?: () => string }) {
    this.#clock = options?.clock ?? (() => new Date().toISOString());
  }

  clear(): void {
    this.#byPreview.clear();
    this.#previewByApproval.clear();
  }

  prepare(input: {
    session_id: string;
    preview: ReadyPreview;
    command: MemoryRevisionCommand;
    request_hash: CanonicalHash;
    approval_id: string;
  }): PreparedWorkbenchCorrection {
    if (
      input.preview.seal_hash !==
        canonicalSha256({
          session_id: input.session_id,
          preview_id: input.preview.preview_id,
          operation_id: input.preview.operation_id,
          memory_id: input.preview.memory_id,
          expected_revision_id: input.preview.expected_revision_id,
          replacement: input.preview.replacement,
          reason: input.preview.reason,
          impact: input.preview.impact,
          expires_at: input.preview.expires_at,
        }) ||
      input.command.request_hash !== input.request_hash
    ) {
      throw new WorkbenchPreviewError("PREVIEW_INVALID");
    }
    const binding = ApprovalBindingSchema.parse({
      approval_id: input.approval_id,
      principal_id: input.command.principal_id,
      tool: "memory_correct",
      safety_class: "important_mutation",
      scopes: [input.command.scope],
      request_hash: input.request_hash,
    });
    const unsigned = {
      schema_version: "1.0.0",
      approval_id: input.approval_id,
      principal_id: input.command.principal_id,
      tool: "memory_correct",
      safety_class: "important_mutation",
      scopes: [input.command.scope],
      request_hash: input.request_hash,
      issued_at: input.command.requested_at,
      expires_at: input.preview.expires_at,
      manifest_hash: `sha256:${"0".repeat(64)}`,
    } as const;
    const grant = ApprovalGrantSchema.parse({
      ...unsigned,
      manifest_hash: canonicalSha256Omitting(unsigned, ["manifest_hash"]),
    });
    const prepared: StoredPreparedCorrection = {
      session_id: input.session_id,
      preview: input.preview,
      command: input.command,
      binding,
      grant,
      request_hash: input.request_hash,
      state: "prepared",
      confirmed_at: null,
    };
    this.#byPreview.set(input.preview.preview_id, prepared);
    this.#previewByApproval.set(input.approval_id, input.preview.preview_id);
    return prepared;
  }

  confirmPreview(
    previewId: string,
    sessionId: string,
  ): ConfirmedWorkbenchCorrection {
    const prepared = this.#byPreview.get(previewId);
    if (prepared === undefined) {
      throw new WorkbenchPreviewError("PREVIEW_NOT_FOUND");
    }
    if (prepared.session_id !== sessionId) {
      throw new WorkbenchPreviewError("PREVIEW_SESSION_MISMATCH");
    }
    if (Date.parse(this.#clock()) >= Date.parse(prepared.preview.expires_at)) {
      this.#byPreview.delete(previewId);
      this.#previewByApproval.delete(prepared.grant.approval_id);
      throw new WorkbenchPreviewError("PREVIEW_EXPIRED");
    }
    if (prepared.confirmed_at === null) {
      prepared.confirmed_at = this.#clock();
    }
    prepared.state = "confirmed";
    return {
      ...prepared,
      confirmed_at: prepared.confirmed_at,
    };
  }

  async verify(binding: ApprovalBinding): Promise<VerifiedApproval> {
    const previewId = this.#previewByApproval.get(binding.approval_id);
    const prepared =
      previewId === undefined ? undefined : this.#byPreview.get(previewId);
    const now = this.#clock();
    if (
      prepared === undefined ||
      prepared.state !== "confirmed" ||
      canonicalJson(prepared.binding) !== canonicalJson(binding) ||
      !approvalGrantMatches(binding, prepared.grant, now)
    ) {
      throw new ApprovalError("APPROVAL_INVALID");
    }
    return {
      grant: prepared.grant,
      registry_hash: canonicalSha256({
        preview_id: prepared.preview.preview_id,
        approval_id: prepared.grant.approval_id,
        seal_hash: prepared.preview.seal_hash,
      }),
    };
  }

  async confirmUnchanged(approval: VerifiedApproval): Promise<void> {
    const previewId = this.#previewByApproval.get(approval.grant.approval_id);
    const prepared =
      previewId === undefined ? undefined : this.#byPreview.get(previewId);
    if (
      prepared === undefined ||
      prepared.state !== "confirmed" ||
      prepared.grant.manifest_hash !== approval.grant.manifest_hash ||
      Date.parse(this.#clock()) >= Date.parse(prepared.preview.expires_at)
    ) {
      throw new ApprovalError("APPROVAL_INVALID");
    }
  }
}

export class WorkbenchAutomaticUndoRegistry {
  readonly #clock: () => string;
  readonly #byPreview = new Map<string, StoredAutomaticUndo>();

  constructor(options?: { clock?: () => string }) {
    this.#clock = options?.clock ?? (() => new Date().toISOString());
  }

  prepare(input: {
    session_id: string;
    preview: ReadyAutomaticUndoPreview;
    request: MemoryDemoteInput;
    approval_id: string;
  }): void {
    const requestHash = CanonicalHashSchema.parse(canonicalSha256(input.request));
    if (
      input.request.memory_id !== input.preview.memory_id ||
      input.request.envelope.expected_revision_id !==
        input.preview.expected_revision_id ||
      input.request.envelope.approval_id !== input.approval_id ||
      input.request.envelope.dry_run
    ) {
      throw new WorkbenchPreviewError("PREVIEW_INVALID");
    }
    const binding = ApprovalBindingSchema.parse({
      approval_id: input.approval_id,
      principal_id: input.request.envelope.actor_claim.principal_id,
      tool: "memory_demote",
      safety_class: "important_mutation",
      scopes: input.request.envelope.scopes,
      request_hash: requestHash,
    });
    const unsigned = {
      schema_version: "1.0.0",
      approval_id: input.approval_id,
      principal_id: input.request.envelope.actor_claim.principal_id,
      tool: "memory_demote",
      safety_class: "important_mutation",
      scopes: input.request.envelope.scopes,
      request_hash: requestHash,
      issued_at: input.request.envelope.requested_at,
      expires_at: input.preview.expires_at,
      manifest_hash: `sha256:${"0".repeat(64)}`,
    } as const;
    const grant = ApprovalGrantSchema.parse({
      ...unsigned,
      manifest_hash: canonicalSha256Omitting(unsigned, ["manifest_hash"]),
    });
    this.#byPreview.set(input.preview.preview_id, {
      session_id: input.session_id,
      preview: input.preview,
      request: input.request,
      binding,
      grant,
      request_hash: requestHash,
      confirmed_at: null,
    });
  }

  confirm(previewId: string, sessionId: string): ConfirmedAutomaticUndo {
    const prepared = this.#byPreview.get(previewId);
    if (prepared === undefined) {
      throw new WorkbenchPreviewError("PREVIEW_NOT_FOUND");
    }
    if (prepared.session_id !== sessionId) {
      throw new WorkbenchPreviewError("PREVIEW_SESSION_MISMATCH");
    }
    if (Date.parse(this.#clock()) >= Date.parse(prepared.preview.expires_at)) {
      this.#byPreview.delete(previewId);
      throw new WorkbenchPreviewError("PREVIEW_EXPIRED");
    }
    const confirmedAt = prepared.confirmed_at ?? this.#clock();
    prepared.confirmed_at = confirmedAt;
    if (!approvalGrantMatches(prepared.binding, prepared.grant, confirmedAt)) {
      throw new WorkbenchPreviewError("PREVIEW_INVALID");
    }
    return { ...prepared, confirmed_at: confirmedAt };
  }
}

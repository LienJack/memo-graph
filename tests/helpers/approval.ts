import {
  ApprovalGrantSchema,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import type {
  ApprovalBindingSchema,
} from "../../packages/contracts/src/index.js";
import {
  ApprovalError,
  type ApprovalBinding,
  type ApprovalRegistry,
  type VerifiedApproval,
} from "../../packages/memory-kernel/src/index.js";
import type { z } from "zod";

export class TestApprovalRegistry implements ApprovalRegistry {
  readonly grants = new Map<
    string,
    ReturnType<typeof ApprovalGrantSchema.parse>
  >();
  verifyCalls = 0;

  approve(request: {
    envelope: {
      approval_id: string | null;
      actor_claim: { principal_id: string };
      tool: z.input<typeof ApprovalBindingSchema>["tool"];
      safety_class: z.input<
        typeof ApprovalBindingSchema
      >["safety_class"];
      scopes: ReadonlyArray<
        z.input<typeof ApprovalBindingSchema>["scopes"][number]
      >;
    };
  }): void {
    const approvalId = request.envelope.approval_id;
    if (approvalId === null) {
      throw new Error("effect fixture requires approval id");
    }
    const unsigned = {
      schema_version: "1.0.0",
      approval_id: approvalId,
      principal_id: request.envelope.actor_claim.principal_id,
      tool: request.envelope.tool,
      safety_class: request.envelope.safety_class,
      scopes: request.envelope.scopes,
      request_hash: canonicalSha256(request),
      issued_at: "2026-07-28T11:00:00.000Z",
      expires_at: "2026-07-28T14:00:00.000Z",
      manifest_hash: `sha256:${"0".repeat(64)}`,
    } as const;
    this.grants.set(
      approvalId,
      ApprovalGrantSchema.parse({
        ...unsigned,
        manifest_hash: canonicalSha256Omitting(unsigned, ["manifest_hash"]),
      }),
    );
  }

  async verify(binding: ApprovalBinding): Promise<VerifiedApproval> {
    this.verifyCalls += 1;
    const grant = this.grants.get(binding.approval_id);
    if (grant === undefined) {
      throw new ApprovalError("APPROVAL_REQUIRED");
    }
    if (
      grant.approval_id !== binding.approval_id ||
      grant.principal_id !== binding.principal_id ||
      grant.tool !== binding.tool ||
      grant.safety_class !== binding.safety_class ||
      grant.request_hash !== binding.request_hash
    ) {
      throw new ApprovalError("APPROVAL_INVALID");
    }
    return {
      grant,
      registry_hash: canonicalSha256([...this.grants.keys()].sort()),
    };
  }

  async confirmUnchanged(_approval: VerifiedApproval): Promise<void> {}
}

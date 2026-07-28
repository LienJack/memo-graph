import {
  ApprovalGrantSchema,
  ApprovalRegistryManifestSchema,
  ApprovalBindingSchema,
  approvalGrantMatches,
  canonicalSha256,
  type ApprovalGrant,
  type ApprovalBinding,
  type MemoryToolName,
} from "@memo-graph/contracts";
export { ApprovalBindingSchema, type ApprovalBinding };

export type VerifiedApproval = {
  grant: ApprovalGrant;
  registry_hash: `sha256:${string}`;
};

export type ApprovalFailureCode =
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID";

export class ApprovalError extends Error {
  readonly code: ApprovalFailureCode;

  constructor(code: ApprovalFailureCode) {
    super(
      code === "APPROVAL_REQUIRED"
        ? "a trusted approval was not found"
        : "the trusted approval does not authorize this request",
    );
    this.name = "ApprovalError";
    this.code = code;
  }
}

export interface ApprovalRegistry {
  verify(binding: ApprovalBinding): Promise<VerifiedApproval>;
  confirmUnchanged(approval: VerifiedApproval): Promise<void>;
}

export class DenyAllApprovalRegistry implements ApprovalRegistry {
  async verify(_binding: ApprovalBinding): Promise<VerifiedApproval> {
    throw new ApprovalError("APPROVAL_REQUIRED");
  }

  async confirmUnchanged(_approval: VerifiedApproval): Promise<void> {
    throw new ApprovalError("APPROVAL_INVALID");
  }
}

export function assertApprovalGrant(
  bindingInput: unknown,
  grantInput: unknown,
  verifiedAt: string,
): ApprovalGrant {
  const binding = ApprovalBindingSchema.parse(bindingInput);
  const grant = ApprovalGrantSchema.parse(grantInput);
  if (!approvalGrantMatches(binding, grant, verifiedAt)) {
    throw new ApprovalError("APPROVAL_INVALID");
  }
  return grant;
}

export function approvalRegistryHash(input: unknown): `sha256:${string}` {
  return canonicalSha256(ApprovalRegistryManifestSchema.parse(input));
}

export function isApprovalTool(
  tool: MemoryToolName,
): tool is ApprovalBinding["tool"] {
  return ApprovalBindingSchema.shape.tool.options.includes(
    tool as ApprovalBinding["tool"],
  );
}

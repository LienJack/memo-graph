import {
  ApprovalGrantSchema,
  ApprovalRegistryManifestSchema,
  ApprovalBindingSchema,
  CanaryAuthorizationSchema,
  PostCanaryApprovalSchema,
  RuntimeIdentitySchema,
  approvalGrantMatches,
  canonicalJson,
  canonicalSha256,
  type ApprovalGrant,
  type ApprovalBinding,
  type CanaryAuthorization,
  type MemoryToolName,
  type PostCanaryApproval,
  type G6ReleaseControl,
  type G6ReleaseControlTrust,
  type RuntimeIdentityProvider,
} from "@memo-graph/contracts";
import { verifyExactG6ReleaseControl } from "@memo-graph/storage-sqlite";
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

export async function verifyG6ReleaseControl(input: {
  control: unknown;
  trust: G6ReleaseControlTrust;
  runtimeIdentityProvider: RuntimeIdentityProvider;
  now: string;
}): Promise<G6ReleaseControl> {
  const runtimeIdentity = RuntimeIdentitySchema.parse(
    await input.runtimeIdentityProvider.current(),
  );
  try {
    return verifyExactG6ReleaseControl({
      control: input.control,
      trust: input.trust,
      runtimeIdentity,
      now: input.now,
    });
  } catch {
    throw new ApprovalError("APPROVAL_INVALID");
  }
}

export type VerifiedCanaryAuthorization = {
  authorization: CanaryAuthorization;
  registry_hash: `sha256:${string}`;
  verified_at: string;
};

export type VerifiedPostCanaryApproval = {
  approval: PostCanaryApproval;
  registry_hash: `sha256:${string}`;
  verified_at: string;
};

export interface LearningAuthorityRegistry {
  verifyCanaryAuthorization(
    authorizationId: string,
  ): Promise<VerifiedCanaryAuthorization>;
  confirmCanaryAuthorizationUnchanged(
    verified: VerifiedCanaryAuthorization,
  ): Promise<void>;
  verifyPostCanaryApproval(
    approvalId: string,
  ): Promise<VerifiedPostCanaryApproval>;
  confirmPostCanaryApprovalUnchanged(
    verified: VerifiedPostCanaryApproval,
  ): Promise<void>;
}

export class DenyAllApprovalRegistry implements ApprovalRegistry {
  async verify(_binding: ApprovalBinding): Promise<VerifiedApproval> {
    throw new ApprovalError("APPROVAL_REQUIRED");
  }

  async confirmUnchanged(_approval: VerifiedApproval): Promise<void> {
    throw new ApprovalError("APPROVAL_INVALID");
  }
}

export class DenyAllLearningAuthorityRegistry
  implements LearningAuthorityRegistry
{
  async verifyCanaryAuthorization(
    _authorizationId: string,
  ): Promise<VerifiedCanaryAuthorization> {
    throw new ApprovalError("APPROVAL_REQUIRED");
  }

  async confirmCanaryAuthorizationUnchanged(
    _verified: VerifiedCanaryAuthorization,
  ): Promise<void> {
    throw new ApprovalError("APPROVAL_INVALID");
  }

  async verifyPostCanaryApproval(
    _approvalId: string,
  ): Promise<VerifiedPostCanaryApproval> {
    throw new ApprovalError("APPROVAL_REQUIRED");
  }

  async confirmPostCanaryApprovalUnchanged(
    _verified: VerifiedPostCanaryApproval,
  ): Promise<void> {
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

export function assertCanaryAuthorization(
  expectedInput: unknown,
  actualInput: unknown,
  verifiedAt: string,
): CanaryAuthorization {
  try {
    const expected = CanaryAuthorizationSchema.parse(expectedInput);
    const actual = CanaryAuthorizationSchema.parse(actualInput);
    if (
      canonicalJson(expected) !== canonicalJson(actual) ||
      Date.parse(actual.issued_at) > Date.parse(verifiedAt) ||
      Date.parse(actual.expires_at) <= Date.parse(verifiedAt) ||
      Date.parse(actual.deadline_at) > Date.parse(actual.expires_at)
    ) {
      throw new ApprovalError("APPROVAL_INVALID");
    }
    return actual;
  } catch (error) {
    if (error instanceof ApprovalError) {
      throw error;
    }
    throw new ApprovalError("APPROVAL_INVALID");
  }
}

export function assertPostCanaryApproval(
  expectedInput: unknown,
  actualInput: unknown,
  verifiedAt: string,
): PostCanaryApproval {
  try {
    const expected = PostCanaryApprovalSchema.parse(expectedInput);
    const actual = PostCanaryApprovalSchema.parse(actualInput);
    if (
      canonicalJson(expected) !== canonicalJson(actual) ||
      Date.parse(actual.issued_at) > Date.parse(verifiedAt) ||
      Date.parse(actual.expires_at) <= Date.parse(verifiedAt)
    ) {
      throw new ApprovalError("APPROVAL_INVALID");
    }
    return actual;
  } catch (error) {
    if (error instanceof ApprovalError) {
      throw error;
    }
    throw new ApprovalError("APPROVAL_INVALID");
  }
}

export function isApprovalTool(
  tool: MemoryToolName,
): tool is ApprovalBinding["tool"] {
  return ApprovalBindingSchema.shape.tool.options.includes(
    tool as ApprovalBinding["tool"],
  );
}

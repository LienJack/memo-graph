import {
  ApprovalGrantSchema,
  IdentifierSchema,
  PostCanaryApprovalSchema,
  canonicalJson,
  canonicalSha256,
  type ApprovalBinding,
  type ApprovalGrant,
  type PostCanaryApproval,
} from "@memo-graph/contracts";
import type {
  ReleaseApprovalRegistry,
  ReleaseAuthorityRegistry,
} from "@memo-graph/learning-lab";

import {
  OperatorConfigError,
  readPrivateOperatorJson,
  type OperatorConfig,
} from "./config.js";

type PinnedRecord = {
  path: string;
  artifact_hash: string;
};

function loadPinned<T>(input: {
  record: PinnedRecord | undefined;
  parse: (value: unknown) => T;
}): T {
  try {
    if (input.record === undefined) {
      throw new OperatorConfigError();
    }
    const artifact = input.parse(
      readPrivateOperatorJson(input.record.path),
    );
    if (canonicalSha256(artifact) !== input.record.artifact_hash) {
      throw new OperatorConfigError();
    }
    return artifact;
  } catch {
    throw new OperatorConfigError();
  }
}

function bindingFromGrant(grant: ApprovalGrant) {
  return {
    approval_id: grant.approval_id,
    principal_id: grant.principal_id,
    tool: grant.tool,
    safety_class: grant.safety_class,
    scopes: grant.scopes,
    request_hash: grant.request_hash,
    ...(grant.learning === undefined
      ? {}
      : { learning: grant.learning }),
  };
}

export function loadLearningApprovalRegistries(
  config: OperatorConfig,
  clock: () => string = () => new Date().toISOString(),
): {
  authorityRegistry: ReleaseAuthorityRegistry;
  approvalRegistry: ReleaseApprovalRegistry;
  registryHash: `sha256:${string}`;
} {
  const configured = config.learning_rollback;
  if (configured === null) {
    throw new OperatorConfigError();
  }
  const registryHash = canonicalSha256({
    schema_version: "1.0.0",
    principal_id: config.principal_id,
    root_ref: config.root_ref,
    post_canary_approvals: Object.entries(
      configured.post_canary_approvals,
    )
      .map(([id, record]) => ({
        id,
        artifact_hash: record.artifact_hash,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    approval_grants: Object.entries(configured.approval_grants)
      .map(([id, record]) => ({
        id,
        artifact_hash: record.artifact_hash,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });

  const authorityRegistry: ReleaseAuthorityRegistry = {
    async verifyPostCanaryApproval(approvalId) {
      const approval = loadPinned<PostCanaryApproval>({
        record:
          configured.post_canary_approvals[
            IdentifierSchema.parse(approvalId)
          ],
        parse: (value) => PostCanaryApprovalSchema.parse(value),
      });
      if (approval.approval_id !== approvalId) {
        throw new OperatorConfigError();
      }
      return {
        approval,
        registry_hash: registryHash,
        verified_at: clock(),
      };
    },
    async confirmPostCanaryApprovalUnchanged(verified) {
      const current = loadPinned<PostCanaryApproval>({
        record:
          configured.post_canary_approvals[
            verified.approval.approval_id
          ],
        parse: (value) => PostCanaryApprovalSchema.parse(value),
      });
      if (
        verified.registry_hash !== registryHash ||
        canonicalJson(current) !== canonicalJson(verified.approval)
      ) {
        throw new OperatorConfigError();
      }
    },
  };
  const approvalRegistry: ReleaseApprovalRegistry = {
    async verify(binding: ApprovalBinding) {
      const grant = loadPinned<ApprovalGrant>({
        record: configured.approval_grants[binding.approval_id],
        parse: (value) => ApprovalGrantSchema.parse(value),
      });
      if (
        grant.approval_id !== binding.approval_id ||
        canonicalJson(bindingFromGrant(grant)) !==
          canonicalJson(binding)
      ) {
        throw new OperatorConfigError();
      }
      return { grant, registry_hash: registryHash };
    },
    async confirmUnchanged(verified) {
      const current = loadPinned<ApprovalGrant>({
        record:
          configured.approval_grants[
            verified.grant.approval_id
          ],
        parse: (value) => ApprovalGrantSchema.parse(value),
      });
      if (
        verified.registry_hash !== registryHash ||
        canonicalJson(current) !== canonicalJson(verified.grant)
      ) {
        throw new OperatorConfigError();
      }
    },
  };
  return { authorityRegistry, approvalRegistry, registryHash };
}

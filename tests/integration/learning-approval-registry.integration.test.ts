import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalGrantSchema,
  PostCanaryApprovalSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  OperatorConfigSchema,
} from "../../apps/operator-cli/src/config.js";
import {
  loadLearningApprovalRegistries,
} from "../../apps/operator-cli/src/learning-approval-registry.js";

const cleanup: string[] = [];
const HASH = canonicalSha256("learning-approval-registry");
const SCOPE = {
  kind: "workspace" as const,
  id: "workspace_learning_registry",
};

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-m6-registry-")),
  );
  cleanup.push(root);
  return root;
}

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function artifacts(root: string, suffix: string) {
  const approvalBody = {
    schema_version: "1.0.0",
    approval_id: "approval_learning_rollback_1",
    principal_id: "user_local",
    action: "rollback" as const,
    scopes: [SCOPE],
    candidate_id: "candidate_learning_rollback_1",
    release_slot_hash: HASH,
    base_release_id: "release_active_1",
    evaluation_receipt_id: "evaluation_receipt_1",
    evaluation_receipt_hash: HASH,
    canary_receipt_id: "canary_receipt_1",
    canary_receipt_hash: HASH,
    expected_pointer_revision: 1,
    target_release_id: "release_target_1",
    control_epoch: 2,
    request_hash: HASH,
    effect_manifest_hash: HASH,
    issued_at: "2026-07-30T05:00:00.000Z",
    expires_at: "2026-07-30T06:00:00.000Z",
    approval_hash: HASH,
  };
  const approval = PostCanaryApprovalSchema.parse({
    ...approvalBody,
    approval_hash: canonicalSha256Omitting(approvalBody, [
      "approval_hash",
    ]),
  });
  const learning = {
    action: approval.action,
    candidate_id: approval.candidate_id,
    release_slot_hash: approval.release_slot_hash,
    base_release_id: approval.base_release_id,
    evaluation_receipt_id: approval.evaluation_receipt_id,
    evaluation_receipt_hash: approval.evaluation_receipt_hash,
    canary_receipt_id: approval.canary_receipt_id,
    canary_receipt_hash: approval.canary_receipt_hash,
    expected_pointer_revision: approval.expected_pointer_revision,
    target_release_id: approval.target_release_id,
    control_epoch: approval.control_epoch,
    effect_manifest_hash: approval.effect_manifest_hash,
  };
  const binding = {
    approval_id: approval.approval_id,
    principal_id: approval.principal_id,
    tool: "learning_rollback" as const,
    safety_class: "important_mutation" as const,
    scopes: approval.scopes,
    request_hash: approval.request_hash,
    learning,
  };
  const grantBody = {
    schema_version: "1.0.0",
    ...binding,
    issued_at: "2026-07-30T05:00:00.000Z",
    expires_at: "2026-07-30T06:00:00.000Z",
    manifest_hash: HASH,
  };
  const grant = ApprovalGrantSchema.parse({
    ...grantBody,
    manifest_hash: canonicalSha256Omitting(grantBody, [
      "manifest_hash",
    ]),
  });
  const approvalPath = join(root, `approval-${suffix}.json`);
  const grantPath = join(root, `grant-${suffix}.json`);
  writeFileSync(approvalPath, `${canonicalJson(approval)}\n`, {
    mode: 0o600,
  });
  writeFileSync(grantPath, `${canonicalJson(grant)}\n`, {
    mode: 0o600,
  });
  return { approval, binding, grant, approvalPath, grantPath };
}

function registries(
  root: string,
  fixture: ReturnType<typeof artifacts>,
  extraRegistryHashInput: string,
  rootRef = "root_primary",
) {
  const extraPath = join(root, `extra-${extraRegistryHashInput}.json`);
  writeFileSync(extraPath, `${canonicalJson(fixture.grant)}\n`, {
    mode: 0o600,
  });
  const config = OperatorConfigSchema.parse({
    data_root: join(root, "unused-data-root"),
    root_ref: rootRef,
    learning_rollback: {
      post_canary_approvals: {
        [fixture.approval.approval_id]: {
          path: fixture.approvalPath,
          artifact_hash: canonicalSha256(fixture.approval),
        },
      },
      approval_grants: {
        [fixture.grant.approval_id]: {
          path: fixture.grantPath,
          artifact_hash: canonicalSha256(fixture.grant),
        },
        [`extra_registry_${extraRegistryHashInput}`]: {
          path: extraPath,
          artifact_hash: canonicalSha256({
            marker: extraRegistryHashInput,
          }),
        },
      },
    },
  });
  return loadLearningApprovalRegistries(
    config,
    () => "2026-07-30T05:30:00.000Z",
  );
}

describe("config-bound learning approval registries", () => {
  it("rejects cross-registry snapshot replacement before commit", async () => {
    const root = temporaryRoot();
    const fixture = artifacts(root, "one");
    const first = registries(root, fixture, "first");
    const second = registries(root, fixture, "second");
    const verifiedAuthority =
      await first.authorityRegistry.verifyPostCanaryApproval(
        fixture.approval.approval_id,
      );
    const verifiedGrant = await first.approvalRegistry.verify(
      fixture.binding,
    );
    await expect(
      second.authorityRegistry.confirmPostCanaryApprovalUnchanged(
        verifiedAuthority,
      ),
    ).rejects.toThrow("operator configuration is invalid");
    await expect(
      second.approvalRegistry.confirmUnchanged(verifiedGrant),
    ).rejects.toThrow("operator configuration is invalid");
  });

  it("binds the original M5 registries to the configured principal and root", async () => {
    const root = temporaryRoot();
    const fixture = artifacts(root, "config-binding");
    const first = registries(root, fixture, "same", "root_primary");
    const otherRoot = registries(
      root,
      fixture,
      "same",
      "root_replacement",
    );
    const verifiedAuthority =
      await first.authorityRegistry.verifyPostCanaryApproval(
        fixture.approval.approval_id,
      );
    const verifiedGrant = await first.approvalRegistry.verify(
      fixture.binding,
    );
    await expect(
      otherRoot.authorityRegistry.confirmPostCanaryApprovalUnchanged(
        verifiedAuthority,
      ),
    ).rejects.toThrow("operator configuration is invalid");
    await expect(
      otherRoot.approvalRegistry.confirmUnchanged(verifiedGrant),
    ).rejects.toThrow("operator configuration is invalid");
  });
});

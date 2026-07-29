import {
  CanaryAuthorizationSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  assertCanaryAuthorization,
  assertPostCanaryApproval,
} from "../../packages/memory-kernel/src/index.js";
import { describe, expect, it } from "vitest";

import {
  TestLearningAuthorityRegistry,
  canaryAuthorization,
  canaryInput,
  postCanaryApproval,
} from "../helpers/g5-canary.js";
import type {
  runG5Evaluation,
} from "../helpers/g5-replay.js";

describe("separate learning authority chains", () => {
  it("rejects precomputed canary receipts and every exact-binding mismatch", async () => {
    expect(
      CanaryAuthorizationSchema.safeParse({
        schema_version: "1.0.0",
        canary_receipt_id: "receipt_that_cannot_exist_yet",
      }).success,
    ).toBe(false);
    const evaluation = {
      identity: {
        run_id: "run_authority_1",
        candidate_id: "candidate_storage_1",
        environment_hash: canonicalSha256("environment"),
        retrieval_configuration_hash: canonicalSha256("configuration"),
        runtime_identity_hash: canonicalSha256("runtime"),
      },
      receipt: {
        receipt_id: "receipt_eval_authority_1",
        receipt_hash: canonicalSha256("evaluation"),
      },
    } as Awaited<ReturnType<typeof runG5Evaluation>>;
    const input = await canaryInput({ evaluation });
    const authorization = await canaryAuthorization({
      evaluation,
      input,
    });
    expect(() =>
      assertCanaryAuthorization(
        authorization,
        authorization,
        input.started_at,
      ),
    ).not.toThrow();
    for (const changed of [
      { ...authorization, authorization_id: "other_authorization" },
      { ...authorization, principal_id: "other_user" },
      { ...authorization, tool: "other_tool" },
      { ...authorization, safety_class: "destructive" },
      {
        ...authorization,
        scopes: [{ kind: "user", id: "other_user" }],
      },
      { ...authorization, candidate_id: "other_candidate" },
      {
        ...authorization,
        release_slot_hash: canonicalSha256("other_slot"),
      },
      {
        ...authorization,
        base_release_id: "other_release",
      },
      {
        ...authorization,
        request_hash: canonicalSha256("other_request"),
      },
      {
        ...authorization,
        canary_manifest_hash: canonicalSha256("other_manifest"),
      },
      {
        ...authorization,
        evaluation_receipt_hash: canonicalSha256("other_evaluation"),
      },
    ]) {
      try {
        assertCanaryAuthorization(
          authorization,
          changed,
          input.started_at,
        );
        throw new Error("mismatched authorization was accepted");
      } catch (error) {
        expect(error).toMatchObject({ code: "APPROVAL_INVALID" });
      }
    }
  });

  it("keeps post-canary release approval distinct and externally controlled", () => {
    const evaluation = {
      identity: { candidate_id: "candidate_storage_1" },
      receipt: {
        receipt_id: "receipt_eval_authority_2",
        receipt_hash: canonicalSha256("evaluation-2"),
      },
    } as Awaited<ReturnType<typeof runG5Evaluation>>;
    const approval = postCanaryApproval({
      evaluation,
      canaryReceiptId: "receipt_canary_authority_1",
      canaryReceiptHash: canonicalSha256("canary"),
    });
    expect(() =>
      assertPostCanaryApproval(
        approval,
        approval,
        "2026-07-28T12:00:00.000Z",
      ),
    ).not.toThrow();
    try {
      assertPostCanaryApproval(
        approval,
        {
          ...approval,
          canary_receipt_hash: canonicalSha256("changed-canary"),
        },
        "2026-07-28T12:00:00.000Z",
      );
      throw new Error("mismatched approval was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "APPROVAL_INVALID" });
    }
    const authority = new TestLearningAuthorityRegistry();
    expect(
      authority.verifyPostCanaryApproval(approval.approval_id),
    ).rejects.toThrowError("APPROVAL_REQUIRED");
  });
});

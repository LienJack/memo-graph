import { describe, expect, it } from "vitest";

import {
  BackupInspectionResultSchema,
  ContentFreeOperatorResultSchema,
  G6CandidateVerificationResultSchema,
  KeyRotationDryRunResultSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";

const HASH = canonicalSha256("operator-result-contract");

describe("shared operator result contracts", () => {
  it("accepts the exact backup and disabled-rotation result shapes", () => {
    expect(
      BackupInspectionResultSchema.parse({
        schema_version: "1.0.0",
        status: "bundle_verified",
        freshness: "external_head_not_checked",
        backup_id: "backup_contract_001",
        manifest_hash: HASH,
        database_logical_hash: HASH,
        artifact_count: 1,
        required_key_count: 0,
        frontier_digest: HASH,
      }),
    ).toMatchObject({ status: "bundle_verified" });
    expect(
      KeyRotationDryRunResultSchema.parse({
        operation: "key.rotate",
        status: "disabled",
        reason_code: "ENCRYPTION_REQUIRED",
      }),
    ).toMatchObject({ status: "disabled" });
  });

  it("rejects unknown, missing, invalid-state, and content-bearing fields", () => {
    const backup = {
      schema_version: "1.0.0",
      status: "bundle_verified",
      freshness: "external_head_not_checked",
      backup_id: "backup_contract_001",
      manifest_hash: HASH,
      database_logical_hash: HASH,
      artifact_count: 1,
      required_key_count: 0,
      frontier_digest: HASH,
    };
    expect(
      BackupInspectionResultSchema.safeParse({
        ...backup,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      BackupInspectionResultSchema.safeParse({
        ...backup,
        manifest_hash: undefined,
      }).success,
    ).toBe(false);
    expect(
      KeyRotationDryRunResultSchema.safeParse({
        operation: "key.rotate",
        status: "enabled",
        reason_code: "ENCRYPTION_REQUIRED",
      }).success,
    ).toBe(false);
    expect(
      ContentFreeOperatorResultSchema.safeParse({
        status: "restored",
        raw_path: "/private/tmp/restore",
      }).success,
    ).toBe(false);
  });

  it("rejects a G6 output whose eligibility and exit class disagree", () => {
    expect(
      G6CandidateVerificationResultSchema.safeParse({
        schema_version: "1.0.0",
        operation: "g6.verify",
        status: "verified",
        evidence_ref: HASH,
        evidence_bundle_hash: HASH,
        runtime_identity_hash: HASH,
        tested_implementation_digest: HASH,
        eligible: false,
        first_non_pass: "integrity",
        decision_recorded: false,
        current_control_verified: false,
      }).success,
    ).toBe(false);
  });
});

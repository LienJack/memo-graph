import type {
  G6ReleaseControl,
  RuntimeIdentity,
} from "../packages/contracts/src/index.js";

export interface G6VerificationReport {
  schema_version: "1.0.0";
  gate: "G6";
  state: "pass" | "fail" | "blocked";
  eligible: boolean;
  first_non_pass:
    | "integrity"
    | "privacy"
    | "deletion"
    | "encryption"
    | "restore"
    | "rollback"
    | "supply_chain"
    | "binding"
    | null;
  decision_recorded: boolean;
  current_control_verified: boolean;
  evidence_bundle_hash: `sha256:${string}`;
  runtime_identity_hash: `sha256:${string}`;
  tested_implementation_digest: `sha256:${string}`;
}

export function deriveG6ReportState(
  name: "fault" | "resource" | "runbook" | "security" | "supply_chain",
  report: Record<string, unknown>,
): "pass" | "fail" | "blocked";

export function deriveG6HardRules(input: {
  states: Record<string, "pass" | "fail" | "blocked">;
  bindingPassed: boolean;
  codeReviewPassed: boolean;
}): Record<
  | "integrity"
  | "privacy"
  | "deletion"
  | "encryption"
  | "restore"
  | "rollback"
  | "supply_chain"
  | "binding",
  boolean | "blocked"
>;

export interface G6CodeReviewCandidate {
  commit: string;
  tree: string;
  tested_implementation_digest: `sha256:${string}`;
}

export function validateG6CodeReviewArtifact(
  raw: string,
  expectedCandidate: G6CodeReviewCandidate,
): {
  report: Record<string, unknown>;
  passed: boolean;
};

export function verifyG6Evidence(options?: {
  allowDecision?: boolean;
  write?: boolean;
}): Promise<{
  verification: G6VerificationReport;
  runtimeIdentity: RuntimeIdentity;
  manifest: Record<string, unknown>;
  currentControl: G6ReleaseControl | null;
}>;

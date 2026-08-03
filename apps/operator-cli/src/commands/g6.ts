import {
  G6CandidateVerificationResultSchema,
  G6HardRuleSchema,
  G6VerificationReportSchema,
} from "@memo-graph/contracts";

const HARD_RULE_ORDER = G6HardRuleSchema.options;

export function verifyG6Candidate(input: {
  evidenceRef: string;
  report: unknown;
}) {
  const report = G6VerificationReportSchema.parse(input.report);
  const firstNonPass =
    HARD_RULE_ORDER.find((rule) => report.hard_rules[rule] !== true) ??
    null;
  const derivedState =
    firstNonPass === null
      ? "pass"
      : report.hard_rules[firstNonPass] === "blocked"
        ? "blocked"
        : "fail";
  if (
    report.first_non_pass !== firstNonPass ||
    report.state !== derivedState ||
    report.eligible !== (firstNonPass === null) ||
    report.current_control_verified !== report.decision_recorded
  ) {
    throw new Error("G6 verification report claim mismatch");
  }
  return G6CandidateVerificationResultSchema.parse({
    schema_version: "1.0.0" as const,
    operation: "g6.verify" as const,
    status: report.eligible
      ? ("verified" as const)
      : ("blocked" as const),
    evidence_ref: report.evidence_bundle_hash,
    evidence_bundle_hash: report.evidence_bundle_hash,
    runtime_identity_hash: report.runtime_identity_hash,
    tested_implementation_digest:
      report.tested_implementation_digest,
    eligible: report.eligible,
    first_non_pass: report.first_non_pass,
    decision_recorded: report.decision_recorded,
    current_control_verified: report.current_control_verified,
  });
}

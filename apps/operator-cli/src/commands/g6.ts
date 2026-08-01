import {
  CanonicalHashSchema,
  UtcTimestampSchema,
} from "@memo-graph/contracts";
import { z } from "zod";

const G6HardRuleSchema = z.enum([
  "integrity",
  "privacy",
  "deletion",
  "encryption",
  "restore",
  "rollback",
  "supply_chain",
  "binding",
]);

const G6VerificationReportSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    gate: z.literal("G6"),
    state: z.enum(["pass", "fail", "blocked"]),
    eligible: z.boolean(),
    first_non_pass: G6HardRuleSchema.nullable(),
    decision_recorded: z.boolean(),
    current_control_verified: z.boolean(),
    evidence_bundle_hash: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
    tested_implementation_digest: CanonicalHashSchema,
    hard_rules: z
      .record(
        G6HardRuleSchema,
        z.union([z.boolean(), z.literal("blocked")]),
      ),
    report_states: z.record(
      z.string().min(1),
      z.enum(["pass", "fail", "blocked"]),
    ),
    exact_environment: z.record(z.string().min(1), z.unknown()),
    topology: z.string().min(1),
    source_bindings: z.array(z.unknown()).min(1),
    verified_at: UtcTimestampSchema.optional(),
  })
  .strict();

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
  return {
    schema_version: "1.0.0" as const,
    operation: "g6.verify" as const,
    status: report.eligible
      ? ("verified" as const)
      : ("blocked" as const),
    evidence_ref: input.evidenceRef,
    evidence_bundle_hash: report.evidence_bundle_hash,
    runtime_identity_hash: report.runtime_identity_hash,
    tested_implementation_digest:
      report.tested_implementation_digest,
    eligible: report.eligible,
    first_non_pass: report.first_non_pass,
    decision_recorded: report.decision_recorded,
    current_control_verified: report.current_control_verified,
  };
}

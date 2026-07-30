import { canonicalSha256 } from "@memo-graph/contracts";

export function verifyG6Candidate(input: { evidenceRef: string }) {
  return {
    schema_version: "1.0.0" as const,
    operation: "g6.verify" as const,
    status: "verification_required" as const,
    evidence_ref: input.evidenceRef,
    evidence_digest: canonicalSha256({
      evidence_ref: input.evidenceRef,
    }),
    decision_recorded: false as const,
  };
}

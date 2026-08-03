import type {
  EvidenceRecordSchema,
  MemoryCandidateSchema,
} from "@memo-graph/contracts";
import { candidateHasPromptInjectionSignal } from "@memo-graph/contracts";
import type { z } from "zod";

export type AdmissionEvaluation =
  | {
      decision: "activate" | "candidate_only" | "quarantine";
      reason: string;
    }
  | {
      decision: "reject";
      reason: string;
    };

export function evaluateAdmission(
  candidate: z.output<typeof MemoryCandidateSchema>,
  evidence: Array<z.output<typeof EvidenceRecordSchema>>,
): AdmissionEvaluation {
  if (evidence.length === 0) {
    return {
      decision: "reject",
      reason: "L1 admission requires persisted live evidence",
    };
  }
  if (
    candidate.sensitivity === "secret" ||
    evidence.some((item) => item.sensitivity === "secret")
  ) {
    return {
      decision: "reject",
      reason: "secret content requires an encrypted storage policy",
    };
  }
  if (candidateHasPromptInjectionSignal(candidate)) {
    return {
      decision: "quarantine",
      reason: "procedural content carries a prompt-injection signal",
    };
  }
  if (
    candidate.sensitivity === "sensitive" ||
    evidence.some((item) => item.sensitivity === "sensitive")
  ) {
    return {
      decision: "quarantine",
      reason: "sensitive evidence requires explicit review",
    };
  }
  const authorities = evidence.flatMap((item) => [
    item.actor.authority,
    item.authority,
  ]);
  const isGovernedAutomaticConfirmation =
    candidate.transform.name === "automatic-memory-formation" &&
    !candidate.inferred &&
    !candidate.requires_user_confirmation &&
    evidence.some((item) =>
      item.actor.authority === "user_stated" ||
      item.authority === "user_stated"
    ) &&
    authorities.every((authority) =>
      authority === "user_stated" || authority === "observed"
    );
  if (
    authorities.some((authority) =>
      ["observed", "tool_result", "imported"].includes(authority),
    ) &&
    !isGovernedAutomaticConfirmation
  ) {
    return {
      decision: "quarantine",
      reason: "low-authority evidence cannot activate L1 memory",
    };
  }
  if (
    candidate.inferred ||
    candidate.requires_user_confirmation ||
    authorities.some((authority) =>
      ["inferred", "derived"].includes(authority),
    )
  ) {
    return {
      decision: "candidate_only",
      reason: "inferred or unconfirmed evidence remains candidate-only",
    };
  }
  if (
    authorities.every((authority) => authority === "user_stated")
  ) {
    return {
      decision: "activate",
      reason: "live exact-scope user-stated evidence is eligible",
    };
  }
  if (isGovernedAutomaticConfirmation) {
    return {
      decision: "activate",
      reason:
        "explicit user confirmation with bounded assistant context is eligible",
    };
  }
  return {
    decision: "quarantine",
    reason: "evidence authority does not satisfy activation policy",
  };
}

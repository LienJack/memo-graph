export type G4BEligibility = {
  checks: {
    one_candidate: boolean;
    lock_identity: boolean;
    dependency_gate: boolean;
    governance_gate: boolean;
    recovery_gate: boolean;
    replay_repeat: boolean;
    utility_gate: boolean;
    resource_gate: boolean;
    review_gate: boolean;
    evidence_gate: boolean;
  };
  go: boolean;
};

export function evaluateG4BEligibility(
  input: unknown,
): G4BEligibility;

export function assertSingleFrozenCandidate(
  input: unknown,
): void;

export function verifyG4BEvidence(): Promise<{
  eligibility: G4BEligibility;
  replay: unknown;
  resource: unknown;
  manifest: unknown;
}>;

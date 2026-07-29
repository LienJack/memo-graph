type ImplementationIdentity = {
  commit: string;
  tree: string;
  dependency_lock_hash: string;
};

type EvidenceReport = {
  implementation: ImplementationIdentity;
  [key: string]: unknown;
};

type EvidenceManifest = {
  tested_implementation: ImplementationIdentity;
  decision_status: string;
  [key: string]: unknown;
};

export function assertExactG5EvidencePaths(
  paths: readonly string[],
  options?: { allowDecision?: boolean },
): void;

export function evaluateG5Eligibility(
  checks: Record<string, unknown>,
): {
  checks: Record<string, unknown>;
  eligible: boolean;
};

export function assertSingleG5Implementation(input: {
  replay: Record<string, unknown>;
  canary: Record<string, unknown>;
  resource: Record<string, unknown>;
  manifest: Record<string, unknown>;
}): void;

export function verifyG5Evidence(options?: {
  writeReport?: boolean;
}): Promise<{
  eligible: boolean;
  checks: Record<string, boolean>;
  replay: EvidenceReport;
  canary: EvidenceReport;
  resource: EvidenceReport;
  manifest: EvidenceManifest;
}>;

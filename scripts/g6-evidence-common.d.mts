export type G6HardRule =
  | "integrity"
  | "privacy"
  | "deletion"
  | "encryption"
  | "restore"
  | "rollback"
  | "supply_chain"
  | "binding";

export interface G6Fixture {
  schema_version: string;
  gate: string;
  prior_gates: Array<{
    gate: string;
    decision: string;
    commit: string;
    artifact_path: string;
    artifact_sha256: string;
  }>;
  acceptance_examples: Array<{
    id: string;
    oracles: string[];
  }>;
  evidence_families: string[];
  fault_points: string[];
  workloads: string[];
  runbook_steps: string[];
  hard_rule_order: G6HardRule[];
  critical_rule_groups: Record<string, string[]>;
  configuration: {
    graph_enabled: boolean;
    vector_enabled: boolean;
    automatic_learning_publication: boolean;
    topology: string;
  };
  partition_policy: Record<string, string>;
  supply_chain: Record<string, string>;
  allowed_paths: {
    evidence: string[];
    decision: string[];
  };
  fixture_bindings: Array<{
    path: string;
    raw_hash: string;
    canonical_hash: string;
  }>;
  thresholds: {
    schema_version: string;
    environment: {
      runtime: string;
      platform: string;
      filesystem: string;
      topology: string;
      workload: string;
    };
    admission: Record<string, number>;
    claim_boundary: string;
  };
  release_control: {
    schema_version: string;
    decision_recorded: boolean;
    current_control: unknown | null;
    maximum_control_ttl_seconds: number;
    scenarios: Array<{
      name: string;
      decision: "GO" | "NO-GO" | null;
      secret_admission_allowed: boolean;
    }>;
  };
  decision_authority: {
    public_key_spki_base64url: string;
    [key: string]: unknown;
  };
  runtime_inputs: {
    paths: Array<{
      path: string;
      kind: string;
      suffixes?: string[];
      excluded_segments?: string[];
    }>;
    excluded_prefixes: string[];
    tested_implementation_digest: string;
  };
  supply_chain_policy: {
    approved_native_builds: string[];
    approved_native_outputs: Array<{
      name: string;
      relative_path: string;
      raw_digest: string;
    }>;
    [key: string]: unknown;
  };
  fault_fixture: {
    fault_groups: Array<{
      fault_points: string[];
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  resource_fixture: {
    proofs: unknown[];
    [key: string]: unknown;
  };
  runbook_fixture: {
    steps: Array<{
      automation: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const G6_HARD_RULE_ORDER: readonly G6HardRule[];
export const G6_EVIDENCE_PATHS: readonly string[];
export const G6_DECISION_PATHS: readonly string[];

export function canonicalJson(value: unknown): string;
export function canonicalSha256(value: unknown): `sha256:${string}`;
export function rawSha256(value: Uint8Array): `sha256:${string}`;
export function loadG6Fixture(): G6Fixture;
export function validateG6Fixture(input?: G6Fixture): G6Fixture;
export function assertExactG6EvidencePaths(
  paths: readonly string[],
  options?: { allowDecision?: boolean },
): void;
export function evaluateFirstFalse(
  checks: Partial<Record<G6HardRule, boolean | "blocked">>,
): {
  eligible: boolean;
  first_non_pass: G6HardRule | null;
  state: "pass" | "fail" | "blocked";
};
export function assertContentFreeEvidence(value: unknown): unknown;
export function canonicalEvidenceArgv(
  program: string,
  args: string[],
): string[];
export function assertCanonicalRunbookAutomation(
  value: unknown,
  label?: string,
): string;
export interface G6EvidenceProofDefinition {
  id: string;
  obligations: string[];
  program: string;
  args: string[];
}
export interface G6EvidenceProofResult {
  id: string;
  obligations: string[];
  command: string[];
  state: "pass" | "fail" | "blocked";
  exit_code: number | null;
  signal: string | null;
}
export function runEvidenceProofs(
  proofs: G6EvidenceProofDefinition[],
  expectedObligations: string[],
  label: string,
): G6EvidenceProofResult[];
export function deriveProofStates(
  proofs: G6EvidenceProofResult[],
  expectedObligations: string[],
  label: string,
): Record<string, "pass" | "fail" | "blocked">;

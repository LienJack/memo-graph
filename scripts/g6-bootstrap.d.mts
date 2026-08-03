export interface G6ProvenanceVerification {
  state: "pass" | "fail";
  candidate_binding: unknown;
  tested_implementation_digest: unknown;
  statement_digest: unknown;
}

export interface G6LifecycleInventoryValidation {
  state: "pass" | "fail";
  pending_build_count: number;
  approved_pending_count: number;
  ignored_unapproved_count: number;
  source_binding_count: number;
  policy_allowlist_exact: boolean;
  pending_entries_valid: boolean;
  pending_entries_unique: boolean;
  pending_builds_digest: `sha256:${string}` | null;
  approved_pending_sources_digest: `sha256:${string}` | null;
}

export function initializeG6Authority(seedPath?: string): {
  authority_seed_state: "external_restricted";
  public_key_spki_base64url: string;
};

export function buildG6Provenance(options?: {
  write?: boolean;
}): Record<string, unknown>;

export function buildG6DependencyInventory(value: unknown): {
  valid: boolean;
  workspace_projects: string[];
  packages: string[];
};

export function validateG6LifecycleInventory(input: {
  policy: Record<string, unknown>;
  pendingBuilds: unknown;
  lockText: unknown;
}): G6LifecycleInventoryValidation;

export function verifyG6Provenance(
  provenance?: Record<string, unknown>,
): G6ProvenanceVerification;

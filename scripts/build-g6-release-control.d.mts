import type { Buffer } from "node:buffer";

import type {
  G6ReleaseControl,
  G6ReleaseControlTrust,
  RuntimeIdentity,
} from "../packages/contracts/src/index.js";

export interface G6ReleaseControlBuildInput {
  verification: {
    schema_version: "1.0.0";
    gate: "G6";
    state: "pass" | "fail" | "blocked";
    eligible: boolean;
    first_non_pass: string | null;
    decision_recorded: false;
    current_control_verified: false;
    evidence_bundle_hash: `sha256:${string}`;
    runtime_identity_hash: `sha256:${string}`;
    tested_implementation_digest: `sha256:${string}`;
  };
  runtimeIdentity: RuntimeIdentity;
  controlId: string;
  issuedAt: string;
  expiresAt: string;
  privateKeyDescriptor: number;
  authorityKeyId: string;
  authorityKeyGeneration: number;
  trustValidFrom?: string;
  trustExpiresAt?: string;
  revokedAt?: string | null;
}

export function deriveG6DecisionPublicKey(seed: Buffer): string;
export function buildG6ReleaseControl(
  input: G6ReleaseControlBuildInput,
): {
  control: G6ReleaseControl;
  trust: G6ReleaseControlTrust;
  evidence_binding: {
    evidence_bundle_hash: `sha256:${string}`;
    release_binding_hash: `sha256:${string}`;
  };
};

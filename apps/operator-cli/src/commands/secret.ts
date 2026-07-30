import { z } from "zod";

import {
  CanonicalHashSchema,
  IdentifierSchema,
  ScopeSchema,
  SecretContentOwnerSchema,
  canonicalSha256,
  secretAdmissionEnvelopeRequestBindingHash,
  type SecretAdmissionApproval,
  type SecretAdmissionTrust,
} from "@memo-graph/contracts";
import type {
  SqliteStorageClient,
  StorageInspectionClient,
} from "@memo-graph/storage-sqlite";

import { approveSecretAdmission } from "../secret-admission-authority.js";

export const SecretAdmissionRequestSchema = z
  .object({
    idempotency_key: z.string().trim().min(8).max(200),
    request_digest: CanonicalHashSchema,
    principal_id: IdentifierSchema,
    owner: SecretContentOwnerSchema,
    scope: ScopeSchema,
    content_identity: IdentifierSchema,
    media_type: z.string().trim().min(1).max(160),
    request_nonce: IdentifierSchema,
    issued_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.request_digest !==
      canonicalSha256({
        schema_version: "1.0.0",
        purpose: "secret_admission",
        sensitivity: "secret",
        envelope_version: 1,
        idempotency_key: value.idempotency_key,
        principal_id: value.principal_id,
        owner: value.owner,
        scope: value.scope,
        content_identity: value.content_identity,
        media_type: value.media_type,
        request_nonce: value.request_nonce,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["request_digest"],
        message: "secret admission request digest must bind the exact request",
      });
    }
  });

export type SecretAdmissionRequest = z.infer<
  typeof SecretAdmissionRequestSchema
>;

export function secretAdmissionDryRun(): {
  operation: "secret.admit";
  status: "disabled";
  reason_code: "ENCRYPTION_REQUIRED";
  ingress: "private_inherited_descriptor";
} {
  return {
    operation: "secret.admit",
    status: "disabled",
    reason_code: "ENCRYPTION_REQUIRED",
    ingress: "private_inherited_descriptor",
  };
}

export async function approveConfiguredSecretAdmission(input: {
  storage: StorageInspectionClient;
  rootFenceToken: number;
  request: SecretAdmissionRequest;
  inputDescriptor: number;
  signingKeyDescriptor: number;
  commitmentKeyDescriptor: number;
  trust: SecretAdmissionTrust;
}): Promise<SecretAdmissionApproval> {
  const request = SecretAdmissionRequestSchema.parse(input.request);
  const inventory = await input.storage.inspectEncryptionKeys();
  const current = inventory.keys.find(
    ({ key_id }) => key_id === inventory.current_key_id,
  );
  if (
    current === undefined ||
    !Number.isSafeInteger(input.rootFenceToken) ||
    input.rootFenceToken <= 0
  ) {
    throw new Error("secret admission prerequisites are unavailable");
  }
  return approveSecretAdmission({
    inputDescriptor: input.inputDescriptor,
    signingKeyDescriptor: input.signingKeyDescriptor,
    commitmentKeyDescriptor: input.commitmentKeyDescriptor,
    trust: input.trust,
    binding: {
      schema_version: "1.0.0",
      principal_id: request.principal_id,
      purpose: "secret_admission",
      sensitivity: "secret",
      envelope_version: 1,
      request_nonce: request.request_nonce,
      owner: request.owner,
      scope: request.scope,
      request_digest: request.request_digest,
      envelope_aad_hash: secretAdmissionEnvelopeRequestBindingHash({
        key_id: current.key_id,
        key_generation: current.generation,
        owner: request.owner,
        scope: request.scope,
        content_identity: request.content_identity,
        content_class: request.owner.kind,
        media_type: request.media_type,
      }),
      key_id: current.key_id,
      key_generation: current.generation,
      authority_key_id: input.trust.authority_key_id,
      authority_key_generation: input.trust.authority_key_generation,
      signature_algorithm: "Ed25519",
      root_fence_token: input.rootFenceToken,
      issued_at: request.issued_at,
      expires_at: request.expires_at,
    },
  });
}

export function admitConfiguredSecret(input: {
  storage: SqliteStorageClient;
  request: SecretAdmissionRequest;
  approval: SecretAdmissionApproval;
  inputDescriptor: number;
}) {
  const request = SecretAdmissionRequestSchema.parse(input.request);
  return input.storage.governedAdmitSecret({
    ...request,
    input_descriptor: input.inputDescriptor,
    approval: input.approval,
  });
}

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readSync,
} from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  CanonicalHashSchema,
  IdentifierSchema,
  OperatorConfirmationTrustSchema,
  OperationIntentSchema,
  OperationalArtifactClassSchema,
  OperatorConfirmationSchema,
  ReleaseQualificationSchema,
  G6ReleaseControlSchema,
  G6ReleaseControlTrustSchema,
  PINNED_G6_RELEASE_CONTROL_TRUST,
  RuntimeIdentitySchema,
  SecretAdmissionApprovalSchema,
  SecretAdmissionTrustSchema,
  UtcTimestampSchema,
  canonicalSha256,
} from "@memo-graph/contracts";
import { z } from "zod";
import {
  FileRecoveryHeadProvider,
} from "@memo-graph/storage-sqlite";

const MAX_CONFIG_BYTES = 256 * 1024;

export const G6ReleaseControlArtifactSchema = z
  .object({
    control: G6ReleaseControlSchema,
    trust: G6ReleaseControlTrustSchema,
    evidence_binding: z
      .object({
        evidence_bundle_hash: CanonicalHashSchema,
        release_binding_hash: CanonicalHashSchema,
      })
      .strict(),
    verification_time: UtcTimestampSchema,
  })
  .strict();

export const OperatorConfigSchema = z
  .object({
    data_root: z.string().trim().min(1),
    principal_id: IdentifierSchema.default(
      IdentifierSchema.parse("user_local"),
    ),
    root_ref: IdentifierSchema.default(
      IdentifierSchema.parse("root_primary"),
    ),
    qualification: ReleaseQualificationSchema.default({
      status: "pending",
      tested_envelope_digest: null,
    }),
    recovery: z
      .object({
        backup_bundles: z.record(
          IdentifierSchema,
          z.string().trim().min(1),
        ),
        restore_targets: z.record(
          IdentifierSchema,
          z.string().trim().min(1),
        ),
        authority: z
          .object({
            directory: z.string().trim().min(1),
            authority_key_id: IdentifierSchema,
            trust_root_version: z.number().int().positive(),
            private_key_path: z.string().trim().min(1),
            public_key_path: z.string().trim().min(1),
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .default({
        backup_bundles: {},
        restore_targets: {},
        authority: null,
      }),
    operator_confirmation: z
      .object({
        trust: OperatorConfirmationTrustSchema,
        action_ledger_directory: z.string().trim().min(1),
        grants: z.record(
          IdentifierSchema,
          z.string().trim().min(1),
        ),
      })
      .strict()
      .nullable()
      .default(null),
    learning_rollback: z
      .object({
        post_canary_approvals: z.record(
          IdentifierSchema,
          z
            .object({
              path: z.string().trim().min(1),
              artifact_hash: CanonicalHashSchema,
            })
            .strict(),
        ),
        approval_grants: z.record(
          IdentifierSchema,
          z
            .object({
              path: z.string().trim().min(1),
              artifact_hash: CanonicalHashSchema,
            })
            .strict(),
        ),
      })
      .strict()
      .nullable()
      .default(null),
    operational_artifacts: z
      .object({
        roots: z.record(
          OperationalArtifactClassSchema,
          z.string().trim().min(1),
        ),
        forbidden_markers: z.array(z.string().min(1).max(512)),
      })
      .strict()
      .nullable()
      .default(null),
    secret_admission: z
      .object({
        enabled: z.boolean(),
        approval_trust: SecretAdmissionTrustSchema,
        signing_private_key_path: z.string().trim().min(1),
        commitment_key_path: z.string().trim().min(1),
        release_control_path: z.string().trim().min(1),
        release_trust: G6ReleaseControlTrustSchema,
        runtime_identity_path: z.string().trim().min(1),
        encryption_provider: z
          .object({
            key_id: IdentifierSchema,
            key_generation: z.number().int().positive(),
            key_path: z.string().trim().min(1),
            commitment_key_id: IdentifierSchema,
            commitment_key_path: z.string().trim().min(1),
          })
          .strict(),
        requests: z.record(IdentifierSchema, z.string().trim().min(1)),
        approvals: z.record(IdentifierSchema, z.string().trim().min(1)),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

export type OperatorConfig = z.output<typeof OperatorConfigSchema>;

export class OperatorConfigError extends Error {
  constructor() {
    super("operator configuration is invalid");
    this.name = "OperatorConfigError";
  }
}

export const OperatorGrantSchema = z
  .object({
    intent: OperationIntentSchema,
    confirmation: OperatorConfirmationSchema,
    payload: z.unknown(),
  })
  .strict();

export type OperatorGrant = z.output<typeof OperatorGrantSchema>;

function resolveNoSymlinkTail(pathInput: string): string {
  if (!isAbsolute(pathInput)) {
    throw new OperatorConfigError();
  }
  const path = resolve(pathInput);
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new OperatorConfigError();
    }
    cursor = parent;
  }
  const stat = lstatSync(cursor);
  if (stat.isSymbolicLink() || realpathSync(cursor) !== cursor) {
    throw new OperatorConfigError();
  }
  return path;
}

function pathContains(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    (fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`) &&
      !isAbsolute(fromParent))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function validateOperatorPaths(config: OperatorConfig): OperatorConfig {
  const dataRoot = resolveNoSymlinkTail(config.data_root);
  const backupRoots = Object.values(
    config.recovery.backup_bundles,
  ).map(resolveNoSymlinkTail);
  const restoreTargets = Object.values(
    config.recovery.restore_targets,
  ).map(resolveNoSymlinkTail);
  const protectedRoots = [dataRoot, ...backupRoots, ...restoreTargets];
  for (const [index, target] of restoreTargets.entries()) {
    if (
      pathsOverlap(dataRoot, target) ||
      backupRoots.some((backup) => pathsOverlap(backup, target))
    ) {
      throw new OperatorConfigError();
    }
    for (
      let other = index + 1;
      other < restoreTargets.length;
      other += 1
    ) {
      const otherTarget = restoreTargets[other];
      if (
        otherTarget !== undefined &&
        pathsOverlap(target, otherTarget)
      ) {
        throw new OperatorConfigError();
      }
    }
  }

  const recoveryAuthority = config.recovery.authority;
  const authorityDirectory =
    recoveryAuthority === null
      ? null
      : resolveNoSymlinkTail(recoveryAuthority.directory);
  const authorityKeys =
    recoveryAuthority === null
      ? []
      : [
          resolveNoSymlinkTail(recoveryAuthority.private_key_path),
          resolveNoSymlinkTail(recoveryAuthority.public_key_path),
        ];
  const confirmationAuthority = config.operator_confirmation;
  const actionLedger =
    confirmationAuthority === null
      ? null
      : resolveNoSymlinkTail(
          confirmationAuthority.action_ledger_directory,
        );
  const grantPaths =
    confirmationAuthority === null
      ? []
      : Object.values(confirmationAuthority.grants).map(
          resolveNoSymlinkTail,
        );
  const learningArtifactPaths =
    config.learning_rollback === null
      ? []
      : [
          ...Object.values(
            config.learning_rollback.post_canary_approvals,
          ),
          ...Object.values(config.learning_rollback.approval_grants),
        ].map(({ path }) => resolveNoSymlinkTail(path));
  const operationalArtifacts = config.operational_artifacts;
  const secretAdmissionPaths =
    config.secret_admission === null
      ? []
      : [
          config.secret_admission.signing_private_key_path,
          config.secret_admission.commitment_key_path,
          config.secret_admission.release_control_path,
          config.secret_admission.runtime_identity_path,
          config.secret_admission.encryption_provider.key_path,
          config.secret_admission.encryption_provider.commitment_key_path,
          ...Object.values(config.secret_admission.requests),
          ...Object.values(config.secret_admission.approvals),
        ].map(resolveNoSymlinkTail);
  const operationalArtifactRoots =
    operationalArtifacts === null
      ? []
      : OperationalArtifactClassSchema.options.map(
          (artifactClass) =>
            [
              artifactClass,
              resolveNoSymlinkTail(
                operationalArtifacts.roots[artifactClass],
              ),
            ] as const,
        );
  for (
    let index = 0;
    index < operationalArtifactRoots.length;
    index += 1
  ) {
    for (
      let other = index + 1;
      other < operationalArtifactRoots.length;
      other += 1
    ) {
      const left = operationalArtifactRoots[index];
      const right = operationalArtifactRoots[other];
      if (
        left !== undefined &&
        right !== undefined &&
        pathsOverlap(left[1], right[1])
      ) {
        throw new OperatorConfigError();
      }
    }
  }
  if (
    config.secret_admission !== null &&
    new Set(secretAdmissionPaths.slice(0, 6)).size !== 6
  ) {
    throw new OperatorConfigError();
  }
  if (
    config.secret_admission !== null &&
    (authorityKeys.some((keyPath) =>
      secretAdmissionPaths.slice(0, 6).includes(keyPath),
    ) ||
      (confirmationAuthority !== null &&
        [
          config.secret_admission.approval_trust
            .public_key_spki_base64url,
          config.secret_admission.release_trust
            .public_key_spki_base64url,
        ].includes(confirmationAuthority.trust.public_key_spki)))
  ) {
    throw new OperatorConfigError();
  }

  for (const externalPath of [
    ...(authorityDirectory === null ? [] : [authorityDirectory]),
    ...authorityKeys,
    ...(actionLedger === null ? [] : [actionLedger]),
    ...grantPaths,
    ...learningArtifactPaths,
    ...secretAdmissionPaths,
  ]) {
    if (
      protectedRoots.some((root) => pathsOverlap(root, externalPath))
    ) {
      throw new OperatorConfigError();
    }
  }
  const quarantineRoot = operationalArtifactRoots.find(
    ([artifactClass]) => artifactClass === "quarantine",
  )?.[1];
  if (
    quarantineRoot !== undefined &&
    [
      ...protectedRoots,
      ...(authorityDirectory === null ? [] : [authorityDirectory]),
      ...authorityKeys,
      ...(actionLedger === null ? [] : [actionLedger]),
      ...grantPaths,
      ...learningArtifactPaths,
      ...secretAdmissionPaths,
    ].some((path) => pathsOverlap(path, quarantineRoot))
  ) {
    throw new OperatorConfigError();
  }
  if (
    authorityDirectory !== null &&
    actionLedger !== null &&
    pathsOverlap(authorityDirectory, actionLedger)
  ) {
    throw new OperatorConfigError();
  }
  for (const grantPath of grantPaths) {
    if (
      (actionLedger !== null &&
        pathsOverlap(actionLedger, grantPath)) ||
      (authorityDirectory !== null &&
        pathsOverlap(authorityDirectory, grantPath))
    ) {
      throw new OperatorConfigError();
    }
  }
  for (const artifactPath of learningArtifactPaths) {
    if (
      (actionLedger !== null &&
        pathsOverlap(actionLedger, artifactPath)) ||
      (authorityDirectory !== null &&
        pathsOverlap(authorityDirectory, artifactPath)) ||
      grantPaths.some((grantPath) => grantPath === artifactPath)
    ) {
      throw new OperatorConfigError();
    }
  }
  if (
    authorityKeys.length === 2 &&
    authorityKeys[0] === authorityKeys[1]
  ) {
    throw new OperatorConfigError();
  }
  for (const keyPath of authorityKeys) {
    if (
      (actionLedger !== null &&
        pathsOverlap(actionLedger, keyPath)) ||
      grantPaths.some((grantPath) => grantPath === keyPath)
    ) {
      throw new OperatorConfigError();
    }
  }
  return config;
}

function readPrivateJson(pathInput: string): unknown {
  return JSON.parse(readPrivateBytes(pathInput).toString("utf8")) as unknown;
}

export function readPrivateOperatorJson(pathInput: string): unknown {
  try {
    return readPrivateJson(pathInput);
  } catch {
    throw new OperatorConfigError();
  }
}

function readPrivateBytes(pathInput: string): Buffer {
  const path = resolve(pathInput);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    const expectedOwner = process.getuid?.();
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > MAX_CONFIG_BYTES ||
      (before.mode & 0o077) !== 0 ||
      (expectedOwner !== undefined && before.uid !== expectedOwner)
    ) {
      throw new OperatorConfigError();
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) {
        throw new OperatorConfigError();
      }
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new OperatorConfigError();
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function openPrivateOperatorDescriptor(pathInput: string): number {
  let descriptor: number | undefined;
  try {
    const path = resolve(pathInput);
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(descriptor);
    const expectedOwner = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > MAX_CONFIG_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (expectedOwner !== undefined && stat.uid !== expectedOwner)
    ) {
      throw new OperatorConfigError();
    }
    return descriptor;
  } catch {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    throw new OperatorConfigError();
  }
}

export function loadSecretAdmissionArtifacts(
  config: OperatorConfig,
  input: { requestRef?: string; approvalRef?: string },
) {
  const admission = config.secret_admission;
  if (admission === null) {
    throw new OperatorConfigError();
  }
  const request =
    input.requestRef === undefined
      ? null
      : readPrivateOperatorJson(
          admission.requests[IdentifierSchema.parse(input.requestRef)] ??
            (() => {
              throw new OperatorConfigError();
            })(),
        );
  const approval =
    input.approvalRef === undefined
      ? null
      : SecretAdmissionApprovalSchema.parse(
          readPrivateOperatorJson(
            admission.approvals[
              IdentifierSchema.parse(input.approvalRef)
            ] ??
              (() => {
                throw new OperatorConfigError();
              })(),
          ),
        );
  const releaseArtifact = G6ReleaseControlArtifactSchema.parse(
    readPrivateOperatorJson(admission.release_control_path),
  );
  const evidenceBundleTag =
    releaseArtifact.evidence_binding.evidence_bundle_hash.slice(
      "sha256:".length,
    );
  if (
    canonicalSha256(admission.release_trust) !==
      canonicalSha256(PINNED_G6_RELEASE_CONTROL_TRUST) ||
    canonicalSha256(releaseArtifact.trust) !==
      canonicalSha256(admission.release_trust) ||
    !releaseArtifact.control.control_id.endsWith(
      `:${evidenceBundleTag}`,
    ) ||
    releaseArtifact.evidence_binding.release_binding_hash !==
      canonicalSha256({
        control_hash: releaseArtifact.control.control_hash,
        evidence_bundle_hash:
          releaseArtifact.evidence_binding.evidence_bundle_hash,
      })
  ) {
    throw new OperatorConfigError();
  }
  return {
    admission,
    request,
    approval,
    control: releaseArtifact.control,
    releaseArtifact,
    runtimeIdentity: RuntimeIdentitySchema.parse(
      readPrivateOperatorJson(admission.runtime_identity_path),
    ),
  };
}

export function loadSecretAdmissionRequest(
  config: OperatorConfig,
  requestRef: string,
) {
  const admission = config.secret_admission;
  if (admission === null) {
    throw new OperatorConfigError();
  }
  const path = admission.requests[IdentifierSchema.parse(requestRef)];
  if (path === undefined) {
    throw new OperatorConfigError();
  }
  return {
    admission,
    request: readPrivateOperatorJson(path),
  };
}

export function loadOperatorConfig(pathInput: string): OperatorConfig {
  try {
    return validateOperatorPaths(
      OperatorConfigSchema.parse(readPrivateJson(pathInput)),
    );
  } catch {
    throw new OperatorConfigError();
  }
}

export function loadOperatorGrant(
  config: OperatorConfig,
  grantRef: string,
): OperatorGrant {
  try {
    const authority = config.operator_confirmation;
    const path = authority?.grants[IdentifierSchema.parse(grantRef)];
    if (authority === null || path === undefined) {
      throw new OperatorConfigError();
    }
    return OperatorGrantSchema.parse(readPrivateJson(path));
  } catch {
    throw new OperatorConfigError();
  }
}

export function loadRecoveryHeadProvider(config: OperatorConfig) {
  const authority = config.recovery.authority;
  if (authority === null) {
    throw new OperatorConfigError();
  }
  const privateBytes = readPrivateBytes(authority.private_key_path);
  const publicBytes = readPrivateBytes(authority.public_key_path);
  try {
    return new FileRecoveryHeadProvider({
      directory: authority.directory,
      authorityKeyId: authority.authority_key_id,
      trustRootVersion: authority.trust_root_version,
      privateKey: createPrivateKey(privateBytes),
      publicKey: createPublicKey(publicBytes),
    });
  } catch {
    throw new OperatorConfigError();
  } finally {
    privateBytes.fill(0);
    publicBytes.fill(0);
  }
}

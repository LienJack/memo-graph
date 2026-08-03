import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  WorkbenchEndpointMetadataSchema,
  AutomaticMemoryHookDescriptorSchema,
  canonicalJson,
  type CanonicalHash,
  type RuntimeRootIdentity,
  type WorkbenchEndpointMetadata,
  type AutomaticMemoryHookDescriptor,
} from "@memo-graph/contracts";
import { readPrivateOperatorFile } from "@memo-graph/runtime-host";

type FileIdentity = { dev: number; ino: number };

export type WorkbenchArtifactPaths = {
  runtimeDirectory: string;
  endpointPath: string;
  controlCredentialPath: string;
  launchLockPath: string;
  runtimeDescriptorPath: string;
  runtimeCredentialPath: string;
  runtimeSocketPath: string;
  hookDescriptorPath: string;
  hookCredentialPath: string;
};

export function assertPrivateWorkbenchDirectory(pathInput: string): string {
  const path = resolve(pathInput);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    realpathSync(path) !== path
  ) {
    throw new Error("workbench runtime directory is invalid");
  }
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    (after.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && after.uid !== expectedUid)
  ) {
    throw new Error("workbench runtime directory is not private");
  }
  return path;
}

export function workbenchArtifactPaths(input: {
  runtimeDirectory: string;
  rootIdentity: RuntimeRootIdentity;
  configIdentity: CanonicalHash;
}): WorkbenchArtifactPaths {
  const runtimeDirectory = assertPrivateWorkbenchDirectory(
    input.runtimeDirectory,
  );
  const stem = [
    input.rootIdentity.canonical_root_hash.slice("sha256:".length, 14),
    input.configIdentity.slice("sha256:".length, 14),
  ].join("-");
  return {
    runtimeDirectory,
    endpointPath: join(runtimeDirectory, `w-${stem}.json`),
    controlCredentialPath: join(runtimeDirectory, `w-${stem}.key`),
    launchLockPath: join(runtimeDirectory, `w-${stem}.lock`),
    runtimeDescriptorPath: join(runtimeDirectory, `h-${stem}.json`),
    runtimeCredentialPath: join(runtimeDirectory, `h-${stem}.key`),
    runtimeSocketPath: join(runtimeDirectory, `h-${stem}.sock`),
    hookDescriptorPath: join(runtimeDirectory, `k-${stem}.json`),
    hookCredentialPath: join(runtimeDirectory, `k-${stem}.key`),
  };
}

export function publishPrivateFile(
  path: string,
  bytes: Buffer | string,
): FileIdentity {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    unlinkSync(temporary);
    const stat = lstatSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
    throw error;
  }
}

export function publishWorkbenchEndpoint(
  path: string,
  endpoint: WorkbenchEndpointMetadata,
): FileIdentity {
  const exact = WorkbenchEndpointMetadataSchema.parse(endpoint);
  return publishPrivateFile(path, `${canonicalJson(exact)}\n`);
}

export function publishAutomaticMemoryHookDescriptor(
  path: string,
  descriptor: AutomaticMemoryHookDescriptor,
): FileIdentity {
  const exact = AutomaticMemoryHookDescriptorSchema.parse(descriptor);
  return publishPrivateFile(path, `${canonicalJson(exact)}\n`);
}

export function readAutomaticMemoryHookDescriptor(
  path: string,
): AutomaticMemoryHookDescriptor {
  const bytes = readPrivateOperatorFile(path);
  try {
    return AutomaticMemoryHookDescriptorSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  } finally {
    bytes.fill(0);
  }
}

export function readWorkbenchEndpoint(path: string): WorkbenchEndpointMetadata {
  const bytes = readPrivateOperatorFile(path);
  try {
    return WorkbenchEndpointMetadataSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  } finally {
    bytes.fill(0);
  }
}

export function removeOwnedArtifact(
  path: string,
  identity: FileIdentity | null,
): void {
  if (identity === null || !existsSync(path)) {
    return;
  }
  const stat = lstatSync(path);
  if (
    !stat.isSymbolicLink() &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino
  ) {
    unlinkSync(path);
  }
}

export function quarantineArtifacts(
  paths: readonly string[],
  quarantineDirectory: string,
): string[] {
  const quarantine = join(
    assertPrivateWorkbenchDirectory(quarantineDirectory),
    `stale-${randomUUID()}`,
  );
  mkdirSync(quarantine, { mode: 0o700 });
  const moved: string[] = [];
  try {
    for (const path of paths) {
      if (!existsSync(path)) {
        continue;
      }
      const target = join(quarantine, `artifact-${moved.length}`);
      renameSync(path, target);
      moved.push(target);
    }
    return moved;
  } catch (error) {
    throw new Error("stale workbench artifacts could not be quarantined", {
      cause: error,
    });
  } finally {
    rmSync(quarantine, { recursive: true, force: true });
  }
}

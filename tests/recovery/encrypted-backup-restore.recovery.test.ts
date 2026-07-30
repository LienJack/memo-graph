import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CompleteBackupManifestSchema,
  IdentifierSchema,
  canonicalJson,
  canonicalSha256,
  type CompleteBackupManifest,
} from "../../packages/contracts/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
  verifyCompleteBackupBundle,
} from "@memo-graph/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { testRecoveryHeadProvider } from "../helpers/recovery.js";

const cleanup: string[] = [];
const descriptors: number[] = [];

function temporaryRoot(label: string): string {
  const path = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-u3-secret-${label}-`)),
  );
  cleanup.push(path);
  return path;
}

function descriptor(root: string, name: string, bytes: Uint8Array): number {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  const value = openSync(path, "r");
  descriptors.push(value);
  return value;
}

function manifestWithArtifacts(
  manifest: CompleteBackupManifest,
  artifacts: CompleteBackupManifest["artifacts"],
): CompleteBackupManifest {
  const body: Record<string, unknown> = { ...manifest, artifacts };
  delete body.manifest_hash;
  return CompleteBackupManifestSchema.parse({
    ...body,
    manifest_hash: canonicalSha256(body),
  });
}

afterEach(() => {
  for (const value of descriptors.splice(0)) {
    closeSync(value);
  }
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("encrypted complete backup restore", () => {
  it("copies external ciphertext and rejects unavailable key identity", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:encrypted",
    );
    const source = temporaryRoot("source");
    const keyRoot = temporaryRoot("keys");
    const keyDescriptor = descriptor(keyRoot, "key.bin", Buffer.alloc(32, 0x31));
    const authorityDescriptor = descriptor(
      keyRoot,
      "authority.bin",
      Buffer.alloc(32, 0x32),
    );
    const commitmentDescriptor = descriptor(
      keyRoot,
      "commitment.bin",
      Buffer.alloc(32, 0x33),
    );
    const secretDescriptor = descriptor(
      keyRoot,
      "secret.bin",
      Buffer.alloc(70 * 1024, 0x53),
    );
    const inlineSecretDescriptor = descriptor(
      keyRoot,
      "inline-secret.bin",
      Buffer.alloc(1024, 0x54),
    );
    const storage = await SqliteStorageClient.open({
      dataRoot: source,
      testOperations: true,
      secretPrincipalId: "principal:encrypted-restore",
      recoveryHeadProvider,
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-encrypted-restore-key-001",
      key_id: "key:encrypted-restore:1",
      key_generation: 1,
      key_descriptor: keyDescriptor,
      authority_key_id: "authority:encrypted-restore:1",
      authority_descriptor: authorityDescriptor,
      commitment_key_id: "commitment:encrypted-restore:1",
      commitment_descriptor: commitmentDescriptor,
    });
    await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-encrypted-restore-secret-001",
      request_digest: canonicalSha256({
        operation: "encrypted-restore",
        owner: "evidence:encrypted-restore:1",
      }),
      principal_id: "principal:encrypted-restore",
      owner: {
        kind: "evidence",
        id: "evidence:encrypted-restore:1",
        generation: 1,
      },
      scope: { kind: "workspace", id: "workspace:encrypted-restore" },
      content_identity: "content:encrypted-restore:1",
      media_type: "application/octet-stream",
      input_descriptor: secretDescriptor,
    });
    await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-encrypted-restore-inline-secret-001",
      request_digest: canonicalSha256({
        operation: "encrypted-restore-inline",
        owner: "evidence:encrypted-restore:inline",
      }),
      principal_id: "principal:encrypted-restore",
      owner: {
        kind: "evidence",
        id: "evidence:encrypted-restore:inline",
        generation: 1,
      },
      scope: { kind: "workspace", id: "workspace:encrypted-restore" },
      content_identity: "content:encrypted-restore:inline",
      media_type: "application/octet-stream",
      input_descriptor: inlineSecretDescriptor,
    });
    const backup = await storage.createBackup();
    await storage.close();
    expect(
      backup.manifest.artifacts.some(
        ({ kind, storage_kind }) =>
          kind === "ciphertext" && storage_kind === "external",
      ),
    ).toBe(true);
    const inlineArtifact = backup.manifest.artifacts.find(
      ({ kind, storage_kind }) =>
        kind === "ciphertext" && storage_kind === "inline",
    );
    expect(inlineArtifact).toBeDefined();
    if (inlineArtifact === undefined) {
      throw new Error("encrypted backup fixture requires inline ciphertext");
    }
    const manifestPath = join(backup.directory, "manifest.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    const missingInline = manifestWithArtifacts(
      backup.manifest,
      backup.manifest.artifacts.filter(
        ({ artifact_id }) => artifact_id !== inlineArtifact.artifact_id,
      ),
    );
    writeFileSync(manifestPath, `${canonicalJson(missingInline)}\n`, {
      mode: 0o600,
    });
    expect(() =>
      verifyCompleteBackupBundle({ directory: backup.directory }),
    ).toThrowError(expect.objectContaining({ code: "CORRUPTION" }));

    const extraInline = manifestWithArtifacts(backup.manifest, [
      ...backup.manifest.artifacts,
      {
        ...inlineArtifact,
        artifact_id: IdentifierSchema.parse(
          "ciphertext:forged-inline-inventory",
        ),
      },
    ]);
    writeFileSync(manifestPath, `${canonicalJson(extraInline)}\n`, {
      mode: 0o600,
    });
    expect(() =>
      verifyCompleteBackupBundle({ directory: backup.directory }),
    ).toThrowError(expect.objectContaining({ code: "CORRUPTION" }));
    writeFileSync(manifestPath, originalManifest, { mode: 0o600 });

    const wrongKeyDescriptor = descriptor(
      keyRoot,
      "wrong-key.bin",
      Buffer.alloc(32, 0x7f),
    );
    const wrongTarget = join(temporaryRoot("wrong-parent"), "target");
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: wrongTarget,
        recoveryHeadProvider,
        requiredKeyDescriptors: {
          "key:encrypted-restore:1": wrongKeyDescriptor,
        },
      }),
    ).rejects.toMatchObject({ code: "KEY_UNAVAILABLE" });
    expect(existsSync(wrongTarget)).toBe(false);

    const target = join(temporaryRoot("target-parent"), "target");
    const restored = await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: target,
      recoveryHeadProvider,
      requiredKeyDescriptors: {
        "key:encrypted-restore:1": keyDescriptor,
      },
    });
    expect(restored.verification.verified_encrypted_contents).toBe(2);
  });
});

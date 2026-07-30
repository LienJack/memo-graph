import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../packages/contracts/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

const cleanupPaths: string[] = [];
const openDescriptors: number[] = [];
const PLAINTEXT_MARKER = "secret-at-rest-plaintext-marker-813704";
const RAW_KEY_MARKER = "u2-raw-key-marker-1234567890abcd";
const AUTHORITY_KEY_MARKER = "u2-authority-key-1234567890abcdx";
const COMMITMENT_KEY_MARKER = "u2-commit-key-1234567890abcdefxx";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function privateDescriptor(
  root: string,
  name: string,
  bytes: Uint8Array,
): number {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  const descriptor = openSync(path, "r");
  openDescriptors.push(descriptor);
  return descriptor;
}

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

afterEach(() => {
  while (openDescriptors.length > 0) {
    const descriptor = openDescriptors.pop();
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("secret at-rest boundaries", () => {
  it("keeps plaintext and key bytes out of SQLite, WAL, backup, diagnostics, and receipts", async () => {
    const dataRoot = temporaryRoot("secret-at-rest");
    const descriptorRoot = temporaryRoot("secret-at-rest-descriptors");
    const diagnostics: unknown[] = [];
    const keyDescriptor = privateDescriptor(
      descriptorRoot,
      "key.bin",
      Buffer.from(RAW_KEY_MARKER, "utf8"),
    );
    const authorityDescriptor = privateDescriptor(
      descriptorRoot,
      "authority.bin",
      Buffer.from(AUTHORITY_KEY_MARKER, "utf8"),
    );
    const commitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "commitment.bin",
      Buffer.from(COMMITMENT_KEY_MARKER, "utf8"),
    );
    const secretDescriptor = privateDescriptor(
      descriptorRoot,
      "secret.txt",
      Buffer.from(PLAINTEXT_MARKER, "utf8"),
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:secret-at-rest",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const installReceipt =
      await storage.darkLaunchInstallEncryptionKey({
        idempotency_key: "install-secret-at-rest-key-001",
        key_id: "key:secret-at-rest:1",
        key_generation: 1,
        key_descriptor: keyDescriptor,
        authority_key_id: "authority:secret-at-rest:1",
        authority_descriptor: authorityDescriptor,
        commitment_key_id: "commitment:secret-at-rest:1",
        commitment_descriptor: commitmentDescriptor,
      });
    const admissionReceipt = await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-secret-at-rest-001",
      request_digest: canonicalSha256({
        operation: "secret-at-rest-test",
        owner: "evidence:secret-at-rest:1",
      }),
      principal_id: "principal:secret-at-rest",
      owner: {
        kind: "evidence",
        id: "evidence:secret-at-rest:1",
        generation: 1,
      },
      scope: { kind: "workspace", id: "workspace:secret-at-rest" },
      content_identity: "content:secret-at-rest:1",
      media_type: "text/plain",
      input_descriptor: secretDescriptor,
    });
    const backup = await storage.createBackup();

    for (const output of [
      installReceipt,
      admissionReceipt,
      await storage.inspectEncryptionKeys(),
      backup,
      diagnostics,
    ]) {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(PLAINTEXT_MARKER);
      expect(serialized).not.toContain(RAW_KEY_MARKER);
      expect(serialized).not.toContain(AUTHORITY_KEY_MARKER);
      expect(serialized).not.toContain(COMMITMENT_KEY_MARKER);
    }
    expect(
      await storage.searchEvidence({
        query: PLAINTEXT_MARKER,
        principal_id: "principal:secret-at-rest",
        scope: { kind: "workspace", id: "workspace:secret-at-rest" },
        limit: 10,
      }),
    ).toMatchObject({ items: [] });

    const markers = [
      Buffer.from(PLAINTEXT_MARKER, "utf8"),
      Buffer.from(RAW_KEY_MARKER, "utf8"),
      Buffer.from(AUTHORITY_KEY_MARKER, "utf8"),
      Buffer.from(COMMITMENT_KEY_MARKER, "utf8"),
    ];
    for (const path of filesUnder(dataRoot)) {
      const bytes = readFileSync(path);
      for (const marker of markers) {
        expect(
          bytes.includes(marker),
          `${path} contains a secret marker`,
        ).toBe(false);
      }
    }
    expect(filesUnder(dataRoot)).toContain(backup.path);
    await storage.close();
  });

  it("does not expose the internal coordinator and production clients cannot invoke dark-launch ingress", async () => {
    const dataRoot = temporaryRoot("secret-production-guard");
    const descriptorRoot = temporaryRoot("secret-production-descriptors");
    const keyDescriptor = privateDescriptor(
      descriptorRoot,
      "key.bin",
      Buffer.from(RAW_KEY_MARKER, "utf8"),
    );
    const authorityDescriptor = privateDescriptor(
      descriptorRoot,
      "authority.bin",
      Buffer.alloc(32, 0x43),
    );
    const commitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "commitment.bin",
      Buffer.alloc(32, 0x44),
    );
    const storage = await SqliteStorageClient.open({ dataRoot });

    await expect(
      storage.darkLaunchInstallEncryptionKey({
        idempotency_key: "production-key-install-denied-001",
        key_id: "key:production:denied",
        key_generation: 1,
        key_descriptor: keyDescriptor,
        authority_key_id: "authority:production:denied",
        authority_descriptor: authorityDescriptor,
        commitment_key_id: "commitment:production:denied",
        commitment_descriptor: commitmentDescriptor,
      }),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    expect(await storage.inspectEncryptionKeys()).toMatchObject({
      keys: [],
      current_key_id: null,
      encrypted_content_count: 0,
    });
    const publicModule = await import(
      "../../packages/storage-sqlite/src/index.js"
    );
    expect(publicModule).not.toHaveProperty("SecretIngressCoordinator");
    expect(publicModule).not.toHaveProperty(
      "createSecretIngressCoordinator",
    );
    await storage.close();
  });
});

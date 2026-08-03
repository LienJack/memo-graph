import {
  closeSync,
  existsSync,
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
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../packages/contracts/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { testRecoveryHeadProvider } from "../helpers/recovery.js";

const cleanupPaths: string[] = [];
const openDescriptors: number[] = [];
const PLAINTEXT_MARKER = "rotation-residual-plaintext-marker-119843";
const OLD_KEY_MARKER = "u2-old-key-marker-1234567890abcd";
const NEW_KEY_MARKER = "u2-new-key-marker-1234567890abcd";
const AUTHORITY_KEY_MARKER = "u2-purge-auth-key-1234567890abcd";

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

describe("secret content residuals across rotation", () => {
  it("keeps plaintext and both raw keys absent from every persisted artifact before and after restart", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:secret-residual",
    );
    const dataRoot = temporaryRoot("secret-rotation-residual");
    const descriptorRoot = temporaryRoot(
      "secret-rotation-residual-descriptors",
    );
    const diagnostics: unknown[] = [];
    const oldKey = privateDescriptor(
      descriptorRoot,
      "old-key.bin",
      Buffer.from(OLD_KEY_MARKER, "utf8"),
    );
    const newKey = privateDescriptor(
      descriptorRoot,
      "new-key.bin",
      Buffer.from(NEW_KEY_MARKER, "utf8"),
    );
    const oldAuthority = privateDescriptor(
      descriptorRoot,
      "old-authority.bin",
      Buffer.alloc(32, 0x71),
    );
    const oldCommitment = privateDescriptor(
      descriptorRoot,
      "old-commitment.bin",
      Buffer.alloc(32, 0x72),
    );
    const newCommitment = privateDescriptor(
      descriptorRoot,
      "new-commitment.bin",
      Buffer.alloc(32, 0x73),
    );
    const secret = privateDescriptor(
      descriptorRoot,
      "secret.txt",
      Buffer.from(PLAINTEXT_MARKER, "utf8"),
    );
    const purgeAuthority = privateDescriptor(
      descriptorRoot,
      "purge-authority.bin",
      Buffer.from(AUTHORITY_KEY_MARKER, "utf8"),
    );
    const wrongPurgeAuthority = privateDescriptor(
      descriptorRoot,
      "wrong-purge-authority.bin",
      Buffer.alloc(32, 0x74),
    );
    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:residual",
      recoveryHeadProvider,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-residual-old-key-001",
      key_id: "key:residual:old",
      key_generation: 1,
      key_descriptor: oldKey,
      authority_key_id: "authority:residual:old",
      authority_descriptor: oldAuthority,
      commitment_key_id: "commitment:residual:old",
      commitment_descriptor: oldCommitment,
    });
    await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-residual-secret-001",
      request_digest: canonicalSha256("admit-residual-secret"),
      principal_id: "principal:residual",
      owner: {
        kind: "memory_revision",
        id: "memory-revision:residual:1",
        generation: 1,
      },
      scope: { kind: "topic", id: "topic:residual" },
      content_identity: "content:residual:1",
      media_type: "text/plain",
      input_descriptor: secret,
    });
    await storage.darkLaunchBeginKeyRotation({
      rotation_id: "rotation:residual:001",
      new_key_id: "key:residual:new",
      new_key_generation: 2,
      new_key_descriptor: newKey,
      new_authority_key_id: "authority:residual:new",
      new_authority_descriptor: purgeAuthority,
      new_commitment_key_id: "commitment:residual:new",
      new_commitment_descriptor: newCommitment,
    });
    await storage.darkLaunchResumeKeyRotation({
      rotation_id: "rotation:residual:001",
      old_key_descriptor: oldKey,
      new_key_descriptor: newKey,
      old_authority_descriptor: oldAuthority,
      new_commitment_descriptor: newCommitment,
    });
    const backupBeforeRestart = await storage.createBackup();
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:residual",
      recoveryHeadProvider,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(await storage.inspectEncryptionKeys()).toMatchObject({
      current_key_id: "key:residual:new",
      encrypted_content_count: 1,
    });
    const backupAfterRestart = await storage.createBackup();
    await expect(
      storage.darkLaunchPurgeSecret({
        idempotency_key: "purge-residual-secret-forged-001",
        principal_id: "principal:residual",
        owner: {
          kind: "memory_revision",
          id: "memory-revision:residual:1",
          generation: 1,
        },
        authority_descriptor: wrongPurgeAuthority,
      }),
    ).rejects.toMatchObject({ code: "KEY_PROVIDER_INVALID" });
    expect(existsSync(backupBeforeRestart.path)).toBe(true);
    expect(existsSync(backupAfterRestart.path)).toBe(true);
    expect(
      (await storage.inspectEncryptionKeys()).encrypted_content_count,
    ).toBe(1);
    const firstPurge = await storage.darkLaunchPurgeSecret({
      idempotency_key: "purge-residual-secret-001",
      principal_id: "principal:residual",
      owner: {
        kind: "memory_revision",
        id: "memory-revision:residual:1",
        generation: 1,
      },
      authority_descriptor: purgeAuthority,
    });
    expect(
      await storage.darkLaunchPurgeSecret({
        idempotency_key: "purge-residual-secret-001",
        principal_id: "principal:residual",
        owner: {
          kind: "memory_revision",
          id: "memory-revision:residual:1",
          generation: 1,
        },
        authority_descriptor: purgeAuthority,
      }),
    ).toEqual(firstPurge);
    expect(await storage.inspectEncryptionKeys()).toMatchObject({
      current_key_id: "key:residual:new",
      encrypted_content_count: 0,
    });
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    const ciphertextCount = database
      .prepare(
        "SELECT count(*) AS count FROM encrypted_contents",
      )
      .get() as { count: number };
    const owner = database
      .prepare(
        `SELECT active, retired_at IS NOT NULL AS retired
         FROM encrypted_content_owners
         WHERE owner_id = 'memory-revision:residual:1'`,
      )
      .get() as { active: number; retired: number };
    const reservations = database
      .prepare(
        `SELECT count(*) AS count
         FROM secret_nonce_reservations
         WHERE owner_id = 'memory-revision:residual:1'
           AND state <> 'retired'`,
      )
      .get() as { count: number };
    const backupCount = database
      .prepare("SELECT count(*) AS count FROM backup_manifests")
      .get() as { count: number };
    const purgeReceiptCount = database
      .prepare(
        `SELECT count(*) AS count FROM operational_receipts
         WHERE operation_kind = 'secret_purge'`,
      )
      .get() as { count: number };
    const receiptJson = database
      .prepare(
        `SELECT group_concat(receipt_json, '')
         AS receipts FROM operational_receipts`,
      )
      .get() as { receipts: string };
    database.close();
    expect(ciphertextCount.count).toBe(0);
    expect(owner).toEqual({ active: 0, retired: 1 });
    expect(reservations.count).toBe(0);
    expect(backupCount.count).toBe(0);
    expect(purgeReceiptCount.count).toBe(1);
    expect(firstPurge).toMatchObject({
      operation: "secret_purge",
      affected_owner_ids: ["memory-revision:residual:1"],
    });
    expect(existsSync(backupBeforeRestart.directory)).toBe(false);
    expect(existsSync(backupAfterRestart.directory)).toBe(false);

    const outputs = JSON.stringify({
      diagnostics,
      receiptJson,
      backupBeforeRestart,
      backupAfterRestart,
    });
    for (const marker of [
      PLAINTEXT_MARKER,
      OLD_KEY_MARKER,
      NEW_KEY_MARKER,
      AUTHORITY_KEY_MARKER,
    ]) {
      expect(outputs).not.toContain(marker);
    }

    const markerBytes = [
      PLAINTEXT_MARKER,
      OLD_KEY_MARKER,
      NEW_KEY_MARKER,
      AUTHORITY_KEY_MARKER,
    ].map((marker) => Buffer.from(marker, "utf8"));
    const persistedPaths = filesUnder(dataRoot);
    expect(persistedPaths).not.toContain(backupBeforeRestart.path);
    expect(persistedPaths).not.toContain(backupAfterRestart.path);
    for (const path of persistedPaths) {
      const bytes = readFileSync(path);
      for (const marker of markerBytes) {
        expect(
          bytes.includes(marker),
          `${path} contains a secret residual marker`,
        ).toBe(false);
      }
    }
  });

  it("replays a completed purge after worker exit without restoring a decryptable artifact", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:purge-response",
    );
    const dataRoot = temporaryRoot("secret-purge-response-loss");
    const descriptorRoot = temporaryRoot(
      "secret-purge-response-loss-descriptors",
    );
    const key = privateDescriptor(
      descriptorRoot,
      "key.bin",
      Buffer.alloc(32, 0x61),
    );
    const authority = privateDescriptor(
      descriptorRoot,
      "authority.bin",
      Buffer.alloc(32, 0x62),
    );
    const commitment = privateDescriptor(
      descriptorRoot,
      "commitment.bin",
      Buffer.alloc(32, 0x63),
    );
    const secret = privateDescriptor(
      descriptorRoot,
      "secret.txt",
      Buffer.alloc(70 * 1024, 0x70),
    );
    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:purge-response",
      recoveryHeadProvider,
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-purge-response-key-001",
      key_id: "key:purge-response:1",
      key_generation: 1,
      key_descriptor: key,
      authority_key_id: "authority:purge-response:1",
      authority_descriptor: authority,
      commitment_key_id: "commitment:purge-response:1",
      commitment_descriptor: commitment,
    });
    await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-purge-response-secret-001",
      request_digest: canonicalSha256("admit-purge-response-secret"),
      principal_id: "principal:purge-response",
      owner: {
        kind: "evidence",
        id: "evidence:purge-response:1",
        generation: 1,
      },
      scope: { kind: "workspace", id: "workspace:purge-response" },
      content_identity: "content:purge-response:1",
      media_type: "text/plain",
      input_descriptor: secret,
    });
    await storage.createBackup();
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:purge-response",
      recoveryHeadProvider,
      testFaults: { exitAfterCommitBeforeResponseOnce: true },
    });
    const input = {
      idempotency_key: "purge-response-loss-001",
      principal_id: "principal:purge-response",
      owner: {
        kind: "evidence" as const,
        id: "evidence:purge-response:1",
        generation: 1,
      },
      authority_descriptor: authority,
    };
    const recovered = await storage.darkLaunchPurgeSecret(input);
    expect(recovered).toMatchObject({
      operation: "secret_purge",
    });
    expect(await storage.darkLaunchPurgeSecret(input)).toEqual(recovered);
    expect(await storage.inspectEncryptionKeys()).toMatchObject({
      encrypted_content_count: 0,
    });
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    expect(
      (
        database
          .prepare("SELECT count(*) AS count FROM encrypted_contents")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(
      (
        database
          .prepare(
            `SELECT count(*) AS count FROM operational_receipts
             WHERE operation_kind = 'secret_purge'`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      database
        .prepare(
          `SELECT state, completed_at IS NOT NULL AS completed
           FROM secret_purge_physical_maintenance`,
        )
        .get(),
    ).toEqual({ state: "completed", completed: 1 });
    expect(
      (
        database
          .prepare(
            `SELECT count(*) AS count
             FROM secret_authority_consumptions
             WHERE authority_kind = 'use'`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    database.close();
    expect(readdirSync(join(dataRoot, "backups"))).toEqual([]);
    expect(
      readdirSync(join(dataRoot, "blobs", "encrypted")),
    ).toEqual([".quarantine"]);
  });
});

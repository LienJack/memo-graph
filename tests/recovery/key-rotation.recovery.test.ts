import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
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

describe("key rotation crash recovery", () => {
  it("resumes item-by-item with one durable use authority per decrypt", async () => {
    const dataRoot = temporaryRoot("rotation-recovery");
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:rotation",
    );
    const descriptorRoot = temporaryRoot("rotation-descriptors");
    const oldKey = privateDescriptor(
      descriptorRoot,
      "old-key.bin",
      Buffer.alloc(32, 0x31),
    );
    const newKey = privateDescriptor(
      descriptorRoot,
      "new-key.bin",
      Buffer.alloc(32, 0x52),
    );
    const oldAuthority = privateDescriptor(
      descriptorRoot,
      "old-authority.bin",
      Buffer.alloc(32, 0x32),
    );
    const oldCommitment = privateDescriptor(
      descriptorRoot,
      "old-commitment.bin",
      Buffer.alloc(32, 0x33),
    );
    const newAuthority = privateDescriptor(
      descriptorRoot,
      "new-authority.bin",
      Buffer.alloc(32, 0x53),
    );
    const newCommitment = privateDescriptor(
      descriptorRoot,
      "new-commitment.bin",
      Buffer.alloc(32, 0x54),
    );
    const secretOne = privateDescriptor(
      descriptorRoot,
      "secret-one.txt",
      Buffer.from("rotation-secret-one-4107", "utf8"),
    );
    const secretTwo = privateDescriptor(
      descriptorRoot,
      "secret-two.txt",
      Buffer.from("rotation-secret-two-4108", "utf8"),
    );

    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:rotation",
      recoveryHeadProvider,
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-rotation-old-key-001",
      key_id: "key:rotation:old",
      key_generation: 1,
      key_descriptor: oldKey,
      authority_key_id: "authority:rotation:old",
      authority_descriptor: oldAuthority,
      commitment_key_id: "commitment:rotation:old",
      commitment_descriptor: oldCommitment,
    });
    for (const [suffix, descriptor] of [
      ["one", secretOne],
      ["two", secretTwo],
    ] as const) {
      await storage.darkLaunchAdmitSecret({
        idempotency_key: `rotation-admit-${suffix}-001`,
        request_digest: canonicalSha256({
          operation: "rotation-admit",
          suffix,
        }),
        principal_id: "principal:rotation",
        owner: {
          kind: "evidence",
          id: `evidence:rotation:${suffix}`,
          generation: 1,
        },
        scope: { kind: "workspace", id: "workspace:rotation" },
        content_identity: `content:rotation:${suffix}`,
        media_type: "text/plain",
        input_descriptor: descriptor,
      });
    }
    const backupBeforeRotation = await storage.createBackup();
    const begun = await storage.darkLaunchBeginKeyRotation({
      rotation_id: "rotation:recovery:001",
      new_key_id: "key:rotation:new",
      new_key_generation: 2,
      new_key_descriptor: newKey,
      new_authority_key_id: "authority:rotation:new",
      new_authority_descriptor: newAuthority,
      new_commitment_key_id: "commitment:rotation:new",
      new_commitment_descriptor: newCommitment,
    });
    expect(begun.progress).toMatchObject({
      state: "in_progress",
      total_items: 2,
      rewritten_items: 0,
    });
    await expect(
      storage.darkLaunchPurgeSecret({
        idempotency_key: "purge-during-rotation-001",
        principal_id: "principal:rotation",
        owner: {
          kind: "evidence",
          id: "evidence:rotation:one",
          generation: 1,
        },
        authority_descriptor: oldAuthority,
      }),
    ).rejects.toMatchObject({ code: "MAINTENANCE_BLOCKED" });
    expect(existsSync(backupBeforeRotation.path)).toBe(true);
    await expect(
      storage.darkLaunchAdmitSecret({
        idempotency_key: "rotation-admit-blocked-001",
        request_digest: canonicalSha256("rotation-admit-blocked"),
        principal_id: "principal:rotation",
        owner: {
          kind: "evidence",
          id: "evidence:rotation:blocked",
          generation: 1,
        },
        scope: { kind: "workspace", id: "workspace:rotation" },
        content_identity: "content:rotation:blocked",
        media_type: "text/plain",
        input_descriptor: secretOne,
      }),
    ).rejects.toMatchObject({ code: "MAINTENANCE_BLOCKED" });

    const partial = await storage.darkLaunchResumeKeyRotation({
      rotation_id: "rotation:recovery:001",
      old_key_descriptor: oldKey,
      new_key_descriptor: newKey,
      old_authority_descriptor: oldAuthority,
      new_commitment_descriptor: newCommitment,
      max_items: 1,
    });
    expect(partial).toMatchObject({
      state: "in_progress",
      total_items: 2,
      rewritten_items: 1,
    });
    await expect(
      storage.darkLaunchAbortKeyRotation("rotation:recovery:001"),
    ).rejects.toMatchObject({ code: "ROTATION_INCOMPLETE" });
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:rotation",
      recoveryHeadProvider,
    });
    const completed = await storage.darkLaunchResumeKeyRotation({
      rotation_id: "rotation:recovery:001",
      old_key_descriptor: oldKey,
      new_key_descriptor: newKey,
      old_authority_descriptor: oldAuthority,
      new_commitment_descriptor: newCommitment,
    });
    expect(completed).toMatchObject({
      state: "completed",
      total_items: 2,
      rewritten_items: 2,
    });
    expect(await storage.inspectEncryptionKeys()).toMatchObject({
      current_key_id: "key:rotation:new",
      rotating_to_key_id: null,
      encrypted_content_count: 2,
      rotation_id: null,
      keys: [
        { key_id: "key:rotation:old", state: "retired" },
        { key_id: "key:rotation:new", state: "current" },
      ],
    });
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    const authorityCount = database
      .prepare(
        `SELECT count(*) AS count
         FROM secret_authority_consumptions
         WHERE authority_kind = 'use'`,
      )
      .get() as { count: number };
    const authorityReceiptCount = database
      .prepare(
        `SELECT count(*) AS count
         FROM operational_receipts
         WHERE operation_kind = 'secret_use_authority'`,
      )
      .get() as { count: number };
    const activeKeys = database
      .prepare(
        `SELECT count(DISTINCT c.key_id) AS count
         FROM encrypted_content_owners AS o
         JOIN encrypted_contents AS c ON c.ciphertext_id = o.ciphertext_id
         WHERE o.active = 1`,
      )
      .get() as { count: number };
    const nonceCount = database
      .prepare(
        `SELECT count(*) AS count,
                count(DISTINCT key_id || ':' || nonce_base64url) AS distinct_count
         FROM secret_nonce_reservations`,
      )
      .get() as { count: number; distinct_count: number };
    database.close();

    expect(authorityCount.count).toBe(2);
    expect(authorityReceiptCount.count).toBe(2);
    expect(activeKeys.count).toBe(1);
    expect(nonceCount.distinct_count).toBe(nonceCount.count);
  });

  it("rejects the wrong provider before changing rotation progress", async () => {
    const dataRoot = temporaryRoot("rotation-provider-rejection");
    const descriptorRoot = temporaryRoot("rotation-wrong-provider");
    const oldKey = privateDescriptor(
      descriptorRoot,
      "old-key.bin",
      Buffer.alloc(32, 0x11),
    );
    const newKey = privateDescriptor(
      descriptorRoot,
      "new-key.bin",
      Buffer.alloc(32, 0x22),
    );
    const wrongKey = privateDescriptor(
      descriptorRoot,
      "wrong-key.bin",
      Buffer.alloc(32, 0x33),
    );
    const wrongAuthority = privateDescriptor(
      descriptorRoot,
      "wrong-authority.bin",
      Buffer.alloc(32, 0x34),
    );
    const oldAuthority = privateDescriptor(
      descriptorRoot,
      "old-authority.bin",
      Buffer.alloc(32, 0x12),
    );
    const oldCommitment = privateDescriptor(
      descriptorRoot,
      "old-commitment.bin",
      Buffer.alloc(32, 0x13),
    );
    const newAuthority = privateDescriptor(
      descriptorRoot,
      "new-authority.bin",
      Buffer.alloc(32, 0x23),
    );
    const newCommitment = privateDescriptor(
      descriptorRoot,
      "new-commitment.bin",
      Buffer.alloc(32, 0x24),
    );
    const secret = privateDescriptor(
      descriptorRoot,
      "secret.txt",
      Buffer.from("rotation-wrong-provider-secret", "utf8"),
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:rotation",
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-rotation-provider-old-001",
      key_id: "key:provider:old",
      key_generation: 1,
      key_descriptor: oldKey,
      authority_key_id: "authority:provider:old",
      authority_descriptor: oldAuthority,
      commitment_key_id: "commitment:provider:old",
      commitment_descriptor: oldCommitment,
    });
    await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-rotation-provider-secret-001",
      request_digest: canonicalSha256("admit-rotation-provider-secret"),
      principal_id: "principal:rotation",
      owner: {
        kind: "evidence",
        id: "evidence:provider:secret",
        generation: 1,
      },
      scope: { kind: "workspace", id: "workspace:rotation" },
      content_identity: "content:provider:secret",
      media_type: "text/plain",
      input_descriptor: secret,
    });
    await storage.darkLaunchBeginKeyRotation({
      rotation_id: "rotation:provider:001",
      new_key_id: "key:provider:new",
      new_key_generation: 2,
      new_key_descriptor: newKey,
      new_authority_key_id: "authority:provider:new",
      new_authority_descriptor: newAuthority,
      new_commitment_key_id: "commitment:provider:new",
      new_commitment_descriptor: newCommitment,
    });

    await expect(
      storage.darkLaunchResumeKeyRotation({
        rotation_id: "rotation:provider:001",
        old_key_descriptor: oldKey,
        new_key_descriptor: wrongKey,
        old_authority_descriptor: oldAuthority,
        new_commitment_descriptor: newCommitment,
      }),
    ).rejects.toMatchObject({ code: "KEY_PROVIDER_INVALID" });
    await expect(
      storage.darkLaunchResumeKeyRotation({
        rotation_id: "rotation:provider:001",
        old_key_descriptor: oldKey,
        new_key_descriptor: newKey,
        old_authority_descriptor: wrongAuthority,
        new_commitment_descriptor: newCommitment,
      }),
    ).rejects.toMatchObject({ code: "KEY_PROVIDER_INVALID" });
    expect(await storage.inspectEncryptionKeys()).toMatchObject({
      current_key_id: "key:provider:old",
      rotating_to_key_id: "key:provider:new",
      rotation_id: "rotation:provider:001",
    });
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    expect(
      (
        database
          .prepare(
            "SELECT rewritten_items FROM key_rotations WHERE rotation_id = ?",
          )
          .get("rotation:provider:001") as { rewritten_items: number }
      ).rewritten_items,
    ).toBe(0);
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
    ).toBe(0);
    database.close();
  });

  it("aborts only before the first rewrite and preserves one current key across restart", async () => {
    const dataRoot = temporaryRoot("rotation-abort");
    const descriptorRoot = temporaryRoot("rotation-abort-descriptors");
    const oldKey = privateDescriptor(
      descriptorRoot,
      "old-key.bin",
      Buffer.alloc(32, 0x41),
    );
    const newKey = privateDescriptor(
      descriptorRoot,
      "new-key.bin",
      Buffer.alloc(32, 0x42),
    );
    const oldAuthority = privateDescriptor(
      descriptorRoot,
      "old-authority.bin",
      Buffer.alloc(32, 0x43),
    );
    const oldCommitment = privateDescriptor(
      descriptorRoot,
      "old-commitment.bin",
      Buffer.alloc(32, 0x44),
    );
    const newAuthority = privateDescriptor(
      descriptorRoot,
      "new-authority.bin",
      Buffer.alloc(32, 0x45),
    );
    const newCommitment = privateDescriptor(
      descriptorRoot,
      "new-commitment.bin",
      Buffer.alloc(32, 0x46),
    );
    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-rotation-abort-old-001",
      key_id: "key:abort:old",
      key_generation: 1,
      key_descriptor: oldKey,
      authority_key_id: "authority:abort:old",
      authority_descriptor: oldAuthority,
      commitment_key_id: "commitment:abort:old",
      commitment_descriptor: oldCommitment,
    });
    await storage.darkLaunchBeginKeyRotation({
      rotation_id: "rotation:abort:001",
      new_key_id: "key:abort:new",
      new_key_generation: 2,
      new_key_descriptor: newKey,
      new_authority_key_id: "authority:abort:new",
      new_authority_descriptor: newAuthority,
      new_commitment_key_id: "commitment:abort:new",
      new_commitment_descriptor: newCommitment,
    });
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    const blocked = await storage.darkLaunchRevokeEncryptionKey({
      idempotency_key: "revoke-rotation-abort-new-001",
      key_id: "key:abort:new",
    });
    expect(blocked.inventory).toMatchObject({
      rotation_id: "rotation:abort:001",
      rotation_state: "blocked",
      rotating_to_key_id: null,
    });
    const aborted = await storage.darkLaunchAbortKeyRotation(
      "rotation:abort:001",
    );
    expect(aborted.progress).toMatchObject({
      state: "aborted",
      rewritten_items: 0,
      total_items: 0,
    });
    expect(await storage.inspectEncryptionKeys()).toMatchObject({
      current_key_id: "key:abort:old",
      rotating_to_key_id: null,
      rotation_id: null,
      keys: [
        { key_id: "key:abort:old", state: "current" },
        { key_id: "key:abort:new", state: "revoked_or_compromised" },
      ],
    });
    await expect(
      storage.darkLaunchResumeKeyRotation({
        rotation_id: "rotation:abort:001",
        old_key_descriptor: oldKey,
        new_key_descriptor: newKey,
        old_authority_descriptor: oldAuthority,
        new_commitment_descriptor: newCommitment,
      }),
    ).rejects.toMatchObject({ code: "ROTATION_INCOMPLETE" });
    await storage.close();
  });

  it("returns the recorded rotation begin after response loss and replays it exactly", async () => {
    const dataRoot = temporaryRoot("rotation-begin-fault");
    const descriptorRoot = temporaryRoot(
      "rotation-begin-fault-descriptors",
    );
    const oldKey = privateDescriptor(
      descriptorRoot,
      "old-key.bin",
      Buffer.alloc(32, 0x51),
    );
    const newKey = privateDescriptor(
      descriptorRoot,
      "new-key.bin",
      Buffer.alloc(32, 0x52),
    );
    const oldAuthority = privateDescriptor(
      descriptorRoot,
      "fault-old-authority.bin",
      Buffer.alloc(32, 0x55),
    );
    const oldCommitment = privateDescriptor(
      descriptorRoot,
      "fault-old-commitment.bin",
      Buffer.alloc(32, 0x56),
    );
    const newAuthority = privateDescriptor(
      descriptorRoot,
      "fault-new-authority.bin",
      Buffer.alloc(32, 0x57),
    );
    const newCommitment = privateDescriptor(
      descriptorRoot,
      "fault-new-commitment.bin",
      Buffer.alloc(32, 0x58),
    );
    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-rotation-fault-old-001",
      key_id: "key:fault:old",
      key_generation: 1,
      key_descriptor: oldKey,
      authority_key_id: "authority:fault:old",
      authority_descriptor: oldAuthority,
      commitment_key_id: "commitment:fault:old",
      commitment_descriptor: oldCommitment,
    });
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      testFaults: { exitAfterCommitBeforeResponseOnce: true },
    });
    const begin = {
      rotation_id: "rotation:fault:001",
      new_key_id: "key:fault:new",
      new_key_generation: 2,
      new_key_descriptor: newKey,
      new_authority_key_id: "authority:fault:new",
      new_authority_descriptor: newAuthority,
      new_commitment_key_id: "commitment:fault:new",
      new_commitment_descriptor: newCommitment,
    };
    const recovered =
      await storage.darkLaunchBeginKeyRotation(begin);
    expect(recovered).toMatchObject({
      progress: {
        rotation_id: "rotation:fault:001",
        state: "in_progress",
      },
    });
    expect(await storage.darkLaunchBeginKeyRotation(begin)).toEqual(
      recovered,
    );
    expect(await storage.inspectEncryptionKeys()).toMatchObject({
      current_key_id: "key:fault:old",
      rotating_to_key_id: "key:fault:new",
      rotation_id: "rotation:fault:001",
    });
    expect(
      (
        await storage.darkLaunchAbortKeyRotation("rotation:fault:001")
      ).progress.state,
    ).toBe("aborted");
    await storage.close();
  });

  it("returns and exactly replays one authority-consuming rotation result after response loss", async () => {
    const dataRoot = temporaryRoot("rotation-authority-response-loss");
    const descriptorRoot = temporaryRoot(
      "rotation-authority-response-loss-descriptors",
    );
    const oldKey = privateDescriptor(
      descriptorRoot,
      "old-key.bin",
      Buffer.alloc(32, 0x81),
    );
    const oldAuthority = privateDescriptor(
      descriptorRoot,
      "old-authority.bin",
      Buffer.alloc(32, 0x82),
    );
    const oldCommitment = privateDescriptor(
      descriptorRoot,
      "old-commitment.bin",
      Buffer.alloc(32, 0x83),
    );
    const newKey = privateDescriptor(
      descriptorRoot,
      "new-key.bin",
      Buffer.alloc(32, 0x84),
    );
    const newAuthority = privateDescriptor(
      descriptorRoot,
      "new-authority.bin",
      Buffer.alloc(32, 0x85),
    );
    const newCommitment = privateDescriptor(
      descriptorRoot,
      "new-commitment.bin",
      Buffer.alloc(32, 0x86),
    );
    const secret = privateDescriptor(
      descriptorRoot,
      "secret.txt",
      Buffer.from("rotation-authority-response-loss", "utf8"),
    );
    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:authority-response-loss",
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-authority-response-old-001",
      key_id: "key:authority-response:old",
      key_generation: 1,
      key_descriptor: oldKey,
      authority_key_id: "authority:authority-response:old",
      authority_descriptor: oldAuthority,
      commitment_key_id: "commitment:authority-response:old",
      commitment_descriptor: oldCommitment,
    });
    await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-authority-response-secret-001",
      request_digest: canonicalSha256("admit-authority-response-secret"),
      principal_id: "principal:authority-response-loss",
      owner: {
        kind: "evidence",
        id: "evidence:authority-response:1",
        generation: 1,
      },
      scope: {
        kind: "workspace",
        id: "workspace:authority-response",
      },
      content_identity: "content:authority-response:1",
      media_type: "text/plain",
      input_descriptor: secret,
    });
    await storage.darkLaunchBeginKeyRotation({
      rotation_id: "rotation:authority-response:001",
      new_key_id: "key:authority-response:new",
      new_key_generation: 2,
      new_key_descriptor: newKey,
      new_authority_key_id: "authority:authority-response:new",
      new_authority_descriptor: newAuthority,
      new_commitment_key_id: "commitment:authority-response:new",
      new_commitment_descriptor: newCommitment,
    });
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:authority-response-loss",
      testFaults: { exitAfterCommitBeforeResponseOnce: true },
    });
    const resume = {
      rotation_id: "rotation:authority-response:001",
      old_key_descriptor: oldKey,
      new_key_descriptor: newKey,
      old_authority_descriptor: oldAuthority,
      new_commitment_descriptor: newCommitment,
    };
    const recovered =
      await storage.darkLaunchResumeKeyRotation(resume);
    expect(recovered).toMatchObject({
      state: "completed",
      rewritten_items: 1,
      total_items: 1,
    });
    expect(
      await storage.darkLaunchResumeKeyRotation(resume),
    ).toEqual(recovered);
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
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
  });

  it("revokes a compromised current key and fails future secret use closed", async () => {
    const dataRoot = temporaryRoot("key-revoke");
    const descriptorRoot = temporaryRoot("key-revoke-descriptors");
    const key = privateDescriptor(
      descriptorRoot,
      "key.bin",
      Buffer.alloc(32, 0x71),
    );
    const secret = privateDescriptor(
      descriptorRoot,
      "secret.txt",
      Buffer.from("revoke-secret-marker", "utf8"),
    );
    const authority = privateDescriptor(
      descriptorRoot,
      "revoke-authority.bin",
      Buffer.alloc(32, 0x72),
    );
    const commitment = privateDescriptor(
      descriptorRoot,
      "revoke-commitment.bin",
      Buffer.alloc(32, 0x73),
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:revoke",
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-revoke-key-001",
      key_id: "key:revoke:1",
      key_generation: 1,
      key_descriptor: key,
      authority_key_id: "authority:revoke:1",
      authority_descriptor: authority,
      commitment_key_id: "commitment:revoke:1",
      commitment_descriptor: commitment,
    });
    await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-before-revoke-001",
      request_digest: canonicalSha256("admit-before-revoke"),
      principal_id: "principal:revoke",
      owner: {
        kind: "evidence",
        id: "evidence:revoke:1",
        generation: 1,
      },
      scope: { kind: "workspace", id: "workspace:revoke" },
      content_identity: "content:revoke:1",
      media_type: "text/plain",
      input_descriptor: secret,
    });
    const revoked = await storage.darkLaunchRevokeEncryptionKey({
      idempotency_key: "revoke-compromised-key-001",
      key_id: "key:revoke:1",
    });
    expect(revoked.inventory).toMatchObject({
      current_key_id: null,
      keys: [
        {
          key_id: "key:revoke:1",
          state: "revoked_or_compromised",
        },
      ],
    });
    await expect(
      storage.darkLaunchAdmitSecret({
        idempotency_key: "admit-after-revoke-001",
        request_digest: canonicalSha256("admit-after-revoke"),
        principal_id: "principal:revoke",
        owner: {
          kind: "evidence",
          id: "evidence:revoke:2",
          generation: 1,
        },
        scope: { kind: "workspace", id: "workspace:revoke" },
        content_identity: "content:revoke:2",
        media_type: "text/plain",
        input_descriptor: secret,
      }),
    ).rejects.toMatchObject({ code: "KEY_UNAVAILABLE" });
    expect((await storage.health()).encryption).toMatchObject({
      current_key_id: null,
      encrypted_content_count: 1,
    });
    await storage.close();
  });

  it.each(["after_prepare", "after_file_commit"] as const)(
    "reconciles an external encrypted artifact after %s process exit",
    async (failurePoint) => {
      const dataRoot = temporaryRoot(`external-${failurePoint}`);
      const descriptorRoot = temporaryRoot(
        `external-${failurePoint}-descriptors`,
      );
      const key = privateDescriptor(
        descriptorRoot,
        "key.bin",
        Buffer.alloc(32, 0x5a),
      );
      const authority = privateDescriptor(
        descriptorRoot,
        "authority.bin",
        Buffer.alloc(32, 0x5b),
      );
      const commitment = privateDescriptor(
        descriptorRoot,
        "commitment.bin",
        Buffer.alloc(32, 0x5c),
      );
      const secretBytes = Buffer.alloc(70_000, 0x63);
      secretBytes.write(
        `external-${failurePoint}-secret`,
        0,
        "utf8",
      );
      const secret = privateDescriptor(
        descriptorRoot,
        "secret.bin",
        secretBytes,
      );
      const install = {
        idempotency_key: "install-external-fault-key-001",
        key_id: "key:external-fault:1",
        key_generation: 1,
        key_descriptor: key,
        authority_key_id: "authority:external-fault:1",
        authority_descriptor: authority,
        commitment_key_id: "commitment:external-fault:1",
        commitment_descriptor: commitment,
      };
      let storage = await SqliteStorageClient.open({
        dataRoot,
        testOperations: true,
        secretPrincipalId: "principal:external-fault",
      });
      await storage.darkLaunchInstallEncryptionKey(install);
      await storage.close();

      storage = await SqliteStorageClient.open({
        dataRoot,
        testOperations: true,
        secretPrincipalId: "principal:external-fault",
        testFaults: { encryptedArtifactExitAt: failurePoint },
      });
      await storage.darkLaunchInstallEncryptionKey(install);
      const admission = {
        idempotency_key: `admit-external-${failurePoint}-001`,
        request_digest: canonicalSha256({
          operation: "external-artifact-fault",
          failurePoint,
        }),
        principal_id: "principal:external-fault",
        owner: {
          kind: "evidence" as const,
          id: `evidence:external-fault:${failurePoint}`,
          generation: 1,
        },
        scope: {
          kind: "workspace" as const,
          id: "workspace:external-fault",
        },
        content_identity: `content:external-fault:${failurePoint}`,
        media_type: "application/octet-stream",
        input_descriptor: secret,
      };
      await expect(
        storage.darkLaunchAdmitSecret(admission),
      ).rejects.toMatchObject({ code: "WORKER_CRASHED" });
      await expect(
        storage.darkLaunchAdmitSecret(admission),
      ).resolves.toMatchObject({ operation: "secret_admit" });
      await storage.close();

      const database = new DatabaseSync(
        join(dataRoot, "ledger", "memory.db"),
        { readOnly: true },
      );
      expect(
        database
          .prepare(
            `SELECT state, temporary_relative_path
             FROM encrypted_artifact_operations`,
          )
          .get(),
      ).toEqual({
        state: "committed",
        temporary_relative_path: null,
      });
      expect(
        (
          database
            .prepare(
              `SELECT count(*) AS count FROM encrypted_contents
               WHERE storage_kind = 'external'`,
            )
            .get() as { count: number }
        ).count,
      ).toBe(1);
      database.close();
      const encryptedDirectory = join(dataRoot, "blobs", "encrypted");
      expect(
        readdirSync(encryptedDirectory).filter(
          (name) => name !== ".quarantine",
        ),
      ).toHaveLength(1);
      expect(
        readdirSync(join(encryptedDirectory, ".quarantine")),
      ).toEqual([]);
    },
  );

  it("retires external ciphertext across rotation and purge without orphan files", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:external-rotation",
    );
    const dataRoot = temporaryRoot("external-rotation-purge");
    const descriptorRoot = temporaryRoot(
      "external-rotation-purge-descriptors",
    );
    const oldKey = privateDescriptor(
      descriptorRoot,
      "old-key.bin",
      Buffer.alloc(32, 0x2a),
    );
    const newKey = privateDescriptor(
      descriptorRoot,
      "new-key.bin",
      Buffer.alloc(32, 0x3b),
    );
    const authority = privateDescriptor(
      descriptorRoot,
      "purge-authority.bin",
      Buffer.alloc(32, 0x4c),
    );
    const oldAuthority = privateDescriptor(
      descriptorRoot,
      "old-authority.bin",
      Buffer.alloc(32, 0x2b),
    );
    const oldCommitment = privateDescriptor(
      descriptorRoot,
      "old-commitment.bin",
      Buffer.alloc(32, 0x2c),
    );
    const newCommitment = privateDescriptor(
      descriptorRoot,
      "new-commitment.bin",
      Buffer.alloc(32, 0x4d),
    );
    const plaintext = Buffer.alloc(70_000, 0x72);
    plaintext.write("external-rotation-purge-marker", 0, "utf8");
    const secret = privateDescriptor(
      descriptorRoot,
      "secret.bin",
      plaintext,
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:external-rotation",
      recoveryHeadProvider,
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-external-rotation-old-001",
      key_id: "key:external-rotation:old",
      key_generation: 1,
      key_descriptor: oldKey,
      authority_key_id: "authority:external-rotation:old",
      authority_descriptor: oldAuthority,
      commitment_key_id: "commitment:external-rotation:old",
      commitment_descriptor: oldCommitment,
    });
    await storage.darkLaunchAdmitSecret({
      idempotency_key: "admit-external-rotation-secret-001",
      request_digest: canonicalSha256("admit-external-rotation-secret"),
      principal_id: "principal:external-rotation",
      owner: {
        kind: "evidence",
        id: "evidence:external-rotation:1",
        generation: 1,
      },
      scope: {
        kind: "workspace",
        id: "workspace:external-rotation",
      },
      content_identity: "content:external-rotation:1",
      media_type: "application/octet-stream",
      input_descriptor: secret,
    });
    await expect(storage.createBackup()).resolves.toMatchObject({
      integrity_check: "ok",
    });
    await storage.darkLaunchBeginKeyRotation({
      rotation_id: "rotation:external:001",
      new_key_id: "key:external-rotation:new",
      new_key_generation: 2,
      new_key_descriptor: newKey,
      new_authority_key_id: "authority:external-rotation:new",
      new_authority_descriptor: authority,
      new_commitment_key_id: "commitment:external-rotation:new",
      new_commitment_descriptor: newCommitment,
    });
    await storage.darkLaunchResumeKeyRotation({
      rotation_id: "rotation:external:001",
      old_key_descriptor: oldKey,
      new_key_descriptor: newKey,
      old_authority_descriptor: oldAuthority,
      new_commitment_descriptor: newCommitment,
    });

    let database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    expect(
      database
        .prepare(
          `SELECT state FROM encrypted_artifact_operations
           ORDER BY created_at`,
        )
        .all(),
    ).toEqual([{ state: "retired" }, { state: "committed" }]);
    database.close();
    const encryptedDirectory = join(dataRoot, "blobs", "encrypted");
    expect(
      readdirSync(encryptedDirectory).filter(
        (name) => name !== ".quarantine",
      ),
    ).toHaveLength(1);

    const purgeReceipt = await storage.darkLaunchPurgeSecret({
      idempotency_key: "purge-external-rotation-secret-001",
      principal_id: "principal:external-rotation",
      owner: {
        kind: "evidence",
        id: "evidence:external-rotation:1",
        generation: 1,
      },
      authority_descriptor: authority,
    });
    expect(purgeReceipt).toMatchObject({
      key_ids: [
        "key:external-rotation:old",
        "key:external-rotation:new",
      ],
    });
    expect(purgeReceipt.ciphertext_ids).toHaveLength(2);
    await storage.close();

    database = new DatabaseSync(
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
      database
        .prepare(
          `SELECT state FROM encrypted_artifact_operations
           ORDER BY created_at`,
        )
        .all(),
    ).toEqual([{ state: "retired" }, { state: "retired" }]);
    database.close();
    expect(
      readdirSync(encryptedDirectory).filter(
        (name) => name !== ".quarantine",
      ),
    ).toEqual([]);
    expect(
      readdirSync(join(encryptedDirectory, ".quarantine")),
    ).toEqual([]);
  });
});

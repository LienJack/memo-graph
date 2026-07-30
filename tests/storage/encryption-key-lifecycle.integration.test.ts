import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
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
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const openDescriptors: number[] = [];
const MARKER = "u2-secret-plaintext-marker-907431";

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

describe("dark-launch encryption and key lifecycle", () => {
  it("admits ciphertext only through private descriptors and replays one nonce", async () => {
    const dataRoot = temporaryRoot("secret-ingress");
    const descriptorRoot = temporaryRoot("secret-descriptors");
    const keyDescriptor = privateDescriptor(
      descriptorRoot,
      "key.bin",
      Buffer.alloc(32, 0x17),
    );
    const authorityDescriptor = privateDescriptor(
      descriptorRoot,
      "authority.bin",
      Buffer.alloc(32, 0x18),
    );
    const commitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "commitment.bin",
      Buffer.alloc(32, 0x19),
    );
    const inputDescriptor = privateDescriptor(
      descriptorRoot,
      "secret.txt",
      Buffer.from(MARKER, "utf8"),
    );
    const changedInputDescriptor = privateDescriptor(
      descriptorRoot,
      "changed-secret.txt",
      Buffer.from(`${MARKER}-changed`, "utf8"),
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:test",
    });
    const installed = await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-dark-launch-key-001",
      key_id: "key:dark-launch:1",
      key_generation: 1,
      key_descriptor: keyDescriptor,
      authority_key_id: "authority:dark-launch:1",
      authority_descriptor: authorityDescriptor,
      commitment_key_id: "commitment:dark-launch:1",
      commitment_descriptor: commitmentDescriptor,
    });
    expect(installed).not.toHaveProperty("key");
    expect(installed).not.toHaveProperty("verification_tag");

    const request = {
      idempotency_key: "admit-dark-launch-secret-001",
      request_digest: canonicalSha256({
        operation: "dark-launch-secret-admit",
        owner_id: "evidence:dark-launch:1",
      }),
      principal_id: "principal:test",
      owner: {
        kind: "evidence" as const,
        id: "evidence:dark-launch:1",
        generation: 1,
      },
      scope: { kind: "workspace" as const, id: "workspace:test" },
      content_identity: "content:dark-launch:1",
      media_type: "text/plain",
      input_descriptor: inputDescriptor,
    };
    await expect(
      storage.darkLaunchAdmitSecret({
        ...request,
        idempotency_key: "admit-dark-launch-secret-wrong-principal",
        principal_id: "principal:other",
      }),
    ).rejects.toMatchObject({ code: "KEY_PROVIDER_INVALID" });
    expect(
      (await storage.inspectEncryptionKeys()).encrypted_content_count,
    ).toBe(0);
    const [first, replay] = await Promise.all([
      storage.darkLaunchAdmitSecret(request),
      storage.darkLaunchAdmitSecret(request),
    ]);
    expect(replay).toEqual(first);
    await expect(
      storage.darkLaunchAdmitSecret({
        ...request,
        input_descriptor: changedInputDescriptor,
      }),
    ).rejects.toMatchObject({ code: "NONCE_REUSE" });
    expect(JSON.stringify(first)).not.toContain(MARKER);

    const inventory = await storage.inspectEncryptionKeys();
    expect(inventory).toMatchObject({
      current_key_id: "key:dark-launch:1",
      rotating_to_key_id: null,
      encrypted_content_count: 1,
    });
    await storage.close();

    const databaseBytes = readFileSync(join(dataRoot, "ledger", "memory.db"));
    expect(databaseBytes.includes(Buffer.from(MARKER, "utf8"))).toBe(false);
    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    expect(
      (
        database
          .prepare(
            "SELECT count(*) AS count FROM secret_nonce_reservations",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        database
          .prepare(
            `SELECT count(*) AS count
             FROM secret_authority_consumptions
             WHERE authority_kind = 'admission'`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    const encrypted = database
      .prepare(
        `SELECT ciphertext, tag_base64url, nonce_base64url, aad_json
         FROM encrypted_contents`,
      )
      .get() as {
      ciphertext: Uint8Array;
      tag_base64url: string;
      nonce_base64url: string;
      aad_json: string;
    };
    database.close();
    expect(Buffer.from(encrypted.ciphertext).toString("utf8")).not.toContain(
      MARKER,
    );
    expect(encrypted.tag_base64url).toHaveLength(22);
    expect(encrypted.nonce_base64url).toHaveLength(16);
    expect(encrypted.aad_json).not.toContain(MARKER);
  });

  it("keeps public secret admission fail-closed after dark launch", async () => {
    const dataRoot = temporaryRoot("secret-public-block");
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    const command = inlineEpisode({});
    await expect(
      storage.commitEpisode({
        ...command,
        evidence: command.evidence.map((evidence) => ({
          ...evidence,
          sensitivity: "secret",
        })),
      }),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    expect((await storage.health()).ledger_epoch).toBe(0);
    await storage.close();
  });

  it("rejects non-private, wrong-sized, and changed idempotent key/input state", async () => {
    const dataRoot = temporaryRoot("secret-input-rejection");
    const descriptorRoot = temporaryRoot("secret-invalid-descriptors");
    const wrongSized = privateDescriptor(
      descriptorRoot,
      "wrong-key.bin",
      Buffer.alloc(31, 0x22),
    );
    const authorityDescriptor = privateDescriptor(
      descriptorRoot,
      "authority.bin",
      Buffer.alloc(32, 0x23),
    );
    const commitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "commitment.bin",
      Buffer.alloc(32, 0x24),
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    await expect(
      storage.darkLaunchInstallEncryptionKey({
        idempotency_key: "install-wrong-sized-key-001",
        key_id: "key:invalid:1",
        key_generation: 1,
        key_descriptor: wrongSized,
        authority_key_id: "authority:invalid:1",
        authority_descriptor: authorityDescriptor,
        commitment_key_id: "commitment:invalid:1",
        commitment_descriptor: commitmentDescriptor,
      }),
    ).rejects.toMatchObject({ code: "KEY_PROVIDER_INVALID" });
    await expect(
      storage.darkLaunchInstallEncryptionKey({
        idempotency_key: "install-reused-provider-key-001",
        key_id: "key:invalid:2",
        key_generation: 2,
        key_descriptor: authorityDescriptor,
        authority_key_id: "authority:invalid:2",
        authority_descriptor: authorityDescriptor,
        commitment_key_id: "commitment:invalid:2",
        commitment_descriptor: commitmentDescriptor,
      }),
    ).rejects.toMatchObject({ code: "KEY_PROVIDER_INVALID" });
    expect((await storage.inspectEncryptionKeys()).keys).toEqual([]);
    await storage.close();
  });

  it("uses the bounded external encrypted-artifact saga above the inline threshold", async () => {
    const dataRoot = temporaryRoot("secret-external");
    const descriptorRoot = temporaryRoot("secret-external-descriptors");
    const keyBytes = Buffer.alloc(32, 0x6a);
    const keyDescriptor = privateDescriptor(
      descriptorRoot,
      "key.bin",
      keyBytes,
    );
    const authorityDescriptor = privateDescriptor(
      descriptorRoot,
      "authority.bin",
      Buffer.alloc(32, 0x6b),
    );
    const commitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "commitment.bin",
      Buffer.alloc(32, 0x6c),
    );
    const plaintext = Buffer.alloc(70_000, 0x78);
    plaintext.write("external-secret-marker-551902", 0, "utf8");
    const inputDescriptor = privateDescriptor(
      descriptorRoot,
      "secret.bin",
      plaintext,
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:external",
    });
    await storage.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-external-key-001",
      key_id: "key:external:1",
      key_generation: 1,
      key_descriptor: keyDescriptor,
      authority_key_id: "authority:external:1",
      authority_descriptor: authorityDescriptor,
      commitment_key_id: "commitment:external:1",
      commitment_descriptor: commitmentDescriptor,
    });
    const input = {
      idempotency_key: "admit-external-secret-001",
      request_digest: canonicalSha256("admit-external-secret"),
      principal_id: "principal:external",
      owner: {
        kind: "evidence" as const,
        id: "evidence:external:1",
        generation: 1,
      },
      scope: { kind: "workspace" as const, id: "workspace:external" },
      content_identity: "content:external:1",
      media_type: "application/octet-stream",
      input_descriptor: inputDescriptor,
    };
    expect(await storage.darkLaunchAdmitSecret(input)).toEqual(
      await storage.darkLaunchAdmitSecret(input),
    );
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    const row = database
      .prepare(
        `SELECT storage_kind, ciphertext, external_relative_path,
                ciphertext_size_bytes
         FROM encrypted_contents`,
      )
      .get() as {
      storage_kind: string;
      ciphertext: Uint8Array | null;
      external_relative_path: string;
      ciphertext_size_bytes: number;
    };
    const operation = database
      .prepare(
        `SELECT state, relative_path, temporary_relative_path
         FROM encrypted_artifact_operations`,
      )
      .get() as {
      state: string;
      relative_path: string;
      temporary_relative_path: string | null;
    };
    database.close();
    expect(row).toMatchObject({
      storage_kind: "external",
      ciphertext: null,
      external_relative_path: operation.relative_path,
      ciphertext_size_bytes: plaintext.byteLength,
    });
    expect(operation).toMatchObject({
      state: "committed",
      temporary_relative_path: null,
    });
    const artifactBytes = readFileSync(
      join(dataRoot, "blobs", operation.relative_path),
    );
    expect(artifactBytes.byteLength).toBe(plaintext.byteLength);
    expect(
      artifactBytes.includes(
        Buffer.from("external-secret-marker-551902", "utf8"),
      ),
    ).toBe(false);
    expect(artifactBytes.includes(keyBytes)).toBe(false);
  });
});

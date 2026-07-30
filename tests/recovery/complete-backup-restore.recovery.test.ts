import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import {
  FileRecoveryHeadProvider,
  ACCEPTED_RECOVERY_DECISIONS,
  ACCEPTED_RECOVERY_DECISION_SOURCES,
  backupDatabaseLogicalHash,
  publishDirectoryNoReplace,
  SqliteStorageClient,
  TargetNameReservation,
  rawFileHash,
  restoreBackupToEmptyDataRoot,
  verifyCompleteBackupBundle,
} from "@memo-graph/storage-sqlite";

import { testRecoveryHeadProvider } from "../helpers/recovery.js";
import {
  blobEpisode,
  inlineEpisode,
} from "../helpers/storage-examples.js";

const cleanup: string[] = [];

function temporaryRoot(label: string): string {
  const path = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-u3-${label}-`)),
  );
  cleanup.push(path);
  return path;
}

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function completeBackup(label: string) {
  const recoveryHeadProvider = testRecoveryHeadProvider(
    `recovery_authority:${label}`,
  );
  const source = temporaryRoot(`${label}-source`);
  const storage = await SqliteStorageClient.open({
    dataRoot: source,
    recoveryHeadProvider,
  });
  await storage.commitEpisode(
    inlineEpisode({
      episodeId: `episode_${label}`,
      evidenceId: `evidence_${label}`,
      idempotencyKey: `commit:${label}:0001`,
      text: "Complete recovery fixture.",
    }),
  );
  const backup = await storage.createBackup();
  await storage.close();
  return { backup, recoveryHeadProvider };
}

describe("complete backup publication", () => {
  it("binds accepted decision hashes to the reviewed raw artifacts", () => {
    for (const decision of ["g3r", "g4a", "g4b", "g5"] as const) {
      expect(
        rawFileHash(
          resolve(ACCEPTED_RECOVERY_DECISION_SOURCES[decision]),
        ),
      ).toBe(ACCEPTED_RECOVERY_DECISIONS[decision].decision_hash);
    }
  });

  it("publishes once and reconciles an exact response-loss retry", async () => {
    const { backup, recoveryHeadProvider } =
      await completeBackup("response_loss");
    const target = join(temporaryRoot("response-parent"), "target");
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: target,
        operationId: "restore:response_loss:001",
        recoveryHeadProvider,
        testFaultAt: "after_publish_before_response",
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(existsSync(target)).toBe(true);

    const replayed = await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: target,
      operationId: "restore:response_loss:001",
      recoveryHeadProvider,
    });
    expect(replayed.publication).toBe("reconciled");
  });

  it("removes staging and leaves target absent on every pre-publish fault", async () => {
    for (const fault of [
      "after_key_verification",
      "after_database_copy",
      "after_artifact_copy",
      "after_staging_open",
      "after_restore_verification",
      "after_marker_fsync",
      "after_staging_close",
      "after_staging_fsync",
      "before_publish",
    ] as const) {
      const { backup, recoveryHeadProvider } =
        await completeBackup(`fault_${fault}`);
      const headBefore = recoveryHeadProvider.readCurrent()?.anchor_hash;
      const parent = temporaryRoot(`fault-parent-${fault}`);
      const target = join(parent, "target");
      await expect(
        restoreBackupToEmptyDataRoot({
          backup,
          dataRoot: target,
          recoveryHeadProvider,
          testFaultAt: fault,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(existsSync(target)).toBe(false);
      expect(
        readdirSync(parent).filter((name) => name.includes(".staging")),
      ).toEqual([]);
      expect(recoveryHeadProvider.readCurrent()?.anchor_hash).toBe(
        headBefore,
      );
    }
  });

  it("leaves a complete target after the no-replace rename and parent fsync", async () => {
    const { backup, recoveryHeadProvider } =
      await completeBackup("parent-fsync");
    const target = join(
      temporaryRoot("parent-fsync-parent"),
      "target",
    );
    const operationId = "restore:parent-fsync:001";
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: target,
        operationId,
        recoveryHeadProvider,
        testFaultAt: "after_publish_parent_fsync",
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(existsSync(target)).toBe(true);
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: target,
        operationId,
        recoveryHeadProvider,
      }),
    ).resolves.toMatchObject({ publication: "reconciled" });
  });

  it("reconciles a post-publish derived-degradation interruption", async () => {
    const { backup, recoveryHeadProvider } =
      await completeBackup("derived-interruption");
    const target = join(
      temporaryRoot("derived-interruption-parent"),
      "target",
    );
    const operationId = "restore:derived-interruption:001";
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: target,
        operationId,
        recoveryHeadProvider,
        testFaultAt: "after_derived_degradation",
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(existsSync(target)).toBe(true);

    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: target,
        operationId,
        recoveryHeadProvider,
      }),
    ).resolves.toMatchObject({ publication: "reconciled" });
    expect(recoveryHeadProvider.unresolvedPending()).toHaveLength(0);
  });

  it("rejects an old valid anchor after the external head advances", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:stale",
    );
    const source = temporaryRoot("stale-source");
    const storage = await SqliteStorageClient.open({
      dataRoot: source,
      recoveryHeadProvider,
    });
    const oldBackup = await storage.createBackup();
    await storage.commitEpisode(inlineEpisode({}));
    await storage.createBackup();
    await storage.close();

    await expect(
      restoreBackupToEmptyDataRoot({
        backup: oldBackup,
        dataRoot: join(temporaryRoot("stale-parent"), "target"),
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "STALE_RECOVERY_HEAD" });
  });

  it("rejects absent, forged, and wrong-authority anchors", async () => {
    const { backup, recoveryHeadProvider } =
      await completeBackup("forged_anchor");
    const parent = temporaryRoot("forged-parent");
    await expect(
      restoreBackupToEmptyDataRoot({
        backup: {
          ...backup,
          recovery_anchor: {
            ...backup.recovery_anchor,
            signature: Buffer.alloc(64).toString("base64url"),
          },
        },
        dataRoot: join(parent, "forged"),
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_AUTHORITY_INVALID" });

    const wrongProvider = testRecoveryHeadProvider(
      "recovery_authority:wrong",
    );
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: join(parent, "wrong"),
        recoveryHeadProvider: wrongProvider,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_AUTHORITY_INVALID" });
    expect(existsSync(join(parent, "forged"))).toBe(false);
    expect(existsSync(join(parent, "wrong"))).toBe(false);
  });

  it("detects logical database tampering, extra files, and symlink ancestors", async () => {
    const { backup, recoveryHeadProvider } =
      await completeBackup("tamper");
    const scratch = join(temporaryRoot("logical-copy"), "memory.db");
    copyFileSync(backup.path, scratch);
    const before = backupDatabaseLogicalHash(scratch);
    const database = new DatabaseSync(scratch);
    database.exec(
      "UPDATE ledger_state SET ledger_epoch = ledger_epoch + 1 WHERE singleton = 1",
    );
    database.close();
    expect(backupDatabaseLogicalHash(scratch)).not.toBe(before);

    const extraPath = join(backup.directory, "unbound-extra");
    writeFileSync(extraPath, "unbound\n", { mode: 0o600 });
    const target = join(temporaryRoot("extra-parent"), "target");
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: target,
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "CORRUPTION" });
    rmSync(extraPath);
    expect(existsSync(target)).toBe(false);

    const canonicalParent = temporaryRoot("canonical-parent");
    const aliasRoot = join(temporaryRoot("alias-parent"), "alias");
    symlinkSync(canonicalParent, aliasRoot);
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: join(aliasRoot, "target"),
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATA_ROOT" });
  });

  it("rejects a manifest that omits a database-owned artifact binding", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:missing-artifact",
    );
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("missing-artifact-source"),
      recoveryHeadProvider,
    });
    await storage.commitEpisode(
      blobEpisode({
        bytes: Buffer.from("bound backup artifact", "utf8"),
        episodeId: "episode_missing_artifact",
        evidenceId: "evidence_missing_artifact",
      }),
    );
    const backup = await storage.createBackup();
    await storage.close();
    const artifact = backup.manifest.artifacts.find(
      ({ kind }) => kind === "blob",
    );
    expect(artifact?.bundle_path).not.toBeNull();
    if (artifact?.bundle_path === null || artifact === undefined) {
      throw new Error("blob backup fixture is incomplete");
    }
    const body = {
      ...backup.manifest,
      artifacts: backup.manifest.artifacts.filter(
        ({ artifact_id }) => artifact_id !== artifact.artifact_id,
      ),
    };
    const stripped = {
      ...body,
      manifest_hash: canonicalSha256Omitting(body, [
        "manifest_hash",
      ]),
    };
    writeFileSync(
      join(backup.directory, "manifest.json"),
      `${canonicalJson(stripped)}\n`,
      { mode: 0o600 },
    );
    rmSync(join(backup.directory, artifact.bundle_path));
    expect(() =>
      verifyCompleteBackupBundle({
        directory: backup.directory,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CORRUPTION" }),
    );
  });

  it("never replaces existing, dangling-symlink, or racing targets", async () => {
    const { backup, recoveryHeadProvider } =
      await completeBackup("target-races");
    const parent = temporaryRoot("target-races-parent");
    const existingTarget = join(parent, "existing");
    mkdirSync(existingTarget, { mode: 0o700 });
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: existingTarget,
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    expect(existsSync(backup.path)).toBe(true);

    const danglingTarget = join(parent, "dangling");
    symlinkSync(join(parent, "missing-target"), danglingTarget);
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: danglingTarget,
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    expect(lstatSync(danglingTarget).isSymbolicLink()).toBe(true);

    const source = join(parent, "racing-source");
    const racingTarget = join(parent, "racing-target");
    mkdirSync(source, { mode: 0o700 });
    const reservation = TargetNameReservation.acquire(racingTarget);
    try {
      mkdirSync(racingTarget, { mode: 0o700 });
      await expect(
        Promise.resolve().then(() => reservation.publish(source)),
      ).rejects.toMatchObject({ code: "TARGET_EXISTS" });
      expect(existsSync(source)).toBe(true);
      expect(existsSync(racingTarget)).toBe(true);
    } finally {
      reservation.release();
    }
  });

  it("fails closed on parent identity drift and an unavailable no-replace helper", () => {
    const parent = temporaryRoot("publish-identity-parent");
    const source = join(parent, "source");
    const target = join(parent, "target");
    mkdirSync(source, { mode: 0o700 });
    const parentStat = lstatSync(parent, { bigint: true });
    expect(() =>
      publishDirectoryNoReplace({
        source,
        target,
        targetParentIdentity: {
          dev: parentStat.dev,
          ino: parentStat.ino + 1n,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code:
          process.platform === "darwin"
            ? "TARGET_EXISTS"
            : "NO_REPLACE_UNSUPPORTED",
      }),
    );
    expect(existsSync(source)).toBe(true);
    expect(existsSync(target)).toBe(false);

    expect(() =>
      publishDirectoryNoReplace({
        source,
        target,
        targetParentIdentity: {
          dev: parentStat.dev,
          ino: parentStat.ino,
        },
        helperPath: join(parent, "missing-helper"),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "NO_REPLACE_UNSUPPORTED" }),
    );
    expect(existsSync(source)).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("blocks journal/head tears and an unresolved provider lock", async () => {
    const keys = generateKeyPairSync("ed25519");
    const providerDirectory = join(temporaryRoot("provider-parent"), "head");
    const provider = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:file",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      create: true,
    });
    const oldHead = readFileSync(join(providerDirectory, "head.json"));
    const source = temporaryRoot("provider-source");
    const storage = await SqliteStorageClient.open({
      dataRoot: source,
      recoveryHeadProvider: provider,
    });
    const backup = await storage.createBackup();
    await storage.close();

    writeFileSync(join(providerDirectory, "head.json"), oldHead, {
      mode: 0o600,
    });
    expect(
      () =>
        new FileRecoveryHeadProvider({
          directory: providerDirectory,
          authorityKeyId: "recovery_authority:file",
          trustRootVersion: 1,
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
        }),
    ).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );

    const terminal = JSON.parse(
      readFileSync(join(providerDirectory, "journal.jsonl"), "utf8")
        .trim()
        .split("\n")
        .at(-1) ?? "",
    ) as { state: unknown };
    writeFileSync(
      join(providerDirectory, "head.json"),
      `${JSON.stringify(terminal.state)}\n`,
      { mode: 0o600 },
    );
    const recovered = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:file",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    expect(recovered.readCurrent()?.anchor_hash).toBe(
      backup.recovery_anchor.anchor_hash,
    );
    const lockPath = join(providerDirectory, ".head.lock");
    writeFileSync(lockPath, "operator reconciliation required\n", {
      mode: 0o600,
    });
    chmodSync(lockPath, 0o600);
    expect(() => recovered.readCurrent()).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
  });

  it("rejects duplicate terminal recovery bindings in authenticated state", async () => {
    const keys = generateKeyPairSync("ed25519");
    const providerDirectory = join(
      temporaryRoot("duplicate-terminal-provider-parent"),
      "head",
    );
    const provider = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:duplicate-terminal",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      create: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("duplicate-terminal-source"),
      recoveryHeadProvider: provider,
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_duplicate_terminal",
        evidenceId: "evidence_duplicate_terminal",
        idempotencyKey: "commit:duplicate-terminal:0001",
      }),
    );
    await storage.close();

    const headPath = join(providerDirectory, "head.json");
    const journalPath = join(providerDirectory, "journal.jsonl");
    const head = JSON.parse(readFileSync(headPath, "utf8")) as {
      pending: unknown[];
      state_hash: string;
    };
    expect(head.pending).toHaveLength(1);
    const duplicateBody = {
      ...head,
      pending: [...head.pending, head.pending[0]],
    };
    const duplicated = {
      ...duplicateBody,
      state_hash: canonicalSha256Omitting(
        duplicateBody,
        ["state_hash"],
      ),
    };
    const journal = readFileSync(journalPath, "utf8");
    writeFileSync(
      journalPath,
      `${journal}${canonicalJson({
        kind: "duplicate_terminal_tamper",
        previous_state_hash: head.state_hash,
        state: duplicated,
        state_hash: duplicated.state_hash,
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      headPath,
      `${canonicalJson(duplicated)}\n`,
      { mode: 0o600 },
    );

    expect(
      () =>
        new FileRecoveryHeadProvider({
          directory: providerDirectory,
          authorityKeyId: "recovery_authority:duplicate-terminal",
          trustRootVersion: 1,
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
        }),
    ).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
  });

  it("rejects provider directories and files with unsafe metadata", () => {
    const keys = generateKeyPairSync("ed25519");
    const providerDirectory = join(
      temporaryRoot("provider-security-parent"),
      "head",
    );
    new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:file-security",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      create: true,
    });
    const providerInput = {
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:file-security",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    expect(statSync(providerDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(providerDirectory, "head.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(
      statSync(join(providerDirectory, "journal.jsonl")).mode & 0o777,
    ).toBe(0o600);

    chmodSync(join(providerDirectory, "head.json"), 0o640);
    expect(() => new FileRecoveryHeadProvider(providerInput)).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
    chmodSync(join(providerDirectory, "head.json"), 0o600);

    chmodSync(providerDirectory, 0o750);
    expect(() => new FileRecoveryHeadProvider(providerInput)).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
    chmodSync(providerDirectory, 0o700);

    const journalPath = join(providerDirectory, "journal.jsonl");
    const journalTarget = join(
      temporaryRoot("provider-security-target"),
      "journal.jsonl",
    );
    writeFileSync(journalTarget, readFileSync(journalPath), { mode: 0o600 });
    unlinkSync(journalPath);
    symlinkSync(journalTarget, journalPath);
    expect(() => new FileRecoveryHeadProvider(providerInput)).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
  });

  it("rejects a mismatched recovery key pair before creating provider state", () => {
    const privateKeys = generateKeyPairSync("ed25519");
    const unrelatedKeys = generateKeyPairSync("ed25519");
    const providerDirectory = join(
      temporaryRoot("provider-keypair-parent"),
      "head",
    );
    expect(
      () =>
        new FileRecoveryHeadProvider({
          directory: providerDirectory,
          authorityKeyId:
            "recovery_authority:mismatched-keypair",
          trustRootVersion: 1,
          privateKey: privateKeys.privateKey,
          publicKey: unrelatedKeys.publicKey,
          create: true,
        }),
    ).toThrowError(
      expect.objectContaining({
        code: "RECOVERY_AUTHORITY_INVALID",
      }),
    );
    expect(existsSync(providerDirectory)).toBe(false);
  });

  it("runs pending, committed-head, and reconciled phases in order", async () => {
    const keys = generateKeyPairSync("ed25519");
    const providerDirectory = join(
      temporaryRoot("phase-provider-parent"),
      "head",
    );
    const recoveryHeadProvider = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:phases",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      create: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("phase-source"),
      recoveryHeadProvider,
    });
    const before = recoveryHeadProvider.readCurrent();

    for (let index = 0; index < 8; index += 1) {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: `episode_recovery_phases_${index}`,
          evidenceId: `evidence_recovery_phases_${index}`,
          idempotencyKey: `commit:recovery-phases:${String(index).padStart(4, "0")}`,
        }),
      );
    }
    await storage.close();

    const journalRecords = readFileSync(
      join(providerDirectory, "journal.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            pending?: { reservation: { state: string } };
            state: {
              pending: Array<{
                reservation: { state: string };
              }>;
            };
          },
      );
    const journalKinds = journalRecords.map(({ kind }) => kind);
    const pendingIndex = journalKinds.lastIndexOf("pending");
    const committedIndex = journalKinds.lastIndexOf("committed");
    const reconciledIndex = journalKinds.lastIndexOf("reconciled");
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(committedIndex).toBeGreaterThan(pendingIndex);
    expect(reconciledIndex).toBeGreaterThan(committedIndex);
    const reconciledRecords = journalRecords.filter(
      ({ kind }) => kind === "reconciled",
    );
    expect(reconciledRecords).toHaveLength(8);
    expect(
      reconciledRecords.every(
        (record) =>
          record.pending?.reservation.state === "reconciled" &&
          record.state.pending.every(
            ({ reservation }) =>
              reservation.state === "reconciled",
          ),
      ),
    ).toBe(true);
    expect(recoveryHeadProvider.unresolvedPending()).toHaveLength(0);
    expect(recoveryHeadProvider.readCurrent()?.payload.generation).toBe(
      (before?.payload.generation ?? 0) + 8,
    );
  });
});

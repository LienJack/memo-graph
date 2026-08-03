import {
  chmodSync,
  cpSync,
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
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalHashSchema,
  RecoveryMinimumsSchema,
  canonicalJson,
  canonicalSha256,
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
  recoveryStateCommitment,
  restoreBackupToEmptyDataRoot,
  verifyCompleteBackupBundle,
  type RecoveryHeadProvider,
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

function writeRecoveryKeys(
  parent: string,
  keys: { privateKey: KeyObject; publicKey: KeyObject },
): { privateKeyPath: string; publicKeyPath: string } {
  const privateKeyPath = join(parent, "recovery-private.pem");
  const publicKeyPath = join(parent, "recovery-public.pem");
  writeFileSync(
    privateKeyPath,
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  writeFileSync(
    publicKeyPath,
    keys.publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o600 },
  );
  return { privateKeyPath, publicKeyPath };
}

function spawnRecoveryLockHolder(input: {
  providerDirectory: string;
  privateKeyPath: string;
  publicKeyPath: string;
  mode:
    | "after_lock_publish"
    | "after_journal_fsync"
    | "after_terminal_record_fsync"
    | "after_terminal_index_fsync";
  pendingId?: string;
}): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import { createPrivateKey, createPublicKey } from "node:crypto";',
        'import { readFileSync } from "node:fs";',
        'import { FileRecoveryHeadProvider } from "@memo-graph/storage-sqlite";',
        "const providerDirectory = process.argv[1];",
        "const privateKeyPath = process.argv[2];",
        "const publicKeyPath = process.argv[3];",
        "const mode = process.argv[4];",
        "const pendingId = process.argv[5];",
        "const block = () => {",
        '  process.stdout.write("locked\\n");',
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
        "};",
        "const provider = new FileRecoveryHeadProvider({",
        "  directory: providerDirectory,",
        '  authorityKeyId: "recovery_authority:crash-lock",',
        "  trustRootVersion: 1,",
        "  privateKey: createPrivateKey(readFileSync(privateKeyPath)),",
        "  publicKey: createPublicKey(readFileSync(publicKeyPath)),",
        "  testHooks:",
        '    mode === "after_lock_publish"',
        "      ? { afterLockPublished: block }",
        '      : mode === "after_journal_fsync"',
        "        ? { afterJournalFsync: block }",
        '        : mode === "after_terminal_record_fsync"',
        "          ? { afterTerminalRecordFsync: block }",
        "          : { afterTerminalIndexFsync: block },",
        "});",
        'if (mode === "after_journal_fsync") {',
        "  const current = provider.readCurrent();",
        '  if (current === null) throw new Error("missing recovery head");',
        "  provider.reserve({",
        '    operation: "canonical",',
        '    idempotency_key: "recovery:crash-after-journal",',
        `    request_hash: "sha256:${"a".repeat(64)}",`,
        "    prior_minimums: current.payload.minimums,",
        "    prior_state_commitment_hash: current.payload.state_commitment_hash,",
        "  });",
        "}",
        'if (mode.startsWith("after_terminal_")) {',
        '  if (!pendingId) throw new Error("missing pending id");',
        "  provider.reconcile(pendingId);",
        "}",
      ].join("\n"),
      input.providerDirectory,
      input.privateKeyPath,
      input.publicKeyPath,
      input.mode,
      input.pendingId ?? "",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

function commitProviderEffect(
  provider: RecoveryHeadProvider,
  input: {
    idempotencyKey: string;
    requestHash: ReturnType<typeof CanonicalHashSchema.parse>;
  },
) {
  const current = provider.readCurrent();
  if (current === null) {
    throw new Error("missing recovery head");
  }
  const authorization = provider.reserve({
    operation: "canonical",
    idempotency_key: input.idempotencyKey,
    request_hash: input.requestHash,
    prior_minimums: current.payload.minimums,
    prior_state_commitment_hash:
      current.payload.state_commitment_hash,
  });
  provider.commit({
    pending_id: authorization.reservation.pending_id,
    backup_manifest_hash: null,
    state_commitment_hash: current.payload.state_commitment_hash,
    root_id: current.payload.root_id,
    principal_id: current.payload.principal_id,
    committed_minimums: current.payload.minimums,
  });
  return { authorization, current };
}

function bootstrapProvider(provider: RecoveryHeadProvider): void {
  const zeroHash = CanonicalHashSchema.parse(
    canonicalSha256({ recovery_fixture: "zero" }),
  );
  const minimums = RecoveryMinimumsSchema.parse({
    ledger_epoch: 0,
    latest_receipt_hash: null,
    tombstone_epoch: 0,
    purge_frontier_hash: zeroHash,
    projection_frontier_hash: zeroHash,
    context_frontier_hash: zeroHash,
    learning_control_epoch: 0,
    learning_release_revision: 0,
    learning_frontier_hash: zeroHash,
    required_keys: [],
    encryption_frontier_hash: zeroHash,
    key_live_ciphertexts: [],
    g6_release_control_hash: null,
  });
  const rootId = "root_recovery_fixture";
  const principalId = "principal_recovery_fixture";
  provider.bootstrap({
    root_id: rootId,
    principal_id: principalId,
    minimums,
    state_commitment_hash: recoveryStateCommitment({
      root_id: rootId,
      principal_id: principalId,
      minimums,
    }),
  });
}

async function waitForLockHolder(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(child.stdout, "data").then(([chunk]) => {
        expect(String(chunk)).toContain("locked");
      }),
      once(child, "exit").then(([code, signal]) => {
        throw new Error(
          `recovery lock holder exited before readiness (${String(code)}:${String(signal)})`,
        );
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("recovery lock holder timed out")),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function killLockHolder(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
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

  it("rejects rollback of an internally valid provider behind the SQLite checkpoint", async () => {
    const root = temporaryRoot("provider-rollback");
    const dataRoot = join(root, "data");
    const providerDirectory = join(root, "provider");
    const providerSnapshot = join(root, "provider-snapshot");
    const keys = generateKeyPairSync("ed25519");
    let provider = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:provider-rollback",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      create: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: provider,
    });
    cpSync(providerDirectory, providerSnapshot, { recursive: true });
    chmodSync(providerSnapshot, 0o700);
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_provider_rollback_advance",
        evidenceId: "evidence_provider_rollback_advance",
        idempotencyKey: "provider-rollback-advance",
      }),
    );
    await storage.close();
    rmSync(providerDirectory, { recursive: true });
    cpSync(providerSnapshot, providerDirectory, { recursive: true });
    for (const directory of [
      providerDirectory,
      join(providerDirectory, "terminal"),
      join(providerDirectory, "terminal", "records"),
      join(providerDirectory, "terminal", "index"),
      join(providerDirectory, "terminal", "sequence"),
    ]) {
      chmodSync(directory, 0o700);
    }
    provider = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:provider-rollback",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });

    await expect(
      SqliteStorageClient.open({
        dataRoot,
        recoveryHeadProvider: provider,
      }),
    ).rejects.toMatchObject({ code: "STALE_RECOVERY_HEAD" });
  });

  it("rejects rolled-back provider state when a newer immutable sequence witness remains", async () => {
    const root = temporaryRoot("provider-state-rollback");
    const dataRoot = join(root, "data");
    const providerDirectory = join(root, "provider");
    const oldHead = join(root, "old-head.json");
    const oldJournal = join(root, "old-journal.jsonl");
    const keys = generateKeyPairSync("ed25519");
    const providerInput = {
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:state-rollback",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    const provider = new FileRecoveryHeadProvider({
      ...providerInput,
      create: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: provider,
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_provider_state_rollback_1",
        evidenceId: "evidence_provider_state_rollback_1",
        idempotencyKey: "provider-state-rollback-advance-1",
      }),
    );
    copyFileSync(join(providerDirectory, "head.json"), oldHead);
    copyFileSync(join(providerDirectory, "journal.jsonl"), oldJournal);
    for (const sequence of [2, 3]) {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: `episode_provider_state_rollback_${sequence}`,
          evidenceId: `evidence_provider_state_rollback_${sequence}`,
          idempotencyKey: `provider-state-rollback-advance-${sequence}`,
        }),
      );
    }
    await storage.close();
    const sequenceDirectory = join(
      providerDirectory,
      "terminal",
      "sequence",
    );
    for (const entry of readdirSync(sequenceDirectory)) {
      unlinkSync(join(sequenceDirectory, entry));
    }
    expect(readdirSync(sequenceDirectory)).toHaveLength(0);
    expect(() => new FileRecoveryHeadProvider(providerInput)).not.toThrow();
    expect(readdirSync(sequenceDirectory)).toHaveLength(1);

    copyFileSync(oldHead, join(providerDirectory, "head.json"));
    copyFileSync(oldJournal, join(providerDirectory, "journal.jsonl"));
    expect(
      () => new FileRecoveryHeadProvider(providerInput),
    ).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
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

  it("recovers only an exact dead-process target reservation", () => {
    const parent = temporaryRoot("stale-target-reservation");
    const target = join(parent, "reserved-target");
    const alias = canonicalSha256({
      target_name: "reserved-target",
    }).slice("sha256:".length, "sha256:".length + 32);
    const reservationPath = join(
      parent,
      `.memo-restore-${alias}.reservation`,
    );
    writeFileSync(
      reservationPath,
      `${canonicalJson({
        schema_version: "1.0.0",
        reservation_id: alias,
        operation_id: "restore:stale-reservation",
        process_id: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      TargetNameReservation.acquire(
        target,
        "restore:wrong-reservation",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "TARGET_EXISTS" }),
    );
    const recovered = TargetNameReservation.acquire(
      target,
      "restore:stale-reservation",
    );
    recovered.release();
    expect(existsSync(reservationPath)).toBe(false);
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
          uid: parentStat.uid,
          mode: parentStat.mode,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: process.platform === "darwin"
          ? "INVALID_DATA_ROOT"
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
          uid: parentStat.uid,
          mode: parentStat.mode,
        },
        helperPath: join(parent, "missing-helper"),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "NO_REPLACE_UNSUPPORTED" }),
    );
    expect(existsSync(source)).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("repairs a journal-ahead head tear and blocks an unresolved lock", async () => {
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
    const repairedHead = JSON.parse(
      readFileSync(join(providerDirectory, "head.json"), "utf8"),
    ) as { current: { anchor_hash: string } };
    expect(repairedHead.current.anchor_hash).toBe(
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

  it("recovers a signed recovery-head lock only after its owner is proven dead", async () => {
    const keys = generateKeyPairSync("ed25519");
    const parent = temporaryRoot("crash-lock-provider-parent");
    const providerDirectory = join(parent, "head");
    const providerInput = {
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:crash-lock",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    const provider = new FileRecoveryHeadProvider({
      ...providerInput,
      create: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("crash-lock-source"),
      recoveryHeadProvider: provider,
    });
    const expectedAnchor = provider.readCurrent();
    await storage.close();
    const keyPaths = writeRecoveryKeys(parent, keys);

    for (const mode of [
      "after_lock_publish",
      "after_journal_fsync",
    ] as const) {
      const child = spawnRecoveryLockHolder({
        providerDirectory,
        ...keyPaths,
        mode,
      });
      try {
        await waitForLockHolder(child);
        const lock = JSON.parse(
          readFileSync(join(providerDirectory, ".head.lock"), "utf8"),
        ) as { payload?: { process_id?: unknown } };
        expect(lock.payload?.process_id).toBe(child.pid);
        expect(
          () => new FileRecoveryHeadProvider(providerInput),
        ).toThrowError(
          expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
        );
      } finally {
        await killLockHolder(child);
      }

      const recovered = new FileRecoveryHeadProvider(providerInput);
      expect(recovered.readCurrent()?.anchor_hash).toBe(
        expectedAnchor?.anchor_hash,
      );
      if (mode === "after_journal_fsync") {
        const [pending] = recovered.unresolvedPending();
        expect(pending).toMatchObject({
          idempotency_key: "recovery:crash-after-journal",
          state: "pending",
        });
        recovered.abort({
          pending_id: pending?.pending_id ?? "missing",
          effect_provably_absent: true,
        });
      }
      expect(existsSync(join(providerDirectory, ".head.lock"))).toBe(false);
    }
  });

  it("recovers terminal replay identity across both durable crash windows", async () => {
    const keys = generateKeyPairSync("ed25519");
    const parent = temporaryRoot("terminal-crash-provider-parent");
    const providerDirectory = join(parent, "head");
    const providerInput = {
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:crash-lock",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    let provider = new FileRecoveryHeadProvider({
      ...providerInput,
      create: true,
    });
    bootstrapProvider(provider);
    const keyPaths = writeRecoveryKeys(parent, keys);

    for (const [index, mode] of (
      [
        "after_terminal_record_fsync",
        "after_terminal_index_fsync",
      ] as const
    ).entries()) {
      const idempotencyKey = `recovery:terminal-crash:${index}`;
      const requestHash = CanonicalHashSchema.parse(
        canonicalSha256({ terminal_crash: index }),
      );
      const { authorization } = commitProviderEffect(provider, {
        idempotencyKey,
        requestHash,
      });
      const child = spawnRecoveryLockHolder({
        providerDirectory,
        ...keyPaths,
        mode,
        pendingId: authorization.reservation.pending_id,
      });
      try {
        await waitForLockHolder(child);
        expect(
          () => new FileRecoveryHeadProvider(providerInput),
        ).toThrowError(
          expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
        );
      } finally {
        await killLockHolder(child);
      }

      provider = new FileRecoveryHeadProvider(providerInput);
      const current = provider.readCurrent();
      expect(provider.unresolvedPending()).toHaveLength(0);
      if (current === null) {
        throw new Error("missing recovered head");
      }
      const replay = provider.reserve({
        operation: "canonical",
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        prior_minimums: current.payload.minimums,
        prior_state_commitment_hash:
          current.payload.state_commitment_hash,
      });
      expect(replay.reservation).toMatchObject({
        pending_id: authorization.reservation.pending_id,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        state: "reconciled",
      });
    }

    expect(
      readdirSync(join(providerDirectory, "terminal", "records")),
    ).toHaveLength(2);
    expect(
      readdirSync(join(providerDirectory, "terminal", "index")),
    ).toHaveLength(2);
  });

  it("rejects forged or unsafe recovery-head lock metadata", async () => {
    const keys = generateKeyPairSync("ed25519");
    const parent = temporaryRoot("unsafe-lock-provider-parent");
    const providerDirectory = join(parent, "head");
    const providerInput = {
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:crash-lock",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    new FileRecoveryHeadProvider({ ...providerInput, create: true });
    writeFileSync(
      join(providerDirectory, ".head-lock-interrupted.tmp"),
      '{"partial":',
      { mode: 0o600 },
    );
    expect(() => new FileRecoveryHeadProvider(providerInput)).not.toThrow();

    const keyPaths = writeRecoveryKeys(parent, keys);
    const child = spawnRecoveryLockHolder({
      providerDirectory,
      ...keyPaths,
      mode: "after_lock_publish",
    });
    const lockPath = join(providerDirectory, ".head.lock");
    const signedLock = await (async () => {
      try {
        await waitForLockHolder(child);
        return readFileSync(lockPath, "utf8");
      } finally {
        await killLockHolder(child);
      }
    })();

    chmodSync(lockPath, 0o640);
    expect(() => new FileRecoveryHeadProvider(providerInput)).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
    chmodSync(lockPath, 0o600);

    const forged = JSON.parse(signedLock) as {
      payload: { process_id: number };
    };
    forged.payload.process_id = 2_147_483_647;
    writeFileSync(lockPath, `${canonicalJson(forged)}\n`, { mode: 0o600 });
    expect(() => new FileRecoveryHeadProvider(providerInput)).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );

    const symlinkTarget = join(parent, "signed-lock-copy.json");
    writeFileSync(symlinkTarget, signedLock, { mode: 0o600 });
    unlinkSync(lockPath);
    symlinkSync(symlinkTarget, lockPath);
    expect(() => new FileRecoveryHeadProvider(providerInput)).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
  });

  it("rejects duplicate active recovery bindings in authenticated state", async () => {
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
    bootstrapProvider(provider);
    const current = provider.readCurrent();
    if (current === null) {
      throw new Error("missing recovery head");
    }
    provider.reserve({
      operation: "canonical",
      idempotency_key: "commit:duplicate-active:0001",
      request_hash: CanonicalHashSchema.parse(
        canonicalSha256({ duplicate: "active" }),
      ),
      prior_minimums: current.payload.minimums,
      prior_state_commitment_hash:
        current.payload.state_commitment_hash,
    });

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

  it("fails closed on terminal replay tampering and unsafe terminal metadata", async () => {
    const keys = generateKeyPairSync("ed25519");
    const providerDirectory = join(
      temporaryRoot("terminal-security-parent"),
      "head",
    );
    const providerInput = {
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:terminal-security",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    const provider = new FileRecoveryHeadProvider({
      ...providerInput,
      create: true,
    });
    bootstrapProvider(provider);
    const idempotencyKey = "recovery:terminal-security:0001";
    const requestHash = CanonicalHashSchema.parse(
      canonicalSha256({ terminal_security: true }),
    );
    const { authorization } = commitProviderEffect(provider, {
      idempotencyKey,
      requestHash,
    });
    provider.reconcile(authorization.reservation.pending_id);

    const terminalDirectory = join(providerDirectory, "terminal");
    const recordsDirectory = join(terminalDirectory, "records");
    const indexDirectory = join(terminalDirectory, "index");
    const recordPath = join(
      recordsDirectory,
      readdirSync(recordsDirectory)[0] ?? "missing",
    );
    const indexPath = join(
      indexDirectory,
      readdirSync(indexDirectory)[0] ?? "missing",
    );
    for (const directory of [
      terminalDirectory,
      recordsDirectory,
      indexDirectory,
    ]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(statSync(indexPath).mode & 0o777).toBe(0o600);

    const recordRaw = readFileSync(recordPath, "utf8");
    const record = JSON.parse(recordRaw) as {
      payload: {
        pending: { reservation: { request_hash: string } };
      };
    };
    record.payload.pending.reservation.request_hash =
      `sha256:${"f".repeat(64)}`;
    writeFileSync(recordPath, `${canonicalJson(record)}\n`, { mode: 0o600 });
    expect(
      () => new FileRecoveryHeadProvider(providerInput).readCurrent(),
    ).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
    writeFileSync(recordPath, recordRaw, { mode: 0o600 });

    const reopened = new FileRecoveryHeadProvider(providerInput);
    const indexRaw = readFileSync(indexPath, "utf8");
    const indexRecord = JSON.parse(indexRaw) as {
      payload: { record_hash: string };
    };
    indexRecord.payload.record_hash = `sha256:${"e".repeat(64)}`;
    writeFileSync(indexPath, `${canonicalJson(indexRecord)}\n`, {
      mode: 0o600,
    });
    const current = reopened.readCurrent();
    if (current === null) {
      throw new Error("missing recovery head");
    }
    expect(() =>
      reopened.reserve({
        operation: "canonical",
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        prior_minimums: current.payload.minimums,
        prior_state_commitment_hash:
          current.payload.state_commitment_hash,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );

    writeFileSync(indexPath, indexRaw, { mode: 0o600 });
    unlinkSync(indexPath);
    symlinkSync(join(indexDirectory, "missing.json"), indexPath);
    expect(() =>
      reopened.reserve({
        operation: "canonical",
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        prior_minimums: current.payload.minimums,
        prior_state_commitment_hash:
          current.payload.state_commitment_hash,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );

    unlinkSync(indexPath);
    writeFileSync(indexPath, indexRaw, { mode: 0o600 });
    const headPath = join(providerDirectory, "head.json");
    const journalPath = join(providerDirectory, "journal.jsonl");
    const head = JSON.parse(readFileSync(headPath, "utf8")) as {
      state_hash: string;
      terminal_frontier: {
        record_count: number;
        head_record_hash: string;
      };
    };
    const tamperedHeadBody = {
      ...head,
      terminal_frontier: {
        ...head.terminal_frontier,
        head_record_hash: `sha256:${"d".repeat(64)}`,
      },
    };
    const tamperedHead = {
      ...tamperedHeadBody,
      state_hash: canonicalSha256Omitting(tamperedHeadBody, [
        "state_hash",
      ]),
    };
    writeFileSync(
      journalPath,
      `${readFileSync(journalPath, "utf8")}${canonicalJson({
        kind: "terminal_frontier_tamper",
        previous_state_hash: head.state_hash,
        state: tamperedHead,
        state_hash: tamperedHead.state_hash,
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(headPath, `${canonicalJson(tamperedHead)}\n`, {
      mode: 0o600,
    });
    expect(
      () => new FileRecoveryHeadProvider(providerInput).readCurrent(),
    ).toThrowError(
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
              reservation.state === "pending" ||
              reservation.state === "committed",
          ),
      ),
    ).toBe(true);
    expect(recoveryHeadProvider.unresolvedPending()).toHaveLength(0);
    expect(recoveryHeadProvider.readCurrent()?.payload.generation).toBe(
      (before?.payload.generation ?? 0) + 8,
    );
  });

  it("keeps file-provider active state bounded while retaining exact replay", async () => {
    const keys = generateKeyPairSync("ed25519");
    const providerDirectory = join(
      temporaryRoot("bounded-terminal-provider-parent"),
      "head",
    );
    const providerInput = {
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:bounded-terminal",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    const provider = new FileRecoveryHeadProvider({
      ...providerInput,
      create: true,
    });
    bootstrapProvider(provider);
    const operationCount = 64;
    let first:
      | {
          idempotencyKey: string;
          requestHash: ReturnType<typeof CanonicalHashSchema.parse>;
          pendingId: string;
        }
      | undefined;
    let oneOperationHeadBytes = 0;
    for (let index = 0; index < operationCount; index += 1) {
      const idempotencyKey = `recovery:bounded-terminal:${String(index).padStart(4, "0")}`;
      const requestHash = CanonicalHashSchema.parse(
        canonicalSha256({ bounded_terminal: index }),
      );
      const { authorization } = commitProviderEffect(provider, {
        idempotencyKey,
        requestHash,
      });
      provider.reconcile(authorization.reservation.pending_id);
      if (index === 0) {
        first = {
          idempotencyKey,
          requestHash,
          pendingId: authorization.reservation.pending_id,
        };
        oneOperationHeadBytes = statSync(
          join(providerDirectory, "head.json"),
        ).size;
      }
    }

    const headPath = join(providerDirectory, "head.json");
    const headRaw = readFileSync(headPath, "utf8");
    const head = JSON.parse(headRaw) as {
      pending: unknown[];
      terminal_frontier: {
        record_count: number;
        head_record_hash: string;
      };
    };
    expect(head.pending).toEqual([]);
    expect(head.terminal_frontier.record_count).toBe(operationCount);
    expect(head.terminal_frontier.head_record_hash).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(Buffer.byteLength(headRaw) - oneOperationHeadBytes).toBeLessThan(
      256,
    );
    expect(
      readdirSync(join(providerDirectory, "terminal", "records")),
    ).toHaveLength(operationCount);
    expect(
      readdirSync(join(providerDirectory, "terminal", "index")),
    ).toHaveLength(operationCount);

    const terminalReads: Array<"index" | "record"> = [];
    const reopened = new FileRecoveryHeadProvider({
      ...providerInput,
      testHooks: {
        onTerminalRead: (kind) => terminalReads.push(kind),
      },
    });
    expect(reopened.unresolvedPending()).toHaveLength(0);
    const current = reopened.readCurrent();
    if (current === null || first === undefined) {
      throw new Error("missing replay fixture");
    }
    terminalReads.length = 0;
    const replay = reopened.reserve({
      operation: "canonical",
      idempotency_key: first.idempotencyKey,
      request_hash: first.requestHash,
      prior_minimums: current.payload.minimums,
      prior_state_commitment_hash:
        current.payload.state_commitment_hash,
    });
    expect(replay.reservation).toMatchObject({
      pending_id: first.pendingId,
      state: "reconciled",
    });
    expect(terminalReads).toEqual(["record", "index", "record"]);
    expect(() =>
      reopened.reserve({
        operation: "canonical",
        idempotency_key: first.idempotencyKey,
        request_hash: CanonicalHashSchema.parse(
          canonicalSha256({ changed_request: true }),
        ),
        prior_minimums: current.payload.minimums,
        prior_state_commitment_hash:
          current.payload.state_commitment_hash,
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  }, 30_000);

  it("rejects oversized provider state and journal files before reading them", () => {
    const keys = generateKeyPairSync("ed25519");
    const providerDirectory = join(
      temporaryRoot("bounded-provider-files-parent"),
      "head",
    );
    const providerInput = {
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:bounded-provider-files",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    };
    new FileRecoveryHeadProvider({
      ...providerInput,
      create: true,
    });
    const headPath = join(providerDirectory, "head.json");
    const journalPath = join(providerDirectory, "journal.jsonl");
    const headRaw = readFileSync(headPath);
    const journalRaw = readFileSync(journalPath);

    truncateSync(headPath, 1_048_577);
    expect(() => new FileRecoveryHeadProvider(providerInput)).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
    writeFileSync(headPath, headRaw, { mode: 0o600 });

    truncateSync(journalPath, 100_000_000);
    expect(() => new FileRecoveryHeadProvider(providerInput)).toThrowError(
      expect.objectContaining({ code: "RECOVERY_AUTHORITY_INVALID" }),
    );
    writeFileSync(journalPath, journalRaw, { mode: 0o600 });
    expect(() => new FileRecoveryHeadProvider(providerInput)).not.toThrow();
  });

  it("gives the memory provider equivalent bounded replay behavior", async () => {
    const provider = testRecoveryHeadProvider(
      "recovery_authority:bounded-memory",
    );
    bootstrapProvider(provider);
    const before = provider.readCurrent();
    const operationCount = 256;
    let first:
      | {
          idempotencyKey: string;
          requestHash: ReturnType<typeof CanonicalHashSchema.parse>;
          pendingId: string;
        }
      | undefined;
    for (let index = 0; index < operationCount; index += 1) {
      const idempotencyKey = `recovery:bounded-memory:${String(index).padStart(4, "0")}`;
      const requestHash = CanonicalHashSchema.parse(
        canonicalSha256({ bounded_memory: index }),
      );
      const { authorization } = commitProviderEffect(provider, {
        idempotencyKey,
        requestHash,
      });
      provider.reconcile(authorization.reservation.pending_id);
      first ??= {
        idempotencyKey,
        requestHash,
        pendingId: authorization.reservation.pending_id,
      };
      expect(provider.unresolvedPending()).toHaveLength(0);
    }
    expect(provider.readCurrent()?.payload.generation).toBe(
      (before?.payload.generation ?? 0) + operationCount,
    );
    const current = provider.readCurrent();
    if (current === null || first === undefined) {
      throw new Error("missing memory replay fixture");
    }
    expect(
      provider.reserve({
        operation: "canonical",
        idempotency_key: first.idempotencyKey,
        request_hash: first.requestHash,
        prior_minimums: current.payload.minimums,
        prior_state_commitment_hash:
          current.payload.state_commitment_hash,
      }).reservation,
    ).toMatchObject({
      pending_id: first.pendingId,
      state: "reconciled",
    });
  });

  it("caps active recovery reservations without blocking an exact retry", () => {
    const provider = testRecoveryHeadProvider(
      "recovery_authority:active-capacity",
    );
    bootstrapProvider(provider);
    const current = provider.readCurrent();
    if (current === null) {
      throw new Error("missing recovery head");
    }
    let first:
      | {
          idempotencyKey: string;
          requestHash: ReturnType<typeof CanonicalHashSchema.parse>;
          pendingId: string;
        }
      | undefined;
    for (let index = 0; index < 64; index += 1) {
      const idempotencyKey = `recovery:active-capacity:${String(index).padStart(4, "0")}`;
      const requestHash = CanonicalHashSchema.parse(
        canonicalSha256({ active_capacity: index }),
      );
      const authorization = provider.reserve({
        operation: "canonical",
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        prior_minimums: current.payload.minimums,
        prior_state_commitment_hash:
          current.payload.state_commitment_hash,
      });
      first ??= {
        idempotencyKey,
        requestHash,
        pendingId: authorization.reservation.pending_id,
      };
    }
    expect(provider.unresolvedPending()).toHaveLength(64);
    expect(() =>
      provider.reserve({
        operation: "canonical",
        idempotency_key: "recovery:active-capacity:overflow",
        request_hash: CanonicalHashSchema.parse(
          canonicalSha256({ active_capacity: "overflow" }),
        ),
        prior_minimums: current.payload.minimums,
        prior_state_commitment_hash:
          current.payload.state_commitment_hash,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "STORAGE_UNAVAILABLE",
        retryable: true,
      }),
    );
    if (first === undefined) {
      throw new Error("missing active retry fixture");
    }
    expect(
      provider.reserve({
        operation: "canonical",
        idempotency_key: first.idempotencyKey,
        request_hash: first.requestHash,
        prior_minimums: current.payload.minimums,
        prior_state_commitment_hash:
          current.payload.state_commitment_hash,
      }).reservation.pending_id,
    ).toBe(first.pendingId);
  });

  it("compacts the authenticated journal to a bounded snapshot", async () => {
    const keys = generateKeyPairSync("ed25519");
    const providerDirectory = join(
      temporaryRoot("bounded-provider-parent"),
      "head",
    );
    const recoveryHeadProvider = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:bounded",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      create: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("bounded-provider-source"),
      recoveryHeadProvider,
    });
    const generationBefore =
      recoveryHeadProvider.readCurrent()?.payload.generation ?? 0;
    for (let index = 0; index < 24; index += 1) {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: `episode_bounded_journal_${index}`,
          evidenceId: `evidence_bounded_journal_${index}`,
          idempotencyKey: `commit:bounded-journal:${String(index).padStart(4, "0")}`,
        }),
      );
    }
    await storage.close();

    const records = readFileSync(
      join(providerDirectory, "journal.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            previous_state_hash: string | null;
          },
      );
    expect(records.length).toBeLessThanOrEqual(64);
    expect(records.some(({ kind }) => kind === "snapshot")).toBe(true);
    expect(records[0]?.previous_state_hash).toBeNull();
    const reopened = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:bounded",
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    expect(reopened.unresolvedPending()).toHaveLength(0);
    expect(reopened.readCurrent()?.payload.generation).toBe(
      generationBefore + 24,
    );
  });
});

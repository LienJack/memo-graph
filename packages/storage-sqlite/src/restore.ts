import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import { SqliteStorageClient } from "./client.js";
import { prepareDataRoot } from "./data-root.js";
import { StorageError } from "./errors.js";
import {
  BackupResultSchema,
  type BackupResult,
  type StorageHealth,
} from "./protocol.js";

export type RestoreBackupOptions = {
  backup: BackupResult;
  dataRoot: string;
  migrationsDir?: string;
};

export type RestoreBackupResult = {
  data_root: string;
  health: StorageHealth;
  verified_blobs: number;
};

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function restoreBackupToEmptyDataRoot(
  options: RestoreBackupOptions,
): Promise<RestoreBackupResult> {
  const backup = BackupResultSchema.parse(options.backup);
  const target = resolve(options.dataRoot);
  if (
    !isAbsolute(options.dataRoot) ||
    target === parse(target).root ||
    existsSync(target)
  ) {
    throw new StorageError("INVALID_DATA_ROOT");
  }

  const backupDirectory = realpathSync(backup.directory);
  const backupDatabase = realpathSync(backup.path);
  if (
    lstatSync(backupDirectory).isSymbolicLink() ||
    lstatSync(backupDatabase).isSymbolicLink() ||
    dirname(backupDatabase) !== backupDirectory
  ) {
    throw new StorageError("CORRUPTION");
  }

  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.restore-${randomUUID()}`;
  let client: SqliteStorageClient | undefined;
  try {
    const layout = prepareDataRoot(staging);
    copyFileSync(
      backupDatabase,
      layout.database,
      constants.COPYFILE_EXCL,
    );
    chmodSync(layout.database, 0o600);
    fsyncPath(layout.database);

    for (const contentHash of backup.blob_hashes) {
      const filename = contentHash.slice("sha256:".length);
      const source = join(backupDirectory, "blobs", filename);
      if (
        !existsSync(source) ||
        lstatSync(source).isSymbolicLink() ||
        realpathSync(dirname(source)) !==
          realpathSync(join(backupDirectory, "blobs"))
      ) {
        throw new StorageError("CORRUPTION");
      }
      const destination = join(layout.blobs, filename);
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      fsyncPath(destination);
    }
    fsyncPath(layout.blobs);
    fsyncPath(layout.ledger);
    fsyncPath(layout.root);

    client = await SqliteStorageClient.open({
      dataRoot: layout.root,
      ...(options.migrationsDir === undefined
        ? {}
        : { migrationsDir: options.migrationsDir }),
    });
    const health = await client.health();
    const artifacts = await client.verifyArtifacts();
    if (
      health.ledger_epoch !== backup.ledger_epoch ||
      health.tombstone_epoch !== backup.tombstone_epoch ||
      health.latest_receipt_hash !== backup.latest_receipt_hash ||
      artifacts.verified !== backup.blob_hashes.length
    ) {
      throw new StorageError("CORRUPTION");
    }
    await client.close();
    client = undefined;
    renameSync(staging, target);

    return {
      data_root: target,
      health,
      verified_blobs: artifacts.verified,
    };
  } catch (error) {
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
    if (existsSync(staging)) {
      rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

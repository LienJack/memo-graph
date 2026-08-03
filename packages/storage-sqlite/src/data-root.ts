import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  statfsSync,
} from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";

import { StorageError } from "./errors.js";

const NETWORK_FILESYSTEM_TYPES = new Set([
  0x6969, // NFS
  0x517b, // SMB (Darwin)
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x5346414f, // AFS
  0x73757245, // CODA
  0x01021997, // 9P
]);

const UNTRUSTED_VOLUME_PATTERNS = [
  /\/Library\/CloudStorage(?:\/|$)/u,
  /\/Library\/Mobile Documents(?:\/|$)/u,
  /\/Dropbox(?:\/|$)/u,
  /\/OneDrive[^/]*(?:\/|$)/u,
  /^\/Volumes(?:\/|$)/u,
  /^\/media(?:\/|$)/u,
  /^\/mnt(?:\/|$)/u,
  /^\/run\/user\/[^/]+\/gvfs(?:\/|$)/u,
];

export type DataRootLayout = {
  root: string;
  ledger: string;
  database: string;
  blobs: string;
  backups: string;
  filesystem_type: number;
};

function fail(): never {
  throw new StorageError("INVALID_DATA_ROOT");
}

function nearestExistingPath(path: string): string {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      fail();
    }
    cursor = parent;
  }
  return cursor;
}

function assertNoSymlinkedTail(existing: string, target: string): void {
  let cursor = target;
  while (cursor !== existing) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      fail();
    }
    cursor = dirname(cursor);
  }
  if (lstatSync(existing).isSymbolicLink()) {
    fail();
  }
}

export function prepareDataRoot(input: string): DataRootLayout {
  if (
    input.trim() !== input ||
    !isAbsolute(input) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(input) ||
    input.startsWith("\\\\")
  ) {
    fail();
  }

  const root = resolve(input);
  if (
    root === parse(root).root ||
    UNTRUSTED_VOLUME_PATTERNS.some((pattern) => pattern.test(root))
  ) {
    fail();
  }

  const existing = nearestExistingPath(root);
  assertNoSymlinkedTail(existing, root);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) {
    fail();
  }

  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== root) {
    fail();
  }

  const filesystem = statfsSync(root);
  if (NETWORK_FILESYSTEM_TYPES.has(filesystem.type)) {
    fail();
  }

  const ledger = resolve(root, "ledger");
  const blobs = resolve(root, "blobs");
  const backups = resolve(root, "backups");
  for (const directory of [root, ledger, blobs, backups]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  return {
    root,
    ledger,
    database: resolve(ledger, "memory.db"),
    blobs,
    backups,
    filesystem_type: filesystem.type,
  };
}

export function inspectDataRoot(input: string): DataRootLayout {
  if (
    input.trim() !== input ||
    !isAbsolute(input) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(input) ||
    input.startsWith("\\\\")
  ) {
    fail();
  }
  const root = resolve(input);
  if (
    root === parse(root).root ||
    !existsSync(root) ||
    UNTRUSTED_VOLUME_PATTERNS.some((pattern) => pattern.test(root)) ||
    lstatSync(root).isSymbolicLink() ||
    !statSync(root).isDirectory() ||
    realpathSync(root) !== root
  ) {
    fail();
  }
  const ledger = resolve(root, "ledger");
  const blobs = resolve(root, "blobs");
  const backups = resolve(root, "backups");
  const database = resolve(ledger, "memory.db");
  const wal = `${database}-wal`;
  for (const directory of [ledger, blobs, backups]) {
    if (
      !existsSync(directory) ||
      lstatSync(directory).isSymbolicLink() ||
      !statSync(directory).isDirectory()
    ) {
      fail();
    }
  }
  if (
    !existsSync(database) ||
    lstatSync(database).isSymbolicLink() ||
    !statSync(database).isFile()
  ) {
    fail();
  }
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new StorageError("STORAGE_UNAVAILABLE", { retryable: true });
  }
  const filesystem = statfsSync(root);
  if (NETWORK_FILESYSTEM_TYPES.has(filesystem.type)) {
    fail();
  }
  return {
    root,
    ledger,
    database,
    blobs,
    backups,
    filesystem_type: filesystem.type,
  };
}

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  RootLeaseRecoverySchema,
  RootLeaseSchema,
  UtcTimestampSchema,
  canonicalJson,
  type RootLease,
  type RootLeaseRecovery,
} from "@memo-graph/contracts";

import { StorageError } from "./errors.js";

const LEASE_FILE = ".memo-graph-writer.lock";
const FENCE_FILE = ".memo-graph-writer.fence";
const DEFAULT_TTL_MS = 15_000;

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function rootRef(root: string): string {
  const stat = statSync(root);
  return `root:${stat.dev}:${stat.ino}`;
}

function readLease(path: string): RootLease {
  try {
    return RootLeaseSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch {
    throw new StorageError("STALE_ROOT_LEASE");
  }
}

function nextFence(root: string): number {
  const path = join(root, FENCE_FILE);
  let current = 0;
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8").trim();
    if (!/^[0-9]+$/u.test(text)) {
      throw new StorageError("STALE_ROOT_LEASE");
    }
    current = Number(text);
    if (!Number.isSafeInteger(current)) {
      throw new StorageError("STALE_ROOT_LEASE");
    }
  }
  const next = current + 1;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${next}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  fsyncDirectory(root);
  return next;
}

function writeLeaseAtomic(root: string, lease: RootLease): void {
  const path = join(root, LEASE_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(lease)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  fsyncDirectory(root);
}

function ownerPid(ownerId: string): number | null {
  const match = /^pid:(?<pid>[1-9][0-9]*):/u.exec(ownerId);
  const pid = Number(match?.groups?.pid);
  return Number.isSafeInteger(pid) ? pid : null;
}

function defaultOwnerNotLive(ownerId: string): boolean {
  const pid = ownerPid(ownerId);
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

export class RootWriterLease {
  readonly #root: string;
  #lease: RootLease;
  #released = false;

  private constructor(root: string, lease: RootLease) {
    this.#root = root;
    this.#lease = lease;
  }

  static acquire(
    root: string,
    options?: { now?: string; ttlMs?: number; ownerId?: string },
  ): RootWriterLease {
    const path = join(root, LEASE_FILE);
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if (hasErrnoCode(error, "EEXIST")) {
        throw new StorageError("ROOT_LEASE_HELD", { retryable: true });
      }
      throw new StorageError("STORAGE_UNAVAILABLE", { retryable: true });
    }
    let lease: RootLease;
    try {
      const issuedAt = options?.now ?? new Date().toISOString();
      const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
      lease = RootLeaseSchema.parse({
        schema_version: "1.0.0",
        lease_id: `lease:${randomUUID()}`,
        owner_id:
          options?.ownerId ?? `pid:${process.pid}:${randomUUID()}`,
        root_ref: rootRef(root),
        fence_token: nextFence(root),
        state: "active",
        acquired_at: issuedAt,
        heartbeat_at: issuedAt,
        expires_at: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
      });
      writeFileSync(descriptor, `${canonicalJson(lease)}\n`);
      fsyncSync(descriptor);
    } catch (error) {
      closeSync(descriptor);
      if (existsSync(path)) {
        unlinkSync(path);
      }
      throw error;
    }
    closeSync(descriptor);
    fsyncDirectory(root);
    return new RootWriterLease(root, lease);
  }

  get snapshot(): RootLease {
    return this.#lease;
  }

  heartbeat(options?: { now?: string; ttlMs?: number }): RootLease {
    this.#assertOwned();
    const heartbeatAt = UtcTimestampSchema.parse(
      options?.now ?? new Date().toISOString(),
    );
    const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    if (Date.parse(heartbeatAt) < Date.parse(this.#lease.heartbeat_at)) {
      throw new StorageError("STALE_ROOT_LEASE");
    }
    this.#lease = RootLeaseSchema.parse({
      ...this.#lease,
      heartbeat_at: heartbeatAt,
      expires_at: new Date(Date.parse(heartbeatAt) + ttlMs).toISOString(),
    });
    writeLeaseAtomic(this.#root, this.#lease);
    return this.#lease;
  }

  release(): void {
    if (this.#released) {
      return;
    }
    this.#assertOwned();
    unlinkSync(join(this.#root, LEASE_FILE));
    fsyncDirectory(this.#root);
    this.#released = true;
  }

  #assertOwned(): void {
    if (this.#released) {
      throw new StorageError("STALE_ROOT_LEASE");
    }
    const current = readLease(join(this.#root, LEASE_FILE));
    if (
      current.lease_id !== this.#lease.lease_id ||
      current.fence_token !== this.#lease.fence_token ||
      current.owner_id !== this.#lease.owner_id
    ) {
      throw new StorageError("STALE_ROOT_LEASE");
    }
  }
}

export function recoverStaleRootLease(input: {
  root: string;
  recovery: RootLeaseRecovery;
  now?: string;
  ownerNotLive?: (ownerId: string) => boolean;
}): void {
  let recovery: RootLeaseRecovery;
  let now: number;
  try {
    recovery = RootLeaseRecoverySchema.parse(input.recovery);
    now = Date.parse(
      UtcTimestampSchema.parse(input.now ?? new Date().toISOString()),
    );
  } catch {
    throw new StorageError("STALE_ROOT_LEASE");
  }
  if (!Number.isFinite(now)) {
    throw new StorageError("STALE_ROOT_LEASE");
  }
  const path = join(input.root, LEASE_FILE);
  let before: string;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    throw new StorageError("STALE_ROOT_LEASE");
  }
  const lease = readLease(path);
  if (
    recovery.root_ref !== rootRef(input.root) ||
    recovery.previous_lease_id !== lease.lease_id ||
    recovery.previous_fence_token !== lease.fence_token ||
    recovery.observed_heartbeat_at !== lease.heartbeat_at ||
    now <= Date.parse(lease.expires_at) ||
    !(input.ownerNotLive ?? defaultOwnerNotLive)(lease.owner_id) ||
    readFileSync(path, "utf8") !== before
  ) {
    throw new StorageError("STALE_ROOT_LEASE");
  }
  const quarantine = `${path}.stale.${recovery.takeover_nonce}`;
  renameSync(path, quarantine);
  fsyncDirectory(input.root);
  unlinkSync(quarantine);
  fsyncDirectory(input.root);
}

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { canonicalJson, canonicalSha256 } from "@memo-graph/contracts";

import { StorageError } from "./errors.js";

const HELPER_PATH = fileURLToPath(
  new URL("../../../tools/rename-noreplace/rename-noreplace", import.meta.url),
);
const MAX_TARGET_RESERVATION_BYTES = 4_096;

type ProcessLiveness = "live" | "dead" | "ambiguous";

type TargetReservationRecoveryHooks = {
  afterOpen?: (path: string) => void;
  beforeRead?: (path: string) => void;
  afterRead?: (path: string) => void;
  beforeUnlink?: (path: string) => void;
  signalProcess?: (processId: number, signal: 0) => boolean;
};

function reservationIdentity(target: string) {
  const resolvedTarget = resolve(target);
  const alias = canonicalSha256({
    target_name: basename(resolvedTarget),
  }).slice("sha256:".length, "sha256:".length + 32);
  return {
    alias,
    path: join(
      resolve(dirname(resolvedTarget)),
      `.memo-restore-${alias}.reservation`,
    ),
  };
}

function processLiveness(
  processId: number,
  signalProcess: (processId: number, signal: 0) => boolean = (
    observedProcessId,
    signal,
  ) => process.kill(observedProcessId, signal),
): ProcessLiveness {
  try {
    signalProcess(processId, 0);
    return "live";
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    )
      ? "dead"
      : "ambiguous";
  }
}

function sameReservationIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivateReservationFile(
  descriptorStat: BigIntStats,
  pathStat: BigIntStats,
): boolean {
  const expectedOwner = process.getuid?.();
  return (
    descriptorStat.isFile() &&
    pathStat.isFile() &&
    !pathStat.isSymbolicLink() &&
    descriptorStat.dev === pathStat.dev &&
    descriptorStat.ino === pathStat.ino &&
    descriptorStat.size > 0n &&
    descriptorStat.size <= BigInt(MAX_TARGET_RESERVATION_BYTES) &&
    (descriptorStat.mode & 0o777n) === 0o600n &&
    (pathStat.mode & 0o777n) === 0o600n &&
    (expectedOwner === undefined ||
      (descriptorStat.uid === BigInt(expectedOwner) &&
        pathStat.uid === BigInt(expectedOwner)))
  );
}

function readBoundedReservation(
  descriptor: number,
  expectedSize: bigint,
): string {
  const bytes = Buffer.alloc(MAX_TARGET_RESERVATION_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (count === 0) break;
    offset += count;
  }
  if (
    offset === 0 ||
    offset > MAX_TARGET_RESERVATION_BYTES ||
    BigInt(offset) !== expectedSize
  ) {
    throw new StorageError("STORAGE_UNAVAILABLE");
  }
  return bytes.subarray(0, offset).toString("utf8");
}

function parseReservationRecord(raw: string): {
  schema_version: "1.0.0";
  reservation_id: string;
  operation_id: string;
  process_id: number;
} {
  // A self-hash would be forgeable by the same OS account, while no trusted
  // reservation-signing key exists. Canonical encoding detects torn/ambiguous
  // records; owner/mode and descriptor/path identity enforce the stated local
  // boundary without claiming cryptographic authenticity.
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    canonicalJson(Object.keys(parsed).sort()) !==
      canonicalJson(
        [
          "operation_id",
          "process_id",
          "reservation_id",
          "schema_version",
        ].sort(),
      )
  ) {
    throw new StorageError("STORAGE_UNAVAILABLE");
  }
  const record = parsed as {
    schema_version?: unknown;
    reservation_id?: unknown;
    operation_id?: unknown;
    process_id?: unknown;
  };
  if (
    record.schema_version !== "1.0.0" ||
    typeof record.reservation_id !== "string" ||
    typeof record.operation_id !== "string" ||
    !Number.isSafeInteger(record.process_id) ||
    Number(record.process_id) <= 0 ||
    Number(record.process_id) > 2_147_483_647 ||
    raw !== `${canonicalJson(record)}\n`
  ) {
    throw new StorageError("STORAGE_UNAVAILABLE");
  }
  return record as {
    schema_version: "1.0.0";
    reservation_id: string;
    operation_id: string;
    process_id: number;
  };
}

function recoverCrashedReservation(
  target: string,
  operationId: string,
  hooks: TargetReservationRecoveryHooks = {},
): boolean {
  const identity = reservationIdentity(target);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      identity.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = fstatSync(descriptor, { bigint: true });
    hooks.afterOpen?.(identity.path);
    const pathBefore = lstatSync(identity.path, { bigint: true });
    if (
      !sameReservationIdentity(before, pathBefore) ||
      !isPrivateReservationFile(before, pathBefore)
    ) {
      return false;
    }
    hooks.beforeRead?.(identity.path);
    const raw = readBoundedReservation(descriptor, before.size);
    hooks.afterRead?.(identity.path);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(identity.path, { bigint: true });
    if (
      !sameReservationIdentity(before, after) ||
      !sameReservationIdentity(after, pathAfter) ||
      !isPrivateReservationFile(after, pathAfter)
    ) {
      return false;
    }
    const record = parseReservationRecord(raw);
    const observeLiveness = () =>
      processLiveness(record.process_id, hooks.signalProcess);
    if (
      record.reservation_id !== identity.alias ||
      record.operation_id !== operationId ||
      observeLiveness() !== "dead"
    ) {
      return false;
    }
    hooks.beforeUnlink?.(identity.path);
    const pathBeforeUnlink = lstatSync(identity.path, { bigint: true });
    if (
      !sameReservationIdentity(after, pathBeforeUnlink) ||
      !isPrivateReservationFile(after, pathBeforeUnlink) ||
      observeLiveness() !== "dead"
    ) {
      return false;
    }
    unlinkSync(identity.path);
    fsyncDirectory(dirname(identity.path));
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** Test-only deterministic seams; intentionally not exported by package index. */
export function recoverCrashedTargetReservationForTest(input: {
  target: string;
  operationId: string;
  hooks?: TargetReservationRecoveryHooks;
}): boolean {
  return recoverCrashedReservation(
    input.target,
    input.operationId,
    input.hooks,
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

export class TargetNameReservation {
  readonly #parent: string;
  readonly #target: string;
  readonly #path: string;
  readonly #descriptor: number;
  readonly #reservationIdentity: BigIntStats;
  readonly #parentIdentity: {
    dev: bigint;
    ino: bigint;
    uid: bigint;
    mode: bigint;
  };
  #released = false;

  private constructor(target: string, operationId: string) {
    this.#target = resolve(target);
    this.#parent = resolve(dirname(this.#target));
    const parentStat = lstatSync(this.#parent, { bigint: true });
    const expectedOwner = process.getuid?.();
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      realpathSync(this.#parent) !== this.#parent ||
      (parentStat.mode & 0o777n) !== 0o700n ||
      (expectedOwner !== undefined &&
        parentStat.uid !== BigInt(expectedOwner))
    ) {
      throw new StorageError("INVALID_DATA_ROOT");
    }
    this.#parentIdentity = {
      dev: parentStat.dev,
      ino: parentStat.ino,
      uid: parentStat.uid,
      mode: parentStat.mode,
    };
    const identity = reservationIdentity(this.#target);
    const targetAlias = identity.alias;
    this.#path = identity.path;
    let descriptor: number | undefined;
    let created = false;
    let createdIdentity: BigIntStats | undefined;
    try {
      descriptor = openSync(this.#path, "wx", 0o600);
      created = true;
      createdIdentity = fstatSync(descriptor, { bigint: true });
      writeFileSync(
        descriptor,
        `${canonicalJson({
          schema_version: "1.0.0",
          reservation_id: targetAlias,
          operation_id: operationId,
          process_id: process.pid,
        })}\n`,
      );
      fsyncSync(descriptor);
      this.#reservationIdentity = fstatSync(descriptor, { bigint: true });
      fsyncDirectory(this.#parent);
      this.#descriptor = descriptor;
    } catch (error) {
      if (
        created &&
        descriptor !== undefined &&
        createdIdentity !== undefined
      ) {
        try {
          const descriptorStat = fstatSync(descriptor, { bigint: true });
          const pathStat = lstatSync(this.#path, { bigint: true });
          if (
            sameFileObject(createdIdentity, descriptorStat) &&
            sameFileObject(descriptorStat, pathStat)
          ) {
            unlinkSync(this.#path);
            fsyncDirectory(this.#parent);
          }
        } catch {
          // An ambiguous path is retained for explicit stale-owner recovery.
        }
      }
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the admission failure while completing best-effort cleanup.
        }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new StorageError("TARGET_EXISTS");
      }
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
  }

  static acquire(
    target: string,
    operationId = `restore:${reservationIdentity(target).alias}`,
  ): TargetNameReservation {
    if (existsSync(target)) {
      throw new StorageError("TARGET_EXISTS");
    }
    try {
      return new TargetNameReservation(target, operationId);
    } catch (error) {
      if (
        error instanceof StorageError &&
        error.code === "TARGET_EXISTS" &&
        recoverCrashedReservation(target, operationId)
      ) {
        return new TargetNameReservation(target, operationId);
      }
      throw error;
    }
  }

  assertUnchanged(): void {
    const current = lstatSync(this.#parent, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      realpathSync(this.#parent) !== this.#parent ||
      current.dev !== this.#parentIdentity.dev ||
      current.ino !== this.#parentIdentity.ino ||
      current.uid !== this.#parentIdentity.uid ||
      current.mode !== this.#parentIdentity.mode ||
      existsSync(this.#target)
    ) {
      throw new StorageError("TARGET_EXISTS");
    }
  }

  publish(
    source: string,
    helperPath?: string,
    testBeforePublish?: () => void,
  ): void {
    this.assertUnchanged();
    publishDirectoryNoReplace({
      source,
      target: this.#target,
      targetParentIdentity: this.#parentIdentity,
      ...(helperPath === undefined ? {} : { helperPath }),
      ...(testBeforePublish === undefined ? {} : { testBeforePublish }),
    });
  }

  release(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    try {
      const descriptorStat = fstatSync(this.#descriptor, { bigint: true });
      const pathStat = lstatSync(this.#path, { bigint: true });
      if (
        !sameReservationIdentity(
          this.#reservationIdentity,
          descriptorStat,
        ) ||
        !sameReservationIdentity(descriptorStat, pathStat) ||
        !isPrivateReservationFile(descriptorStat, pathStat)
      ) {
        throw new StorageError("STORAGE_UNAVAILABLE");
      }
      unlinkSync(this.#path);
      fsyncDirectory(this.#parent);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("STORAGE_UNAVAILABLE");
    } finally {
      closeSync(this.#descriptor);
    }
  }
}

export function publishDirectoryNoReplace(input: {
  source: string;
  target: string;
  targetParentIdentity: {
    dev: bigint;
    ino: bigint;
    uid: bigint;
    mode: bigint;
  };
  helperPath?: string;
  testBeforePublish?: () => void;
  testAfterPublish?: () => void;
}): void {
  if (process.platform !== "darwin") {
    throw new StorageError("NO_REPLACE_UNSUPPORTED");
  }
  const helper = input.helperPath ?? HELPER_PATH;
  if (!existsSync(helper) || !lstatSync(helper).isFile()) {
    throw new StorageError("NO_REPLACE_UNSUPPORTED");
  }
  const source = resolve(input.source);
  const target = resolve(input.target);
  const sourceParent = resolve(dirname(source));
  const targetParent = resolve(dirname(target));
  const sourceParentStat = lstatSync(sourceParent, { bigint: true });
  const sourceStat = lstatSync(source, { bigint: true });
  const targetParentStat = lstatSync(targetParent, { bigint: true });
  const expectedOwner = process.getuid?.();
  if (
    !sourceParentStat.isDirectory() ||
    sourceParentStat.isSymbolicLink() ||
    realpathSync(sourceParent) !== sourceParent ||
    (sourceParentStat.mode & 0o077n) !== 0n ||
    !sourceStat.isDirectory() ||
    sourceStat.isSymbolicLink() ||
    realpathSync(source) !== source ||
    (sourceStat.mode & 0o777n) !== 0o700n ||
    !targetParentStat.isDirectory() ||
    targetParentStat.isSymbolicLink() ||
    realpathSync(targetParent) !== targetParent ||
    targetParentStat.dev !== input.targetParentIdentity.dev ||
    targetParentStat.ino !== input.targetParentIdentity.ino ||
    targetParentStat.uid !== input.targetParentIdentity.uid ||
    targetParentStat.mode !== input.targetParentIdentity.mode ||
    (targetParentStat.mode & 0o777n) !== 0o700n ||
    (expectedOwner !== undefined &&
      (sourceParentStat.uid !== BigInt(expectedOwner) ||
        sourceStat.uid !== BigInt(expectedOwner) ||
        targetParentStat.uid !== BigInt(expectedOwner)))
  ) {
    throw new StorageError("INVALID_DATA_ROOT");
  }
  input.testBeforePublish?.();
  const result = spawnSync(
    helper,
    [
      sourceParent,
      basename(source),
      targetParent,
      basename(target),
      sourceParentStat.dev.toString(),
      sourceParentStat.ino.toString(),
      sourceParentStat.uid.toString(),
      sourceParentStat.mode.toString(),
      sourceStat.dev.toString(),
      sourceStat.ino.toString(),
      sourceStat.uid.toString(),
      sourceStat.mode.toString(),
      input.targetParentIdentity.dev.toString(),
      input.targetParentIdentity.ino.toString(),
      input.targetParentIdentity.uid.toString(),
      input.targetParentIdentity.mode.toString(),
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    try {
      input.testAfterPublish?.();
      const publishedParentStat = lstatSync(targetParent, {
        bigint: true,
      });
      const publishedTargetStat = lstatSync(target, { bigint: true });
      if (
        !publishedParentStat.isDirectory() ||
        publishedParentStat.isSymbolicLink() ||
        realpathSync(targetParent) !== targetParent ||
        publishedParentStat.dev !== input.targetParentIdentity.dev ||
        publishedParentStat.ino !== input.targetParentIdentity.ino ||
        publishedParentStat.uid !== input.targetParentIdentity.uid ||
        publishedParentStat.mode !== input.targetParentIdentity.mode ||
        !publishedTargetStat.isDirectory() ||
        publishedTargetStat.isSymbolicLink() ||
        realpathSync(target) !== target ||
        publishedTargetStat.dev !== sourceStat.dev ||
        publishedTargetStat.ino !== sourceStat.ino ||
        publishedTargetStat.uid !== sourceStat.uid ||
        publishedTargetStat.mode !== sourceStat.mode
      ) {
        throw new StorageError("STORAGE_UNAVAILABLE");
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
    return;
  }
  if (result.status === 17) {
    throw new StorageError("TARGET_EXISTS");
  }
  if (result.status === 78) {
    throw new StorageError("NO_REPLACE_UNSUPPORTED");
  }
  if (result.status === 75) {
    throw new StorageError("TARGET_EXISTS");
  }
  throw new StorageError("STORAGE_UNAVAILABLE");
}

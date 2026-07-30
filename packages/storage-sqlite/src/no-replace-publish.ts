import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { canonicalJson, canonicalSha256 } from "@memo-graph/contracts";

import { StorageError } from "./errors.js";

const HELPER_PATH = fileURLToPath(
  new URL("../../../tools/rename-noreplace/rename-noreplace", import.meta.url),
);

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
  readonly #parentIdentity: {
    dev: bigint;
    ino: bigint;
  };
  #released = false;

  private constructor(target: string) {
    this.#target = resolve(target);
    this.#parent = resolve(dirname(this.#target));
    const parentStat = lstatSync(this.#parent, { bigint: true });
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      realpathSync(this.#parent) !== this.#parent
    ) {
      throw new StorageError("INVALID_DATA_ROOT");
    }
    this.#parentIdentity = { dev: parentStat.dev, ino: parentStat.ino };
    const targetAlias = canonicalSha256({
      target_name: basename(this.#target),
    }).slice("sha256:".length, "sha256:".length + 32);
    this.#path = join(
      this.#parent,
      `.memo-restore-${targetAlias}.reservation`,
    );
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = openSync(this.#path, "wx", 0o600);
      created = true;
      writeFileSync(
        descriptor,
        `${canonicalJson({
          schema_version: "1.0.0",
          reservation_id: targetAlias,
        })}\n`,
      );
      fsyncSync(descriptor);
      fsyncDirectory(this.#parent);
      this.#descriptor = descriptor;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the admission failure while completing best-effort cleanup.
        }
      }
      if (created) {
        try {
          unlinkSync(this.#path);
          fsyncDirectory(this.#parent);
        } catch {
          // A failed cleanup is still fail-closed: no publication is attempted.
        }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new StorageError("TARGET_EXISTS");
      }
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
  }

  static acquire(target: string): TargetNameReservation {
    if (existsSync(target)) {
      throw new StorageError("TARGET_EXISTS");
    }
    return new TargetNameReservation(target);
  }

  assertUnchanged(): void {
    const current = lstatSync(this.#parent, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      realpathSync(this.#parent) !== this.#parent ||
      current.dev !== this.#parentIdentity.dev ||
      current.ino !== this.#parentIdentity.ino ||
      existsSync(this.#target)
    ) {
      throw new StorageError("TARGET_EXISTS");
    }
  }

  publish(source: string, helperPath?: string): void {
    this.assertUnchanged();
    publishDirectoryNoReplace({
      source,
      target: this.#target,
      targetParentIdentity: this.#parentIdentity,
      ...(helperPath === undefined ? {} : { helperPath }),
    });
  }

  release(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    closeSync(this.#descriptor);
    if (existsSync(this.#path)) {
      unlinkSync(this.#path);
      fsyncDirectory(this.#parent);
    }
  }
}

export function publishDirectoryNoReplace(input: {
  source: string;
  target: string;
  targetParentIdentity: {
    dev: bigint;
    ino: bigint;
  };
  helperPath?: string;
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
  if (
    !sourceParentStat.isDirectory() ||
    sourceParentStat.isSymbolicLink() ||
    realpathSync(sourceParent) !== sourceParent ||
    realpathSync(targetParent) !== targetParent
  ) {
    throw new StorageError("INVALID_DATA_ROOT");
  }
  const result = spawnSync(
    helper,
    [
      sourceParent,
      basename(source),
      targetParent,
      basename(target),
      sourceParentStat.dev.toString(),
      sourceParentStat.ino.toString(),
      input.targetParentIdentity.dev.toString(),
      input.targetParentIdentity.ino.toString(),
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    fsyncDirectory(targetParent);
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

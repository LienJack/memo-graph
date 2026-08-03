import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { UtcTimestampSchema, canonicalJson } from "@memo-graph/contracts";
import { z } from "zod";

const LaunchLockOwnerSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    launch_id: z.string().uuid(),
    process_id: z.number().int().positive(),
    created_at: UtcTimestampSchema,
  })
  .strict();

export type WorkbenchLaunchLock = {
  path: string;
  launchId: string;
  release(): void;
};

export function tryAcquireWorkbenchLaunchLock(input: {
  path: string;
  launchId: string;
  createdAt: string;
}): WorkbenchLaunchLock | null {
  try {
    mkdirSync(input.path, { mode: 0o700 });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return null;
    }
    throw error;
  }
  const directoryIdentity = lstatSync(input.path);
  const ownerPath = join(input.path, "owner.json");
  try {
    writeFileSync(
      ownerPath,
      `${canonicalJson(
        LaunchLockOwnerSchema.parse({
          schema_version: "1.0.0",
          launch_id: input.launchId,
          process_id: process.pid,
          created_at: input.createdAt,
        }),
      )}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    rmSync(input.path, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return {
    path: input.path,
    launchId: input.launchId,
    release: () => {
      if (released || !existsSync(input.path)) {
        return;
      }
      released = true;
      const current = lstatSync(input.path);
      if (
        current.dev !== directoryIdentity.dev ||
        current.ino !== directoryIdentity.ino
      ) {
        return;
      }
      rmSync(input.path, { recursive: true, force: true });
    },
  };
}

export function recoverExpiredWorkbenchLaunchLock(input: {
  path: string;
  nowMs: number;
  staleAfterMs: number;
}): boolean {
  if (!existsSync(input.path)) {
    return true;
  }
  try {
    const owner = LaunchLockOwnerSchema.parse(
      JSON.parse(readFileSync(join(input.path, "owner.json"), "utf8")) as unknown,
    );
    const age = input.nowMs - Date.parse(owner.created_at);
    let ownerAlive = true;
    try {
      process.kill(owner.process_id, 0);
    } catch (error) {
      ownerAlive = !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      );
    }
    if (age < input.staleAfterMs || ownerAlive) {
      return false;
    }
  } catch {
    const age = input.nowMs - lstatSync(input.path).mtimeMs;
    if (age < input.staleAfterMs) {
      return false;
    }
  }
  const quarantine = `${input.path}.stale-${process.pid}-${input.nowMs}`;
  try {
    renameSync(input.path, quarantine);
    rmSync(quarantine, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  TargetNameReservation,
  publishDirectoryNoReplace,
  recoverCrashedTargetReservationForTest,
} from "../../packages/storage-sqlite/src/no-replace-publish.js";

const cleanup: string[] = [];

function temporaryRoot(label: string): string {
  const root = realpathSync(
    mkdtempSync(
      join(realpathSync(tmpdir()), `memo-reservation-${label}-`),
    ),
  );
  cleanup.push(root);
  return root;
}

function reservationIdentity(target: string): {
  alias: string;
  path: string;
} {
  const alias = canonicalSha256({
    target_name: basename(target),
  }).slice("sha256:".length, "sha256:".length + 32);
  return {
    alias,
    path: join(
      dirname(target),
      `.memo-restore-${alias}.reservation`,
    ),
  };
}

function writeReservation(input: {
  target: string;
  operationId: string;
  processId: number;
}): string {
  const identity = reservationIdentity(input.target);
  writeFileSync(
    identity.path,
    `${canonicalJson({
      schema_version: "1.0.0",
      reservation_id: identity.alias,
      operation_id: input.operationId,
      process_id: input.processId,
    })}\n`,
    { mode: 0o600 },
  );
  return identity.path;
}

function expectTargetExists(effect: () => unknown): void {
  expect(effect).toThrowError(
    expect.objectContaining({ code: "TARGET_EXISTS" }),
  );
}

afterEach(() => {
  while (cleanup.length > 0) {
    const root = cleanup.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("target-name reservation recovery", () => {
  it("rejects symlinks, oversized records, and non-private modes", () => {
    const root = temporaryRoot("unsafe-files");

    const symlinkTarget = join(root, "symlink-target");
    const symlinkRecord = join(root, "symlink-record.json");
    const symlinkIdentity = reservationIdentity(symlinkTarget);
    writeFileSync(symlinkRecord, "{}\n", { mode: 0o600 });
    symlinkSync(symlinkRecord, symlinkIdentity.path);
    expectTargetExists(() =>
      TargetNameReservation.acquire(
        symlinkTarget,
        "restore:symlink-target",
      ),
    );

    const oversizedTarget = join(root, "oversized-target");
    const oversizedPath = reservationIdentity(oversizedTarget).path;
    writeFileSync(oversizedPath, Buffer.alloc(4_097, 0x61), {
      mode: 0o600,
    });
    expectTargetExists(() =>
      TargetNameReservation.acquire(
        oversizedTarget,
        "restore:oversized-target",
      ),
    );

    const permissiveTarget = join(root, "permissive-target");
    const permissivePath = writeReservation({
      target: permissiveTarget,
      operationId: "restore:permissive-target",
      processId: 2_147_483_647,
    });
    chmodSync(permissivePath, 0o640);
    expectTargetExists(() =>
      TargetNameReservation.acquire(
        permissiveTarget,
        "restore:permissive-target",
      ),
    );
  });

  it("fails closed when the opened reservation path is replaced or mutated", () => {
    const root = temporaryRoot("replacement");
    const target = join(root, "target");
    const operationId = "restore:replacement";
    const path = writeReservation({
      target,
      operationId,
      processId: 2_147_483_647,
    });

    expect(
      recoverCrashedTargetReservationForTest({
        target,
        operationId,
        hooks: {
          afterOpen: () => {
            unlinkSync(path);
            writeReservation({
              target,
              operationId,
              processId: 2_147_483_647,
            });
          },
        },
      }),
    ).toBe(false);
    expect(existsSync(path)).toBe(true);

    const symlinkSource = join(root, "symlink-replacement.json");
    writeFileSync(symlinkSource, "{}\n", { mode: 0o600 });
    expect(
      recoverCrashedTargetReservationForTest({
        target,
        operationId,
        hooks: {
          beforeRead: () => {
            unlinkSync(path);
            symlinkSync(symlinkSource, path);
          },
        },
      }),
    ).toBe(false);
    expect(existsSync(path)).toBe(true);

    unlinkSync(path);
    writeReservation({
      target,
      operationId,
      processId: 2_147_483_647,
    });
    expect(
      recoverCrashedTargetReservationForTest({
        target,
        operationId,
        hooks: {
          beforeRead: () => {
            writeFileSync(path, Buffer.alloc(1_048_576, 0x61), {
              mode: 0o600,
            });
          },
        },
      }),
    ).toBe(false);
    expect(existsSync(path)).toBe(true);

    unlinkSync(path);
    writeReservation({
      target,
      operationId,
      processId: 2_147_483_647,
    });
    expect(
      recoverCrashedTargetReservationForTest({
        target,
        operationId,
        hooks: {
          afterRead: () => {
            writeFileSync(path, `${"x".repeat(128)}\n`, {
              mode: 0o600,
            });
          },
        },
      }),
    ).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps exact-operation live, EPERM, and ambiguous reservations", () => {
    const root = temporaryRoot("liveness");
    const liveTarget = join(root, "live-target");
    const livePath = writeReservation({
      target: liveTarget,
      operationId: "restore:live-target",
      processId: process.pid,
    });
    expectTargetExists(() =>
      TargetNameReservation.acquire(
        liveTarget,
        "restore:live-target",
      ),
    );
    expect(existsSync(livePath)).toBe(true);

    for (const code of ["EPERM", "EINVAL"]) {
      const ambiguousTarget = join(
        root,
        `${code.toLowerCase()}-target`,
      );
      const operationId = `restore:${code.toLowerCase()}-target`;
      const ambiguousPath = writeReservation({
        target: ambiguousTarget,
        operationId,
        processId: 2_147_483_647,
      });
      expect(
        recoverCrashedTargetReservationForTest({
          target: ambiguousTarget,
          operationId,
          hooks: {
            signalProcess: () => {
              throw Object.assign(new Error("ambiguous liveness"), {
                code,
              });
            },
          },
        }),
      ).toBe(false);
      expect(existsSync(ambiguousPath)).toBe(true);
    }

    const ambiguousTarget = join(root, "eperm-target");
    const ambiguousPath = reservationIdentity(ambiguousTarget).path;
    expectTargetExists(() =>
      TargetNameReservation.acquire(
        ambiguousTarget,
        "restore:different-operation",
      ),
    );
    expect(existsSync(ambiguousPath)).toBe(true);
  });

  it("retries only after a real exact-operation owner exits", async () => {
    const root = temporaryRoot("dead-owner");
    const target = join(root, "target");
    const operationId = "restore:dead-owner";
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    await once(child, "spawn");
    if (child.pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    const reservationPath = writeReservation({
      target,
      operationId,
      processId: child.pid,
    });
    child.kill("SIGKILL");
    await once(child, "exit");

    const reservation = TargetNameReservation.acquire(
      target,
      operationId,
    );
    reservation.release();
    expect(existsSync(reservationPath)).toBe(false);
  });

  it("never unlinks a reservation replaced or mutated before release", () => {
    const root = temporaryRoot("release-race");
    const replacedTarget = join(root, "replaced-target");
    const replacedOperation = "restore:replaced-release";
    const replaced = TargetNameReservation.acquire(
      replacedTarget,
      replacedOperation,
    );
    const replacedPath = reservationIdentity(replacedTarget).path;
    unlinkSync(replacedPath);
    writeReservation({
      target: replacedTarget,
      operationId: "restore:replacement-owner",
      processId: process.pid,
    });
    expect(() => replaced.release()).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    );
    expect(existsSync(replacedPath)).toBe(true);

    const mutatedTarget = join(root, "mutated-target");
    const mutatedOperation = "restore:mutated-release";
    const mutated = TargetNameReservation.acquire(
      mutatedTarget,
      mutatedOperation,
    );
    const mutatedPath = reservationIdentity(mutatedTarget).path;
    writeFileSync(mutatedPath, "ambiguous\n", { mode: 0o600 });
    expect(() => mutated.release()).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    );
    expect(existsSync(mutatedPath)).toBe(true);
  });

  it("refuses to publish a staging directory replaced after validation", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const root = temporaryRoot("staging-replacement");
    const target = join(root, "target");
    const staging = join(root, "staging");
    mkdirSync(staging, { mode: 0o700 });
    const reservation = TargetNameReservation.acquire(
      target,
      "restore:staging-replacement",
    );
    try {
      expect(() =>
        reservation.publish(staging, undefined, () => {
          rmSync(staging, { recursive: true });
          mkdirSync(staging, { mode: 0o700 });
        }),
      ).toThrowError(
        expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
      );
      expect(existsSync(target)).toBe(false);
    } finally {
      reservation.release();
    }
  });

  it("fails closed when the published parent path is replaced after the bound parent fsync", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const root = temporaryRoot("parent-fsync-replacement");
    const parent = join(root, "parent");
    const displacedParent = join(root, "displaced-parent");
    mkdirSync(parent, { mode: 0o700 });
    const staging = join(parent, "staging");
    const target = join(parent, "target");
    mkdirSync(staging, { mode: 0o700 });
    const parentStat = lstatSync(parent, { bigint: true });

    expect(() =>
      publishDirectoryNoReplace({
        source: staging,
        target,
        targetParentIdentity: {
          dev: parentStat.dev,
          ino: parentStat.ino,
          uid: parentStat.uid,
          mode: parentStat.mode,
        },
        testAfterPublish: () => {
          renameSync(parent, displacedParent);
          mkdirSync(parent, { mode: 0o700 });
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    );
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(displacedParent, "target"))).toBe(true);
  });
});

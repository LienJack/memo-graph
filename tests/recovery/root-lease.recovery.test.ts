import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RootLeaseRecoverySchema } from "../../packages/contracts/src/index.js";

import {
  RootWriterLease,
  recoverStaleRootLease,
} from "../../packages/storage-sqlite/src/root-lease.js";

const cleanupPaths: string[] = [];

function root(): string {
  const parent = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-root-lease-")),
  );
  cleanupPaths.push(parent);
  const dataRoot = join(parent, "data");
  mkdirSync(dataRoot, { mode: 0o700 });
  return dataRoot;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("root writer lease", () => {
  it("excludes a second writer and advances a monotonic fence", () => {
    const dataRoot = root();
    const first = RootWriterLease.acquire(dataRoot);
    expect(() => RootWriterLease.acquire(dataRoot)).toThrow();
    const firstFence = first.snapshot.fence_token;
    first.release();
    const second = RootWriterLease.acquire(dataRoot);
    expect(second.snapshot.fence_token).toBe(firstFence + 1);
    second.release();
  });

  it("rejects a live writer from a separate process", async () => {
    const dataRoot = root();
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'import { openSync } from "node:fs";',
          'import { join } from "node:path";',
          "const root = process.argv[1];",
          'openSync(join(root, ".memo-graph-writer.lock"), "wx", 0o600);',
          'process.stdout.write("ready\\n");',
          "setInterval(() => undefined, 1_000);",
        ].join("\n"),
        dataRoot,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw new Error("lease-holder process exited before readiness");
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("lease-holder readiness timed out")),
            2_000,
          );
        }),
      ]);
      try {
        RootWriterLease.acquire(dataRoot);
        throw new Error("second process must not acquire the root");
      } catch (error) {
        expect(error).toMatchObject({
          code: "ROOT_LEASE_HELD",
          retryable: true,
        });
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      child.kill();
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, "exit");
      }
    }
  });

  it("requires exact expired and owner-not-live proof for recovery", () => {
    const dataRoot = root();
    const lease = RootWriterLease.acquire(dataRoot, {
      now: "2026-07-30T00:00:00.000Z",
      ttlMs: 1_000,
      ownerId: "pid:999999:dead-owner",
    });
    const recovery = RootLeaseRecoverySchema.parse({
      root_ref: lease.snapshot.root_ref,
      previous_lease_id: lease.snapshot.lease_id,
      previous_fence_token: lease.snapshot.fence_token,
      observed_heartbeat_at: lease.snapshot.heartbeat_at,
      takeover_nonce: "recovery_nonce_1",
    });
    expect(() =>
      recoverStaleRootLease({
        root: dataRoot,
        recovery,
        now: "2026-07-30T00:00:02.000Z",
        ownerNotLive: () => false,
      }),
    ).toThrow();
    for (const changed of [
      { ...recovery, root_ref: "root:999999:999999" },
      { ...recovery, previous_lease_id: "lease:different" },
      {
        ...recovery,
        previous_fence_token: recovery.previous_fence_token + 1,
      },
      {
        ...recovery,
        observed_heartbeat_at: "2026-07-30T00:00:00.500Z",
      },
    ]) {
      expect(() =>
        recoverStaleRootLease({
          root: dataRoot,
          recovery: RootLeaseRecoverySchema.parse(changed),
          now: "2026-07-30T00:00:02.000Z",
          ownerNotLive: () => true,
        }),
      ).toThrow();
    }
    expect(() =>
      recoverStaleRootLease({
        root: dataRoot,
        recovery,
        now: "not-a-timestamp",
        ownerNotLive: () => true,
      }),
    ).toThrow();
    recoverStaleRootLease({
      root: dataRoot,
      recovery,
      now: "2026-07-30T00:00:02.000Z",
      ownerNotLive: () => true,
    });
    expect(() => lease.release()).toThrow();
    const recovered = RootWriterLease.acquire(dataRoot);
    expect(recovered.snapshot.fence_token).toBe(
      recovery.previous_fence_token + 1,
    );
    recovered.release();
  });
});

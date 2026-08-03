import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AutomaticMemoryHookSpool } from "../../apps/codex-bootstrap/src/hook-spool.js";
import {
  AutomaticMemoryHookCaptureRequestSchema,
  type AutomaticMemoryHookCaptureRequest,
} from "../../packages/contracts/src/index.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function request(index: number): AutomaticMemoryHookCaptureRequest {
  return AutomaticMemoryHookCaptureRequestSchema.parse({
    schema_version: "1.0.0",
    idempotency_key: `codex-hook-spool-${String(index).padStart(4, "0")}`,
    source: "direct",
    event: {
      schema_version: "1.0.0",
      event_id: `hook:spool-${index}`,
      event_kind: "session_start",
      session_id: "thr_spool",
      cwd: "/workspace",
      occurred_at: "2026-08-03T08:00:00.000Z",
      model: null,
      source: "startup",
    },
  });
}

describe("Codex hook spool recovery", () => {
  it("keeps private events until the host acknowledges exact spool imports", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memo-hook-spool-")));
    cleanup.push(root);
    const directory = join(root, "spool");
    const spool = new AutomaticMemoryHookSpool({ directory });
    spool.enqueue(request(1));
    spool.enqueue(request(1));

    expect(spool.pendingCount()).toBe(1);
    expect(lstatSync(directory).mode & 0o077).toBe(0);
    await expect(
      spool.flush(async () => {
        throw new Error("host unavailable");
      }),
    ).rejects.toThrow("host unavailable");
    expect(spool.pendingCount()).toBe(1);

    const delivered: AutomaticMemoryHookCaptureRequest[] = [];
    await expect(
      spool.flush(async (pending) => {
        delivered.push(pending);
        return {
          schema_version: "1.0.0",
          status: "accepted",
          event_id: pending.event.event_id,
          additional_context: null,
        };
      }),
    ).resolves.toBe(1);
    expect(delivered).toMatchObject([{ source: "spool" }]);
    expect(spool.pendingCount()).toBe(0);
  });

  it("rejects a new entry at the bound without overwriting unacknowledged events", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memo-hook-rotate-")));
    cleanup.push(root);
    const spool = new AutomaticMemoryHookSpool({
      directory: join(root, "spool"),
      maxEntries: 2,
    });
    spool.enqueue(request(1));
    spool.enqueue(request(2));
    expect(() => spool.enqueue(request(3))).toThrow("HOOK_SPOOL_FULL");
    expect(spool.pendingCount()).toBe(2);
  });

  it("quarantines corrupt records without blocking valid recovery", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memo-hook-corrupt-")));
    cleanup.push(root);
    const directory = join(root, "spool");
    const spool = new AutomaticMemoryHookSpool({ directory });
    writeFileSync(join(directory, `${"a".repeat(64)}.json`), "not-json\n", {
      mode: 0o600,
    });

    await expect(
      spool.flush(async () => {
        throw new Error("corrupt records must not be sent");
      }),
    ).resolves.toBe(0);
    expect(spool.pendingCount()).toBe(0);
    expect(readdirSync(join(directory, "quarantine"))).toHaveLength(1);
  });
});

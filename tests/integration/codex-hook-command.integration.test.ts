import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function runHook(input: unknown, descriptor: string, spool: string) {
  const entry = join(
    process.cwd(),
    "apps",
    "codex-bootstrap",
    "dist",
    "hook-command.js",
  );
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          entry,
          "--descriptor",
          descriptor,
          "--spool",
          spool,
          "--managed-by",
          "memo-graph",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(input));
    },
  );
}

describe("deployed Codex hook command", () => {
  it("fails open into spool and replays only after host acknowledgement", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memo-hook-command-")));
    cleanup.push(root);
    chmodSync(root, 0o700);
    const descriptor = join(root, "hook.json");
    const credentialPath = join(root, "hook.key");
    const spool = join(root, "hook-spool");
    const user = {
      session_id: "thr_command",
      transcript_path: "/private/transcript.jsonl",
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn_command",
      prompt: "Use pnpm in this repository.",
      model: "gpt-5.6",
    };
    const unavailable = await runHook(user, descriptor, spool);
    expect(unavailable).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    expect(readdirSync(spool).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const credential = "A".repeat(43);
    writeFileSync(credentialPath, `${credential}\n`, { mode: 0o600 });
    const received: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
      }
      expect(request.headers.authorization).toBe(`Bearer ${credential}`);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      received.push(parsed);
      const event = parsed.event as { event_id: string };
      const output = JSON.stringify({
        schema_version: "1.0.0",
        status: "accepted",
        event_id: event.event_id,
        additional_context: null,
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(output)),
      });
      response.end(output);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("TEST_SERVER_ADDRESS_INVALID");
    }
    const now = "2026-08-03T08:00:00.000Z";
    writeFileSync(
      descriptor,
      JSON.stringify({
        schema_version: "1.0.0",
        instance_id: "workbench:hook-command",
        root_identity: {
          canonical_root_hash: `sha256:${"a".repeat(64)}`,
          device: "1",
          inode: "2",
        },
        config_identity: `sha256:${"b".repeat(64)}`,
        origin: `http://127.0.0.1:${address.port}`,
        credential_path: credentialPath,
        capture_path: "/__hooks/capture",
        created_at: now,
        ready_at: now,
      }),
      { mode: 0o600 },
    );
    const stop = await runHook(
      {
        session_id: "thr_command",
        transcript_path: null,
        cwd: root,
        hook_event_name: "Stop",
        turn_id: "turn_command",
        stop_hook_active: false,
        last_assistant_message: "Used pnpm and verified the result.",
      },
      descriptor,
      spool,
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(stop).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    expect(received).toHaveLength(2);
    expect(received.map((item) => item.source)).toEqual(["spool", "direct"]);
    expect(readdirSync(spool).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(readFileSync(credentialPath, "utf8").trim()).toBe(credential);
  });
});

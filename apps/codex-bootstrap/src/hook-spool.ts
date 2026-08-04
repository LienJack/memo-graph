import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  AutomaticMemoryHookCaptureRequestSchema,
  canonicalJson,
  type AutomaticMemoryHookCaptureRequest,
  type AutomaticMemoryHookCaptureResponse,
} from "@memo-graph/contracts";

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 96 * 1024;

function assertPrivateDirectory(pathInput: string): string {
  const path = resolve(pathInput);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    realpathSync(path) !== path ||
    (expectedUid !== undefined && stat.uid !== expectedUid)
  ) {
    throw new Error("HOOK_SPOOL_DIRECTORY_INVALID");
  }
  chmodSync(path, 0o700);
  if ((lstatSync(path).mode & 0o077) !== 0) {
    throw new Error("HOOK_SPOOL_DIRECTORY_NOT_PRIVATE");
  }
  return path;
}

function spoolFileName(idempotencyKey: string): string {
  return `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`;
}

export class AutomaticMemoryHookSpool {
  readonly #directory: string;
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(options: {
    directory: string;
    maxEntries?: number;
    maxBytes?: number;
  }) {
    this.#directory = assertPrivateDirectory(options.directory);
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (this.#maxEntries < 1 || this.#maxBytes < MAX_ENTRY_BYTES) {
      throw new Error("HOOK_SPOOL_LIMIT_INVALID");
    }
  }

  pendingCount(): number {
    return this.#entries().length;
  }

  enqueue(input: AutomaticMemoryHookCaptureRequest): void {
    const request = AutomaticMemoryHookCaptureRequestSchema.parse({
      ...input,
      source: "spool",
    });
    const bytes = Buffer.from(`${canonicalJson(request)}\n`, "utf8");
    if (bytes.byteLength > MAX_ENTRY_BYTES) {
      throw new Error("HOOK_SPOOL_ENTRY_TOO_LARGE");
    }
    const path = join(this.#directory, spoolFileName(request.idempotency_key));
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("HOOK_SPOOL_ENTRY_INVALID");
      }
      if (!readFileSync(path).equals(bytes)) {
        throw new Error("HOOK_SPOOL_IDEMPOTENCY_CONFLICT");
      }
      return;
    }
    const before = this.#entries();
    const beforeBytes = before.reduce(
      (sum, entry) => sum + lstatSync(entry).size,
      0,
    );
    if (
      before.length >= this.#maxEntries ||
      beforeBytes + bytes.byteLength > this.#maxBytes
    ) {
      throw new Error("HOOK_SPOOL_FULL");
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      writeFileSync(descriptor, bytes);
      closeSync(descriptor);
      descriptor = undefined;
      const after = this.#entries();
      const afterBytes = after.reduce(
        (sum, entry) => sum + lstatSync(entry).size,
        0,
      );
      if (after.length > this.#maxEntries || afterBytes > this.#maxBytes) {
        unlinkSync(path);
        throw new Error("HOOK_SPOOL_FULL");
      }
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isSymbolicLink() && stat.isFile()) {
          unlinkSync(path);
        }
      }
      throw error;
    }
  }

  async flush(
    send: (
      request: AutomaticMemoryHookCaptureRequest,
    ) => Promise<AutomaticMemoryHookCaptureResponse>,
    limit = 8,
  ): Promise<number> {
    let acknowledged = 0;
    for (const path of this.#entries().slice(0, Math.max(0, limit))) {
      let request: AutomaticMemoryHookCaptureRequest;
      try {
        request = this.#read(path);
      } catch {
        this.#quarantine(path);
        continue;
      }
      await send(request);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("HOOK_SPOOL_ENTRY_INVALID");
      }
      unlinkSync(path);
      acknowledged += 1;
    }
    return acknowledged;
  }

  #read(path: string): AutomaticMemoryHookCaptureRequest {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_ENTRY_BYTES
    ) {
      throw new Error("HOOK_SPOOL_ENTRY_INVALID");
    }
    return AutomaticMemoryHookCaptureRequestSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  }

  #entries(): string[] {
    return readdirSync(this.#directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .map((name) => join(this.#directory, name))
      .sort((left, right) => {
        const leftStat = lstatSync(left);
        const rightStat = lstatSync(right);
        return leftStat.mtimeMs - rightStat.mtimeMs || left.localeCompare(right);
      });
  }

  #quarantine(path: string): void {
    const quarantine = join(this.#directory, "quarantine");
    mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    chmodSync(quarantine, 0o700);
    renameSync(path, join(quarantine, `invalid-${randomUUID()}.record`));
    const invalid = readdirSync(quarantine)
      .map((name) => join(quarantine, name))
      .sort((left, right) =>
        lstatSync(left).mtimeMs - lstatSync(right).mtimeMs ||
        left.localeCompare(right),
      );
    while (invalid.length > 64) {
      const oldest = invalid.shift();
      if (oldest !== undefined) {
        unlinkSync(oldest);
      }
    }
  }
}

import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  CanonicalHashSchema,
  WorkbenchMemoryMemberSchema,
  WorkbenchOpaqueCursorSchema,
  canonicalJson,
  canonicalSha256,
  type CanonicalHash,
  type WorkbenchMemoryMember,
  type WorkbenchOpaqueCursor,
} from "@memo-graph/contracts";
import type {
  WorkbenchSnapshotCreateInput,
  WorkbenchSnapshotPage,
  WorkbenchSnapshotRegistry,
  WorkbenchSnapshotStaleReason,
} from "@memo-graph/memory-kernel";
import { z } from "zod";

const BoundedIdentitySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const CursorSnapshotIdentitySchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const CursorPayloadSchema = z
  .object({
    version: z.literal(1),
    instance_hash: CanonicalHashSchema,
    session_hash: CanonicalHashSchema,
    snapshot_id: CursorSnapshotIdentitySchema,
    query_hash: CanonicalHashSchema,
    offset: z.number().int().nonnegative(),
    expires_at_ms: z.number().int().nonnegative().safe(),
  })
  .strict();

const CursorEnvelopeSchema = z
  .object({
    payload: CursorPayloadSchema,
    mac: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

type CursorPayload = z.infer<typeof CursorPayloadSchema>;

type Snapshot = {
  snapshot_id: string;
  session_id: string;
  query_hash: CanonicalHash;
  frontier_hash: CanonicalHash;
  members: WorkbenchMemoryMember[];
  page_size: number;
  omitted_count: number;
  created_at_ms: number;
  expires_at_ms: number;
  estimated_bytes: number;
};

export class WorkbenchSnapshotCapacityError extends Error {
  readonly code = "SNAPSHOT_CAPACITY_EXCEEDED";

  constructor() {
    super("workbench snapshot capacity exceeded");
    this.name = "WorkbenchSnapshotCapacityError";
  }
}

export type SnapshotRegistryOptions = {
  instanceId: string;
  signingKey?: Buffer;
  clock?: () => number;
  idFactory?: () => string;
  ttlMs?: number;
  maxSnapshots?: number;
  maxMembers?: number;
  maxBytes?: number;
};

export class InMemoryWorkbenchSnapshotRegistry {
  readonly #instanceId: string;
  readonly #instanceHash: CanonicalHash;
  readonly #signingKey: Buffer;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #ttlMs: number;
  readonly #maxSnapshots: number;
  readonly #maxMembers: number;
  readonly #maxBytes: number;
  readonly #snapshots = new Map<string, Snapshot>();
  #retainedMembers = 0;
  #retainedBytes = 0;
  #closed = false;

  constructor(options: SnapshotRegistryOptions) {
    this.#instanceId = BoundedIdentitySchema.parse(options.instanceId);
    this.#instanceHash = this.#identityHash("instance", this.#instanceId);
    const signingKey = options.signingKey ?? randomBytes(32);
    if (signingKey.byteLength < 32) {
      throw new Error("snapshot signing key must contain at least 256 bits");
    }
    this.#signingKey = Buffer.from(signingKey);
    this.#clock = options.clock ?? Date.now;
    this.#idFactory =
      options.idFactory ?? (() => `snapshot:${randomUUID()}`);
    this.#ttlMs = z.number().int().min(1_000).max(60 * 60_000)
      .parse(options.ttlMs ?? 5 * 60_000);
    this.#maxSnapshots = z.number().int().min(1).max(1_024)
      .parse(options.maxSnapshots ?? 64);
    this.#maxMembers = z.number().int().min(1).max(1_000_000)
      .parse(options.maxMembers ?? 20_000);
    this.#maxBytes = z.number().int().min(1_024).max(256 * 1024 * 1024)
      .parse(options.maxBytes ?? 4 * 1024 * 1024);
  }

  session(sessionId: string): WorkbenchSnapshotRegistry {
    const exactSessionId = BoundedIdentitySchema.parse(sessionId);
    return {
      create: (input) => this.#create(exactSessionId, input),
      read: (cursor, queryHash) =>
        this.#read(exactSessionId, cursor, queryHash),
    };
  }

  stats(): {
    snapshots: number;
    members: number;
    estimated_bytes: number;
  } {
    return {
      snapshots: this.#snapshots.size,
      members: this.#retainedMembers,
      estimated_bytes: this.#retainedBytes,
    };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#snapshots.clear();
    this.#retainedMembers = 0;
    this.#retainedBytes = 0;
    this.#signingKey.fill(0);
  }

  #create(
    sessionId: string,
    input: WorkbenchSnapshotCreateInput,
  ): WorkbenchSnapshotPage {
    this.#assertOpen();
    this.#expire();
    const members = WorkbenchMemoryMemberSchema.array().parse(input.members);
    const createdAtMs = Date.parse(input.created_at);
    if (!Number.isFinite(createdAtMs)) {
      throw new Error("snapshot creation time is invalid");
    }
    const snapshotId = CursorSnapshotIdentitySchema.parse(this.#idFactory());
    if (this.#snapshots.has(snapshotId)) {
      throw new Error("snapshot identity collision");
    }
    const snapshot: Snapshot = {
      snapshot_id: snapshotId,
      session_id: sessionId,
      query_hash: CanonicalHashSchema.parse(input.query_hash),
      frontier_hash: CanonicalHashSchema.parse(input.frontier_hash),
      members,
      page_size: z.number().int().min(1).max(100).parse(input.page_size),
      omitted_count: z.number().int().nonnegative().parse(input.omitted_count),
      created_at_ms: createdAtMs,
      expires_at_ms: createdAtMs + this.#ttlMs,
      estimated_bytes: 0,
    };
    snapshot.estimated_bytes = Buffer.byteLength(
      canonicalJson({
        snapshot_id: snapshot.snapshot_id,
        session_id: snapshot.session_id,
        query_hash: snapshot.query_hash,
        frontier_hash: snapshot.frontier_hash,
        members: snapshot.members,
        page_size: snapshot.page_size,
        omitted_count: snapshot.omitted_count,
        created_at_ms: snapshot.created_at_ms,
        expires_at_ms: snapshot.expires_at_ms,
      }),
      "utf8",
    );
    if (
      snapshot.members.length > this.#maxMembers ||
      snapshot.estimated_bytes > this.#maxBytes
    ) {
      throw new WorkbenchSnapshotCapacityError();
    }
    this.#evictUntilFits(snapshot);
    this.#snapshots.set(snapshotId, snapshot);
    this.#retainedMembers += snapshot.members.length;
    this.#retainedBytes += snapshot.estimated_bytes;
    return this.#page(snapshot, 0);
  }

  #read(
    sessionId: string,
    cursor: WorkbenchOpaqueCursor,
    queryHash: CanonicalHash,
  ):
    | { status: "ready"; page: WorkbenchSnapshotPage }
    | { status: "stale"; reason_code: WorkbenchSnapshotStaleReason } {
    this.#assertOpen();
    const parsed = this.#decode(cursor);
    if (parsed === null) {
      return { status: "stale", reason_code: "CURSOR_INVALID" };
    }
    if (parsed.payload.instance_hash !== this.#instanceHash) {
      return { status: "stale", reason_code: "SNAPSHOT_RESTARTED" };
    }
    if (!this.#verify(parsed.payload, parsed.mac)) {
      return { status: "stale", reason_code: "CURSOR_INVALID" };
    }
    const now = this.#clock();
    if (parsed.payload.expires_at_ms <= now) {
      this.#expire();
      return { status: "stale", reason_code: "SNAPSHOT_EXPIRED" };
    }
    if (
      parsed.payload.session_hash !== this.#identityHash("session", sessionId) ||
      parsed.payload.query_hash !== queryHash
    ) {
      return { status: "stale", reason_code: "CURSOR_INVALID" };
    }
    const snapshot = this.#snapshots.get(parsed.payload.snapshot_id);
    if (snapshot === undefined) {
      return { status: "stale", reason_code: "SNAPSHOT_EVICTED" };
    }
    if (
      snapshot.session_id !== sessionId ||
      snapshot.query_hash !== queryHash ||
      snapshot.expires_at_ms !== parsed.payload.expires_at_ms ||
      parsed.payload.offset <= 0 ||
      parsed.payload.offset >= snapshot.members.length
    ) {
      return { status: "stale", reason_code: "CURSOR_INVALID" };
    }
    return { status: "ready", page: this.#page(snapshot, parsed.payload.offset) };
  }

  #page(snapshot: Snapshot, offset: number): WorkbenchSnapshotPage {
    const nextOffset = offset + snapshot.page_size;
    return {
      members: snapshot.members.slice(offset, nextOffset),
      next_cursor:
        nextOffset < snapshot.members.length
          ? this.#encode({
              version: 1,
              instance_hash: this.#instanceHash,
              session_hash: this.#identityHash("session", snapshot.session_id),
              snapshot_id: snapshot.snapshot_id,
              query_hash: snapshot.query_hash,
              offset: nextOffset,
              expires_at_ms: snapshot.expires_at_ms,
            })
          : null,
      retained_count: snapshot.members.length,
      omitted_count: snapshot.omitted_count,
      snapshot_expires_at: new Date(snapshot.expires_at_ms).toISOString(),
    };
  }

  #evictUntilFits(snapshot: Snapshot): void {
    const ordered = (): Snapshot[] =>
      [...this.#snapshots.values()].sort(
        (left, right) =>
          left.created_at_ms - right.created_at_ms ||
          left.snapshot_id.localeCompare(right.snapshot_id),
      );
    while (
      this.#snapshots.size + 1 > this.#maxSnapshots ||
      this.#retainedMembers + snapshot.members.length > this.#maxMembers ||
      this.#retainedBytes + snapshot.estimated_bytes > this.#maxBytes
    ) {
      const oldest = ordered()[0];
      if (oldest === undefined) {
        throw new WorkbenchSnapshotCapacityError();
      }
      this.#remove(oldest.snapshot_id);
    }
  }

  #expire(): void {
    const now = this.#clock();
    for (const snapshot of this.#snapshots.values()) {
      if (snapshot.expires_at_ms <= now) {
        this.#remove(snapshot.snapshot_id);
      }
    }
  }

  #remove(snapshotId: string): void {
    const snapshot = this.#snapshots.get(snapshotId);
    if (snapshot === undefined) {
      return;
    }
    this.#snapshots.delete(snapshotId);
    this.#retainedMembers -= snapshot.members.length;
    this.#retainedBytes -= snapshot.estimated_bytes;
  }

  #encode(payloadInput: CursorPayload): WorkbenchOpaqueCursor {
    const payload = CursorPayloadSchema.parse(payloadInput);
    const envelope = {
      payload,
      mac: this.#mac(payload).toString("base64url"),
    };
    return WorkbenchOpaqueCursorSchema.parse(
      `wbcur1_${Buffer.from(canonicalJson(envelope), "utf8").toString("base64url")}`,
    );
  }

  #decode(cursor: WorkbenchOpaqueCursor): z.infer<typeof CursorEnvelopeSchema> | null {
    const exact = WorkbenchOpaqueCursorSchema.safeParse(cursor);
    if (!exact.success) {
      return null;
    }
    try {
      const raw = Buffer.from(exact.data.slice("wbcur1_".length), "base64url");
      if (raw.byteLength > 4_096) {
        return null;
      }
      return CursorEnvelopeSchema.parse(JSON.parse(raw.toString("utf8")) as unknown);
    } catch {
      return null;
    }
  }

  #verify(payload: CursorPayload, macInput: string): boolean {
    const expected = this.#mac(payload);
    const actual = Buffer.from(macInput, "base64url");
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  #mac(payload: CursorPayload): Buffer {
    return createHmac("sha256", this.#signingKey)
      .update("memo-graph/workbench-cursor/v1\0")
      .update(canonicalJson(payload))
      .digest();
  }

  #identityHash(kind: "instance" | "session", value: string): CanonicalHash {
    return CanonicalHashSchema.parse(
      canonicalSha256({
        domain: `memo-graph/workbench-cursor-${kind}/v1`,
        value,
      }),
    );
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("snapshot registry is closed");
    }
  }
}

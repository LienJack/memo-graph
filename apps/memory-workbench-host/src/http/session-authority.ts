import {
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

import {
  WorkbenchBrowserSessionSchema,
  type WorkbenchBrowserSession,
} from "@memo-graph/contracts";
import { z } from "zod";

const RawAuthoritySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const PairingCodeSchema = z.string().regex(/^[A-Z2-9]{12}$/u);
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type PendingAuthority = {
  expiresAtMs: number;
  createdAtMs: number;
};

type BrowserSessionRecord = PendingAuthority & {
  sessionId: string;
};

function evictOldest<T extends PendingAuthority>(
  entries: Map<string, T>,
  maximum: number,
): void {
  while (entries.size >= maximum) {
    const oldest = [...entries.entries()].sort(
      ([leftKey, left], [rightKey, right]) =>
        left.createdAtMs - right.createdAtMs ||
        leftKey.localeCompare(rightKey),
    )[0];
    if (oldest === undefined) {
      return;
    }
    entries.delete(oldest[0]);
  }
}

export class WorkbenchSessionAuthority {
  readonly #instanceId: string;
  readonly #key = randomBytes(32);
  readonly #clock: () => number;
  readonly #ticketTtlMs: number;
  readonly #pairingTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #tickets = new Map<string, PendingAuthority>();
  readonly #pairingCodes = new Map<string, PendingAuthority>();
  readonly #sessions = new Map<string, BrowserSessionRecord>();
  #closed = false;

  constructor(options: {
    instanceId: string;
    clock?: () => number;
    ticketTtlMs?: number;
    pairingTtlMs?: number;
    sessionTtlMs?: number;
  }) {
    this.#instanceId = z.string().min(1).max(160).parse(options.instanceId);
    this.#clock = options.clock ?? Date.now;
    this.#ticketTtlMs = z.number().int().min(1_000).max(5 * 60_000)
      .parse(options.ticketTtlMs ?? 60_000);
    this.#pairingTtlMs = z.number().int().min(1_000).max(10 * 60_000)
      .parse(options.pairingTtlMs ?? 2 * 60_000);
    this.#sessionTtlMs = z.number().int().min(10_000).max(24 * 60 * 60_000)
      .parse(options.sessionTtlMs ?? 30 * 60_000);
  }

  issueTicket(): { ticket: string; expires_at: string } {
    this.#assertOpen();
    this.#expire();
    evictOldest(this.#tickets, 64);
    const ticket = randomBytes(32).toString("base64url");
    const now = this.#clock();
    const expiresAt = now + this.#ticketTtlMs;
    this.#tickets.set(this.#digest("ticket", ticket), {
      createdAtMs: now,
      expiresAtMs: expiresAt,
    });
    return { ticket, expires_at: new Date(expiresAt).toISOString() };
  }

  issuePairingCode(): { code: string; expires_at: string } {
    this.#assertOpen();
    this.#expire();
    evictOldest(this.#pairingCodes, 16);
    let code = "";
    for (const byte of randomBytes(12)) {
      code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
    }
    const exact = PairingCodeSchema.parse(code);
    const now = this.#clock();
    const expiresAt = now + this.#pairingTtlMs;
    this.#pairingCodes.set(this.#digest("pairing", exact), {
      createdAtMs: now,
      expiresAtMs: expiresAt,
    });
    return { code: exact, expires_at: new Date(expiresAt).toISOString() };
  }

  exchangeTicket(input: {
    instanceId: string;
    ticket: string;
  }): WorkbenchBrowserSession | null {
    return this.#exchange("ticket", input.instanceId, input.ticket);
  }

  exchangePairingCode(input: {
    instanceId: string;
    code: string;
  }): WorkbenchBrowserSession | null {
    const code = PairingCodeSchema.safeParse(input.code.toUpperCase());
    if (!code.success) {
      return null;
    }
    return this.#exchange("pairing", input.instanceId, code.data);
  }

  authenticateBearer(rawBearer: string): { session_id: string } | null {
    if (this.#closed) {
      return null;
    }
    const bearer = RawAuthoritySchema.safeParse(rawBearer);
    if (!bearer.success) {
      return null;
    }
    this.#expire();
    const record = this.#sessions.get(this.#digest("bearer", bearer.data));
    return record === undefined ? null : { session_id: record.sessionId };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#tickets.clear();
    this.#pairingCodes.clear();
    this.#sessions.clear();
    this.#key.fill(0);
  }

  #exchange(
    kind: "ticket" | "pairing",
    instanceId: string,
    raw: string,
  ): WorkbenchBrowserSession | null {
    this.#assertOpen();
    this.#expire();
    if (instanceId !== this.#instanceId) {
      return null;
    }
    const entries = kind === "ticket" ? this.#tickets : this.#pairingCodes;
    const digest = this.#digest(kind, raw);
    const pending = entries.get(digest);
    entries.delete(digest);
    if (pending === undefined || pending.expiresAtMs <= this.#clock()) {
      return null;
    }
    evictOldest(this.#sessions, 64);
    const bearer = randomBytes(32).toString("base64url");
    const sessionId = `browser:${randomUUID()}`;
    const now = this.#clock();
    const expiresAt = now + this.#sessionTtlMs;
    this.#sessions.set(this.#digest("bearer", bearer), {
      sessionId,
      createdAtMs: now,
      expiresAtMs: expiresAt,
    });
    return WorkbenchBrowserSessionSchema.parse({
      schema_version: "1.0.0",
      instance_id: this.#instanceId,
      session_id: sessionId,
      bearer,
      expires_at: new Date(expiresAt).toISOString(),
    });
  }

  #expire(): void {
    const now = this.#clock();
    for (const entries of [
      this.#tickets,
      this.#pairingCodes,
      this.#sessions,
    ]) {
      for (const [key, value] of entries) {
        if (value.expiresAtMs <= now) {
          entries.delete(key);
        }
      }
    }
  }

  #digest(audience: string, raw: string): string {
    return createHmac("sha256", this.#key)
      .update(`memo-graph/workbench-${audience}/v1\0`)
      .update(raw)
      .digest("hex");
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("workbench session authority is closed");
    }
  }
}

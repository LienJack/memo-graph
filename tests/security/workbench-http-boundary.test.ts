import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkbenchControlProof,
  startWorkbenchHttpServer,
  WorkbenchSessionAuthority,
  type WorkbenchHttpServer,
} from "../../apps/memory-workbench-host/src/index.js";
import { blockedOperationalStatus } from "@memo-graph/storage-sqlite";

const INSTANCE = "workbench:test-instance";
const servers: WorkbenchHttpServer[] = [];

async function server(options: {
  runtimeState?: "ready" | "health_only";
  controlCredential?: Buffer;
  maxConnections?: number;
} = {}) {
  const controlCredential = options.controlCredential ?? randomBytes(32);
  const started = await startWorkbenchHttpServer({
    instanceId: INSTANCE,
    runtimeState: options.runtimeState ?? "ready",
    controlCredential,
    ...(options.maxConnections === undefined
      ? {}
      : { maxConnections: options.maxConnections }),
    health: async () =>
      blockedOperationalStatus(new Error("fixture unavailable"), {
        observedAt: "2026-08-02T08:00:00.000Z",
      }),
  });
  servers.push(started);
  return { started, controlCredential };
}

async function postJson(
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server_) => server_.close()));
});

describe("workbench loopback HTTP boundary", () => {
  it("serves only the allowlisted local fixture with hardening headers", async () => {
    const { started } = await server();
    const response = await fetch(`${started.origin}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(html).toContain('src="/bootstrap.js"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
    expect(html).not.toContain("https://");
    expect(await fetch(`${started.origin}/../secret`)).toMatchObject({
      status: 404,
    });
    expect(
      await fetch(`${started.origin}/%2e%2e/secret`),
    ).toMatchObject({ status: 404 });
  });

  it("requires an authenticated one-use operator control request", async () => {
    const { started, controlCredential } = await server();
    const body = { mode: "ticket" } as const;
    const nonce = randomBytes(24).toString("base64url");
    const proof = createWorkbenchControlProof({
      credential: controlCredential,
      instanceId: INSTANCE,
      origin: started.origin,
      nonce,
      body,
    });
    const headers = {
      "x-memo-control-nonce": nonce,
      "x-memo-control-proof": proof,
      "x-memo-instance": INSTANCE,
    };
    const issued = await fetch(`${started.origin}/__operator/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({
      instance_id: INSTANCE,
      ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      pairing_code: null,
    });

    const replay = await fetch(`${started.origin}/__operator/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(403);
    expect(
      await postJson(started.origin, "/__operator/bootstrap", body),
    ).toMatchObject({ status: 403 });
  });

  it("exchanges browser authority once and keeps cookies, stale instances, and cross-site calls out", async () => {
    const { started, controlCredential } = await server();
    const issued = started.sessions.issueTicket();
    const exchange = await postJson(started.origin, "/api/session/exchange", {
      instance_id: INSTANCE,
      ticket: issued.ticket,
    });
    expect(exchange.status).toBe(200);
    const session = await exchange.json() as {
      bearer: string;
      instance_id: string;
    };
    expect(session.instance_id).toBe(INSTANCE);

    expect(
      await postJson(started.origin, "/api/session/exchange", {
        instance_id: INSTANCE,
        ticket: issued.ticket,
      }),
    ).toMatchObject({ status: 401 });
    const health = await fetch(`${started.origin}/api/health`, {
      headers: {
        authorization: `Bearer ${session.bearer}`,
        "x-memo-graph-instance": INSTANCE,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(health.status).toBe(200);
    expect(JSON.stringify(await health.json())).not.toContain(
      controlCredential.toString("base64url"),
    );
    expect(
      await fetch(`${started.origin}/api/health`, {
        headers: {
          cookie: `session=${session.bearer}`,
          "x-memo-graph-instance": INSTANCE,
          "sec-fetch-site": "same-origin",
        },
      }),
    ).toMatchObject({ status: 401 });
    expect(
      await fetch(`${started.origin}/api/health`, {
        headers: {
          authorization: `Bearer ${session.bearer}`,
          "x-memo-graph-instance": "workbench:stale",
          "sec-fetch-site": "same-origin",
        },
      }),
    ).toMatchObject({ status: 401 });
    expect(
      await fetch(`${started.origin}/api/health`, {
        headers: {
          authorization: `Bearer ${controlCredential.toString("base64url")}`,
          "x-memo-graph-instance": INSTANCE,
          "sec-fetch-site": "same-origin",
        },
      }),
    ).toMatchObject({ status: 401 });
    expect(
      await fetch(`${started.origin}/api/session/pair`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "null",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ instance_id: INSTANCE, code: "AAAAAAAAAAAA" }),
      }),
    ).toMatchObject({ status: 403 });
  });

  it("rejects rebinding hosts, duplicate Host, form bodies, oversized bodies, and unknown methods", async () => {
    const { started } = await server();
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        started.origin,
        { path: "/", headers: { host: `localhost:${started.port}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(wrongHost).toBe(421);

    const duplicateHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        started.origin,
        {
          path: "/",
          headers: [
            "Host",
            `127.0.0.1:${started.port}`,
            "Host",
            `127.0.0.1:${started.port}`,
          ],
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect([400, 421]).toContain(duplicateHost);

    expect(
      await fetch(`${started.origin}/api/session/exchange`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: started.origin,
          "sec-fetch-site": "same-origin",
        },
        body: "ticket=unsafe",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await postJson(started.origin, "/api/session/exchange", {
        padding: "x".repeat(9 * 1024),
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await fetch(`${started.origin}/`, { method: "DELETE" }),
    ).toMatchObject({ status: 405 });
  });

  it("keeps blocked Runtime content routes unavailable instead of empty", async () => {
    const { started } = await server({ runtimeState: "health_only" });
    const ticket = started.sessions.issueTicket();
    const exchange = await postJson(started.origin, "/api/session/exchange", {
      instance_id: INSTANCE,
      ticket: ticket.ticket,
    });
    const session = await exchange.json() as { bearer: string };
    const headers = {
      authorization: `Bearer ${session.bearer}`,
      "x-memo-graph-instance": INSTANCE,
      "sec-fetch-site": "same-origin",
    };
    expect(
      await fetch(`${started.origin}/api/health`, { headers }),
    ).toMatchObject({ status: 200 });
    const memories = await fetch(`${started.origin}/api/memories`, { headers });
    expect(memories.status).toBe(503);
    expect(await memories.json()).toEqual({ code: "RUNTIME_BLOCKED" });
  });

  it("expires and consumes pairing codes without retaining raw authority", () => {
    let now = Date.parse("2026-08-02T08:00:00.000Z");
    const authority = new WorkbenchSessionAuthority({
      instanceId: INSTANCE,
      clock: () => now,
      pairingTtlMs: 1_000,
    });
    const first = authority.issuePairingCode();
    expect(
      authority.exchangePairingCode({ instanceId: INSTANCE, code: first.code }),
    ).not.toBeNull();
    expect(
      authority.exchangePairingCode({ instanceId: INSTANCE, code: first.code }),
    ).toBeNull();
    const expired = authority.issuePairingCode();
    now += 1_001;
    expect(
      authority.exchangePairingCode({ instanceId: INSTANCE, code: expired.code }),
    ).toBeNull();
    authority.close();
  });

  it("bounds incomplete loopback connections", async () => {
    const { started } = await server({ maxConnections: 2 });
    const first = connect(started.port, "127.0.0.1");
    const second = connect(started.port, "127.0.0.1");
    await Promise.all([
      new Promise<void>((resolve) => first.once("connect", resolve)),
      new Promise<void>((resolve) => second.once("connect", resolve)),
    ]);
    const third = connect(started.port, "127.0.0.1");
    const closed = await new Promise<boolean>((resolve) => {
      third.once("close", () => resolve(true));
      third.once("error", () => resolve(true));
      setImmediate(() => resolve(third.destroyed));
    });
    expect(closed || started.sockets.size <= 2).toBe(true);
    first.destroy();
    second.destroy();
    third.destroy();
  });
});

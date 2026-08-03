import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkbenchControlProof,
  loadWorkbenchWebAssets,
  startWorkbenchHttpServer,
  workbenchHealth,
  WorkbenchSessionAuthority,
  type WorkbenchHttpServer,
  type WorkbenchWebAssets,
} from "../../apps/memory-workbench-host/src/index.js";
import { blockedOperationalStatus } from "@memo-graph/storage-sqlite";

const INSTANCE = "workbench:test-instance";
const servers: WorkbenchHttpServer[] = [];
const temporaryDirectories: string[] = [];

async function server(options: {
  runtimeState?: "ready" | "health_only";
  controlCredential?: Buffer;
  hookCredential?: Buffer;
  hookCapture?: Parameters<
    typeof startWorkbenchHttpServer
  >[0]["hookCapture"];
  maxConnections?: number;
  workbenchSession?: Parameters<
    typeof startWorkbenchHttpServer
  >[0]["workbenchSession"];
  webAssets?: WorkbenchWebAssets;
} = {}) {
  const controlCredential = options.controlCredential ?? randomBytes(32);
  const started = await startWorkbenchHttpServer({
    instanceId: INSTANCE,
    runtimeState: options.runtimeState ?? "ready",
    controlCredential,
    ...(options.hookCredential === undefined
      ? {}
      : { hookCredential: options.hookCredential }),
    ...(options.hookCapture === undefined
      ? {}
      : { hookCapture: options.hookCapture }),
    ...(options.maxConnections === undefined
      ? {}
      : { maxConnections: options.maxConnections }),
    ...(options.workbenchSession === undefined
      ? {}
      : { workbenchSession: options.workbenchSession }),
    ...(options.webAssets === undefined
      ? {}
      : { webAssets: options.webAssets }),
    health: async () =>
      workbenchHealth({
        runtimeState: options.runtimeState ?? "ready",
        operational: blockedOperationalStatus(new Error("fixture unavailable"), {
          observedAt: "2026-08-02T08:00:00.000Z",
        }),
        lifecycle: options.runtimeState === "health_only" ? null : "ready",
        background: [],
        graph: null,
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
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workbench loopback HTTP boundary", () => {
  it("rejects an instance identity that could escape the HTML boundary", async () => {
    await expect(
      startWorkbenchHttpServer({
        instanceId: '"><script>unsafe</script>',
        runtimeState: "ready",
        controlCredential: randomBytes(32),
        health: async () =>
          workbenchHealth({
            runtimeState: "ready",
            operational: blockedOperationalStatus(new Error("fixture")),
            lifecycle: "ready",
            background: [],
            graph: null,
            observedAt: "2026-08-02T08:00:00.000Z",
          }),
      }),
    ).rejects.toThrow("WORKBENCH_INSTANCE_INVALID");
  });

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

  it("serves the packaged SPA from an exact map-free allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "memo-graph-workbench-assets-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
    );
    writeFileSync(join(root, "assets", "app.js"), "export const ready=true;");
    writeFileSync(join(root, "assets", "app.js.map"), "sensitive source map");
    writeFileSync(join(root, "assets", "app.css"), "body{color:#171815}");
    writeFileSync(join(root, "assets", "app.woff2"), Buffer.from([0, 1, 2]));
    const assets = loadWorkbenchWebAssets(root);
    const { started } = await server({ webAssets: assets });

    const index = await fetch(`${started.origin}/`);
    const html = await index.text();
    expect(index.status).toBe(200);
    expect(index.headers.get("content-security-policy")).toContain(
      "font-src 'self'",
    );
    expect(html).toContain(`data-instance="${INSTANCE}"`);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
    expect(html).not.toMatch(/https?:\/\//u);

    expect(await fetch(`${started.origin}/assets/app.js`)).toMatchObject({
      status: 200,
    });
    expect(await fetch(`${started.origin}/assets/app.css`)).toMatchObject({
      status: 200,
    });
    expect(await fetch(`${started.origin}/assets/app.woff2`)).toMatchObject({
      status: 200,
    });
    for (const path of [
      "/assets/app.js.map",
      "/assets/unlisted.js",
      "/bootstrap.js",
      "/fixture.css",
    ]) {
      expect(await fetch(`${started.origin}${path}`)).toMatchObject({
        status: 404,
      });
    }

    const ticket = started.sessions.issueTicket();
    const exchange = await postJson(started.origin, "/api/session/exchange", {
      instance_id: INSTANCE,
      ticket: ticket.ticket,
    });
    const session = await exchange.json() as { bearer: string };
    expect(
      await fetch(`${started.origin}/api/health`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.bearer}`,
          "x-memo-graph-instance": INSTANCE,
          origin: started.origin,
          "sec-fetch-site": "same-origin",
        },
      }),
    ).toMatchObject({ status: 405 });
  });

  it("requires an authenticated one-use operator control request", async () => {
    const { started, controlCredential } = await server();
    const body = {};
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

  it("isolates a bounded non-browser hook ingress behind its own credential", async () => {
    const hookCredential = randomBytes(32);
    const captured: unknown[] = [];
    const { started, controlCredential } = await server({
      hookCredential,
      hookCapture: async (input) => {
        captured.push(input);
        return {
          schema_version: "1.0.0",
          status: "accepted",
          event_id: "hook:event-1",
          additional_context: null,
        };
      },
    });
    const body = {
      schema_version: "1.0.0",
      source: "direct",
      idempotency_key: "hook-capture-event-0001",
      event: {
        schema_version: "1.0.0",
        event_id: "hook:event-1",
        event_kind: "session_start",
        session_id: "thr_123",
        cwd: "/workspace",
        occurred_at: "2026-08-03T08:00:00.000Z",
        model: null,
        source: "startup",
      },
    };
    const invoke = (credential: Buffer, origin?: string) =>
      fetch(`${started.origin}/__hooks/capture`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.toString("base64url")}`,
          "content-type": "application/json",
          ...(origin === undefined ? {} : { origin }),
        },
        body: JSON.stringify(body),
      });

    expect(await invoke(controlCredential)).toMatchObject({ status: 403 });
    expect(await invoke(hookCredential, started.origin)).toMatchObject({
      status: 403,
    });
    const accepted = await invoke(hookCredential);
    const acceptedBody = await accepted.json();
    expect(accepted.status, JSON.stringify(acceptedBody)).toBe(200);
    expect(acceptedBody).toMatchObject({
      status: "accepted",
      event_id: "hook:event-1",
    });
    expect(captured).toHaveLength(1);
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
          authorization: `Bearer ${session.bearer}`,
          "x-memo-graph-instance": INSTANCE,
          origin: started.origin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ instance_id: INSTANCE, code: "AAAAAAAAAAAA" }),
      }),
    ).toMatchObject({ status: 404 });
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

  it("routes governed reads and corrections only through the bearer session", async () => {
    const calls: { sessionId: string; operation: string; body: unknown }[] = [];
    const { started } = await server({
      workbenchSession: (sessionId) => ({
        list: async (body) => {
          calls.push({ sessionId, operation: "list", body });
          return {
            status: "ready_empty",
            items: [],
            page: null,
            excluded_count: 0,
            reason_codes: [],
            warnings: [],
          };
        },
        detail: async (body) => {
          calls.push({ sessionId, operation: "detail", body });
          return { status: "not_found", reason_code: "NOT_FOUND" };
        },
        graph: async (body) => {
          calls.push({ sessionId, operation: "graph", body });
          return { status: "not_found", reason_code: "NOT_FOUND" };
        },
        automaticMemory: async (body) => {
          calls.push({ sessionId, operation: "automatic", body });
          return { status: "ready_empty", items: [], warnings: [] };
        },
        previewAutomaticMemoryUndo: async (body) => {
          calls.push({ sessionId, operation: "automatic-undo-preview", body });
          return { status: "failed", reason_code: "FIXTURE" };
        },
        confirmAutomaticMemoryUndo: async (body) => {
          calls.push({ sessionId, operation: "automatic-undo-confirm", body });
          return { status: "failed", reason_code: "FIXTURE" };
        },
        previewCorrection: async (body) => {
          calls.push({ sessionId, operation: "preview", body });
          return { status: "failed", reason_code: "FIXTURE" };
        },
        confirmCorrection: async (body) => {
          calls.push({ sessionId, operation: "confirm", body });
          return { status: "failed", reason_code: "FIXTURE" };
        },
      }),
    });
    const ticket = started.sessions.issueTicket();
    const exchange = await postJson(started.origin, "/api/session/exchange", {
      instance_id: INSTANCE,
      ticket: ticket.ticket,
    });
    const session = await exchange.json() as { bearer: string };
    const authorityHeaders = {
      authorization: `Bearer ${session.bearer}`,
      "x-memo-graph-instance": INSTANCE,
    };
    const query = await postJson(
      started.origin,
      "/api/workbench/memories/query",
      { include_non_current: false },
      authorityHeaders,
    );
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({ status: "ready_empty" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: "list",
      body: { include_non_current: false },
    });
    expect(calls[0]?.sessionId).toMatch(/^browser:/u);

    const boundedDraft = await postJson(
      started.origin,
      "/api/workbench/corrections/preview",
      {
        memory_id: "memory:test",
        expected_revision_id: "revision:test",
        replacement: { text: "x".repeat(10 * 1024) },
        reason: "bounded correction payload",
      },
      authorityHeaders,
    );
    expect(boundedDraft.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: "preview" });
    expect(
      await postJson(
        started.origin,
        "/api/workbench/corrections/preview",
        {
          memory_id: "memory:test",
          expected_revision_id: "revision:test",
          replacement: { text: "x".repeat(2 * 1024 * 1024) },
          reason: "payload beyond the host boundary",
        },
        authorityHeaders,
      ),
    ).toMatchObject({ status: 400 });
    expect(calls).toHaveLength(2);

    expect(
      await postJson(
        started.origin,
        "/api/workbench/corrections/confirm",
        { preview_id: "workbench-preview:test", confirmed: true },
      ),
    ).toMatchObject({ status: 401 });
    expect(calls).toHaveLength(2);
  });

  it("expires and consumes launch tickets without retaining raw authority", () => {
    let now = Date.parse("2026-08-02T08:00:00.000Z");
    const authority = new WorkbenchSessionAuthority({
      instanceId: INSTANCE,
      clock: () => now,
      ticketTtlMs: 1_000,
    });
    const first = authority.issueTicket();
    expect(
      authority.exchangeTicket({ instanceId: INSTANCE, ticket: first.ticket }),
    ).not.toBeNull();
    expect(
      authority.exchangeTicket({ instanceId: INSTANCE, ticket: first.ticket }),
    ).toBeNull();
    const expired = authority.issueTicket();
    now += 1_001;
    expect(
      authority.exchangeTicket({ instanceId: INSTANCE, ticket: expired.ticket }),
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

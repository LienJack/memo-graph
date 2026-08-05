import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  WorkbenchHealthResultSchema,
  AutomaticMemoryHookCaptureRequestSchema,
  AutomaticMemoryHookCaptureResponseSchema,
  WorkbenchControlBootstrapRequestSchema,
  WorkbenchControlBootstrapResponseSchema,
  WorkbenchTicketExchangeSchema,
  canonicalJson,
  type WorkbenchHealthResult,
  type WorkbenchBrowserSession,
  type AutomaticMemoryHookCaptureRequest,
  type AutomaticMemoryHookCaptureResponse,
} from "@memo-graph/contracts";

import {
  workbenchControlProofMatches,
} from "./control-auth.js";
import { WorkbenchSessionAuthority } from "./session-authority.js";
import {
  workbenchIndexHtml,
  type WorkbenchWebAssets,
} from "./web-assets.js";

const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_HOOK_BODY_BYTES = 80 * 1024;
const MAX_CORRECTION_DRAFT_BYTES = 2 * 1024 * 1024;
const SECURITY_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>记忆工作台</title>
  <link rel="stylesheet" href="/fixture.css">
</head>
<body>
  <main>
    <p class="eyebrow">MEMO GRAPH</p>
    <h1>记忆工作台</h1>
    <p id="status" role="status">正在建立本地安全会话…</p>
  </main>
  <script type="module" src="/bootstrap.js"></script>
</body>
</html>`;

const FIXTURE_CSS = `:root{color-scheme:light;font-family:ui-sans-serif,system-ui,sans-serif;background:#f4f4f0;color:#171815}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(38rem,calc(100% - 3rem));border:1px solid #d8d8d0;background:#fff;padding:3rem;box-shadow:0 18px 45px rgba(20,22,18,.08)}.eyebrow{font:600 .75rem ui-monospace,monospace;letter-spacing:.14em;color:#68705e}h1{font-size:clamp(2rem,7vw,4.5rem);line-height:.95;margin:1rem 0}`;

const BOOTSTRAP_JS = `const statusNode=document.querySelector('#status');const fragment=new URLSearchParams(location.hash.slice(1));const ticket=fragment.get('ticket');const instance=fragment.get('instance');history.replaceState(null,'',location.pathname+location.search);async function exchange(body,path){const response=await fetch(path||'/api/session/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error('SESSION_EXCHANGE_FAILED');const session=await response.json();globalThis.__MEMO_GRAPH_SESSION__=session;globalThis.dispatchEvent(new CustomEvent('memo-graph-session',{detail:session}));statusNode.textContent='本地安全会话已建立。';}if(ticket&&instance){exchange({ticket,instance_id:instance}).catch(()=>{statusNode.textContent='启动链接无效或已过期，请重新运行工作台命令。';});}else{exchange({},'/api/session/auto').catch(()=>{statusNode.textContent='无法建立本地会话，请重新运行工作台命令。';});}`;

type FixedWindow = { startedAtMs: number; count: number };

type WorkbenchRequestService = {
  list(input: unknown): Promise<unknown>;
  detail(input: unknown): Promise<unknown>;
  graph(input: unknown): Promise<unknown>;
  automaticMemory(input: unknown): Promise<unknown>;
  previewAutomaticMemoryUndo(input: unknown): Promise<unknown>;
  confirmAutomaticMemoryUndo(input: unknown): Promise<unknown>;
  previewCorrection(input: unknown): Promise<unknown>;
  confirmCorrection(input: unknown): Promise<unknown>;
};

const WORKBENCH_ROUTES = {
  "/api/workbench/memories/query": "list",
  "/api/workbench/memories/detail": "detail",
  "/api/workbench/graph/query": "graph",
  "/api/workbench/automatic-memory/query": "automaticMemory",
  "/api/workbench/automatic-memory/undo/preview": "previewAutomaticMemoryUndo",
  "/api/workbench/automatic-memory/undo/confirm": "confirmAutomaticMemoryUndo",
  "/api/workbench/corrections/preview": "previewCorrection",
  "/api/workbench/corrections/confirm": "confirmCorrection",
} as const satisfies Record<string, keyof WorkbenchRequestService>;

function writeResponse(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  extraHeaders: Record<string, string> = {},
): void {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    "content-type": contentType,
    "content-length": String(bytes.byteLength),
  });
  response.end(bytes);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  writeResponse(
    response,
    status,
    "application/json; charset=utf-8",
    `${canonicalJson(body)}\n`,
  );
}

function safePath(request: IncomingMessage, origin: string): string | null {
  const raw = request.url ?? "";
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    /%(?:2e|2f|5c)/iu.test(raw)
  ) {
    return null;
  }
  try {
    const parsed = new URL(raw, origin);
    return parsed.origin === origin && parsed.search === ""
      ? parsed.pathname
      : null;
  } catch {
    return null;
  }
}

function exactHost(request: IncomingMessage, expectedHost: string): boolean {
  const hosts: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) {
        hosts.push(value);
      }
    }
  }
  return hosts.length === 1 && hosts[0] === expectedHost;
}

function sameOriginBrowserRequest(
  request: IncomingMessage,
  origin: string,
  requireOrigin: boolean,
): boolean {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    return false;
  }
  const requestOrigin = request.headers.origin;
  return requireOrigin
    ? requestOrigin === origin
    : requestOrigin === undefined || requestOrigin === origin;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]
    ?.trim().toLowerCase();
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (
    contentType !== "application/json" ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    contentLength > maxBytes
  ) {
    throw new Error("INVALID_HTTP_BODY");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maxBytes) {
      throw new Error("INVALID_HTTP_BODY");
    }
    chunks.push(bytes);
  }
  if (length !== contentLength) {
    throw new Error("INVALID_HTTP_BODY");
  }
  return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
}

function bearer(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    return null;
  }
  return value.slice("Bearer ".length);
}

function hookCredentialMatches(
  request: IncomingMessage,
  expected: Buffer,
): boolean {
  const encoded = bearer(request);
  if (encoded === null || !/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
    return false;
  }
  const candidate = Buffer.from(encoded, "base64url");
  try {
    return candidate.byteLength === expected.byteLength &&
      timingSafeEqual(candidate, expected);
  } finally {
    candidate.fill(0);
  }
}

export type WorkbenchHttpServer = {
  origin: string;
  port: number;
  sessions: WorkbenchSessionAuthority;
  sockets: ReadonlySet<Socket>;
  close(): Promise<void>;
};

export async function startWorkbenchHttpServer(options: {
  instanceId: string;
  runtimeState: "ready" | "health_only";
  controlCredential: Buffer;
  hookCredential?: Buffer;
  hookCapture?: (
    input: AutomaticMemoryHookCaptureRequest,
  ) => Promise<AutomaticMemoryHookCaptureResponse>;
  health(): Promise<WorkbenchHealthResult>;
  workbenchSession?: (sessionId: string) => WorkbenchRequestService;
  webAssets?: WorkbenchWebAssets;
  port?: number;
  clock?: () => number;
  maxConnections?: number;
}): Promise<WorkbenchHttpServer> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(options.instanceId)) {
    throw new Error("WORKBENCH_INSTANCE_INVALID");
  }
  const clock = options.clock ?? Date.now;
  const sessions = new WorkbenchSessionAuthority({
    instanceId: options.instanceId,
    clock,
  });
  const maxConnections = options.maxConnections ?? 64;
  const controlNonces = new Map<string, number>();
  const browserBootstrapWindow: FixedWindow = {
    startedAtMs: clock(),
    count: 0,
  };
  const operatorControlWindow: FixedWindow = {
    startedAtMs: clock(),
    count: 0,
  };
  const hookIngressWindow: FixedWindow = {
    startedAtMs: clock(),
    count: 0,
  };
  const authenticatedWindows = new Map<string, FixedWindow>();
  const sockets = new Set<Socket>();
  let activeRequests = 0;
  let origin = "";
  let expectedHost = "";

  const rateAllowed = (
    window: FixedWindow,
    limit: number,
    durationMs = 10_000,
  ): boolean => {
    const now = clock();
    if (now - window.startedAtMs >= durationMs) {
      window.startedAtMs = now;
      window.count = 0;
    }
    window.count += 1;
    return window.count <= limit;
  };

  const server = createServer(async (request, response) => {
    activeRequests += 1;
    response.once("close", () => {
      activeRequests = Math.max(0, activeRequests - 1);
    });
    if (!exactHost(request, expectedHost)) {
      writeJson(response, 421, { code: "HOST_HEADER_INVALID" });
      return;
    }
    const path = safePath(request, origin);
    if (path === null) {
      writeJson(response, 404, { code: "ROUTE_NOT_FOUND" });
      return;
    }
    const isHealth = path === "/api/health";
    const isMutation = path === "/api/workbench/corrections/confirm";
    const requestCapacity = isHealth ? 36 : isMutation ? 34 : 32;
    if (activeRequests > requestCapacity) {
      writeJson(response, 503, { code: "REQUEST_CAPACITY_EXCEEDED" });
      return;
    }
    try {
      if (request.method === "GET" && path === "/") {
        writeResponse(
          response,
          200,
          "text/html; charset=utf-8",
          options.webAssets === undefined
            ? FIXTURE_HTML.replace("<html lang=\"zh-CN\">", `<html lang="zh-CN" data-instance="${options.instanceId}">`)
            : workbenchIndexHtml(options.webAssets, options.instanceId),
        );
        return;
      }
      const webAsset = options.webAssets?.assets.get(path);
      if (request.method === "GET" && webAsset !== undefined) {
        writeResponse(response, 200, webAsset.contentType, webAsset.bytes);
        return;
      }
      if (
        options.webAssets === undefined &&
        request.method === "GET" &&
        path === "/bootstrap.js"
      ) {
        writeResponse(response, 200, "text/javascript; charset=utf-8", BOOTSTRAP_JS);
        return;
      }
      if (
        options.webAssets === undefined &&
        request.method === "GET" &&
        path === "/fixture.css"
      ) {
        writeResponse(response, 200, "text/css; charset=utf-8", FIXTURE_CSS);
        return;
      }
      if (
        request.method === "POST" &&
        path === "/api/session/exchange"
      ) {
        if (
          !rateAllowed(browserBootstrapWindow, 20) ||
          !sameOriginBrowserRequest(request, origin, true)
        ) {
          writeJson(response, 403, { code: "BROWSER_ORIGIN_REJECTED" });
          return;
        }
        const body = await readJsonBody(request);
        const parsed = WorkbenchTicketExchangeSchema.parse(body);
        const session: WorkbenchBrowserSession | null = sessions.exchangeTicket({
          instanceId: parsed.instance_id,
          ticket: parsed.ticket,
        });
        if (session === null) {
          writeJson(response, 401, { code: "BROWSER_AUTHORITY_INVALID" });
          return;
        }
        writeJson(response, 200, session);
        return;
      if (
        request.method === "POST" &&
        path === "/api/session/auto"
      ) {
        if (
          !rateAllowed(browserBootstrapWindow, 10) ||
          !sameOriginBrowserRequest(request, origin, true)
        ) {
          writeJson(response, 403, { code: "BROWSER_ORIGIN_REJECTED" });
          return;
        }
        const session = sessions.issueSession();
        writeJson(response, 200, session);
        return;
      }
      }
      if (request.method === "POST" && path === "/__operator/bootstrap") {
        if (
          request.headers.origin !== undefined ||
          !rateAllowed(operatorControlWindow, 20)
        ) {
          writeJson(response, 403, { code: "CONTROL_AUTHORITY_REJECTED" });
          return;
        }
        const body = WorkbenchControlBootstrapRequestSchema.parse(
          await readJsonBody(request),
        );
        const nonce = String(request.headers["x-memo-control-nonce"] ?? "");
        const proof = String(request.headers["x-memo-control-proof"] ?? "");
        const claimedInstance = String(
          request.headers["x-memo-instance"] ?? "",
        );
        const now = clock();
        for (const [seen, expiresAt] of controlNonces) {
          if (expiresAt <= now) {
            controlNonces.delete(seen);
          }
        }
        const valid =
          claimedInstance === options.instanceId &&
          !controlNonces.has(nonce) &&
          workbenchControlProofMatches({
            credential: options.controlCredential,
            instanceId: options.instanceId,
            origin,
            nonce,
            body,
            proof,
          });
        if (!valid) {
          writeJson(response, 403, { code: "CONTROL_AUTHORITY_REJECTED" });
          return;
        }
        if (controlNonces.size >= 128) {
          const oldest = [...controlNonces.entries()].sort(
            ([leftKey, leftExpiry], [rightKey, rightExpiry]) =>
              leftExpiry - rightExpiry || leftKey.localeCompare(rightKey),
          )[0];
          if (oldest !== undefined) {
            controlNonces.delete(oldest[0]);
          }
        }
        controlNonces.set(nonce, now + 2 * 60_000);
        const authority = sessions.issueTicket();
        writeJson(
          response,
          200,
          WorkbenchControlBootstrapResponseSchema.parse({
            schema_version: "1.0.0",
            instance_id: options.instanceId,
            ticket: authority.ticket,
            expires_at: authority.expires_at,
          }),
        );
        return;
      }

      if (request.method === "POST" && path === "/__hooks/capture") {
        if (
          request.headers.origin !== undefined ||
          options.hookCredential === undefined ||
          options.hookCapture === undefined ||
          !rateAllowed(hookIngressWindow, 80) ||
          !hookCredentialMatches(request, options.hookCredential)
        ) {
          writeJson(response, 403, { code: "HOOK_AUTHORITY_REJECTED" });
          return;
        }
        if (options.runtimeState === "health_only") {
          writeJson(response, 503, { code: "RUNTIME_BLOCKED" });
          return;
        }
        const body = AutomaticMemoryHookCaptureRequestSchema.parse(
          await readJsonBody(request, MAX_HOOK_BODY_BYTES),
        );
        try {
          writeJson(
            response,
            200,
            AutomaticMemoryHookCaptureResponseSchema.parse(
              await options.hookCapture(body),
            ),
          );
        } catch {
          writeJson(response, 503, { code: "HOOK_CAPTURE_UNAVAILABLE" });
        }
        return;
      }

      if (path.startsWith("/api/")) {
        if (!sameOriginBrowserRequest(request, origin, false)) {
          writeJson(response, 403, { code: "BROWSER_ORIGIN_REJECTED" });
          return;
        }
        const rawBearer = bearer(request);
        const instance = request.headers["x-memo-graph-instance"];
        const authenticated = rawBearer === null
          ? null
          : sessions.authenticateBearer(rawBearer);
        if (
          authenticated === null ||
          instance !== options.instanceId
        ) {
          writeJson(response, 401, { code: "BROWSER_SESSION_INVALID" });
          return;
        }
        const key = authenticated.session_id;
        const window = authenticatedWindows.get(key) ?? {
          startedAtMs: clock(),
          count: 0,
        };
        authenticatedWindows.set(key, window);
        if (!rateAllowed(window, 120)) {
          writeJson(response, 429, { code: "REQUEST_RATE_EXCEEDED" });
          return;
        }
        if (request.method === "GET" && path === "/api/health") {
          writeJson(
            response,
            200,
            WorkbenchHealthResultSchema.parse(await options.health()),
          );
          return;
        }
        if (options.runtimeState === "health_only") {
          writeJson(response, 503, { code: "RUNTIME_BLOCKED" });
          return;
        }
        const operation = WORKBENCH_ROUTES[
          path as keyof typeof WORKBENCH_ROUTES
        ];
        if (request.method === "POST" && operation !== undefined) {
          if (options.workbenchSession === undefined) {
            writeJson(response, 503, { code: "WORKBENCH_UNAVAILABLE" });
            return;
          }
          const body = await readJsonBody(
            request,
            operation === "previewCorrection"
              ? MAX_CORRECTION_DRAFT_BYTES
              : MAX_JSON_BODY_BYTES,
          );
          let result: unknown;
          try {
            const service = options.workbenchSession(
              authenticated.session_id,
            );
            result = await service[operation](body);
          } catch {
            writeJson(response, 503, { code: "WORKBENCH_UNAVAILABLE" });
            return;
          }
          writeJson(response, 200, result);
          return;
        }
      }
      const knownPath = new Set([
        "/",
        "/api/session/auto",
        "/api/session/exchange",
        "/__operator/bootstrap",
        "/__hooks/capture",
        "/api/health",
        ...Object.keys(WORKBENCH_ROUTES),
        ...(options.webAssets === undefined
          ? ["/bootstrap.js", "/fixture.css"]
          : [...options.webAssets.assets.keys()]),
      ]).has(path);
      writeJson(
        response,
        knownPath ? 405 : 404,
        { code: knownPath ? "METHOD_NOT_ALLOWED" : "ROUTE_NOT_FOUND" },
      );
    } catch {
      writeJson(response, 400, { code: "INVALID_REQUEST" });
    }
  });

  server.requestTimeout = 5_000;
  server.headersTimeout = 3_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = maxConnections;
  server.on("connection", (socket) => {
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    sessions.close();
    throw new Error("workbench loopback address unavailable");
  }
  origin = `http://127.0.0.1:${address.port}`;
  expectedHost = `127.0.0.1:${address.port}`;

  let closed = false;
  return {
    origin,
    port: address.port,
    sessions,
    sockets,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      sessions.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      options.controlCredential.fill(0);
      options.hookCredential?.fill(0);
    },
  };
}

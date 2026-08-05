import { WorkbenchBrowserSessionSchema } from "@memo-graph/contracts/workbench-host";

import { WorkbenchApiClient } from "./api/client.js";
import { mountWorkbench } from "./mount.js";

const selectedContainer = document.querySelector<HTMLElement>("#root");
if (selectedContainer === null) {
  throw new Error("workbench root element is missing");
}
const container: HTMLElement = selectedContainer;

const fragment = new URLSearchParams(window.location.hash.slice(1));
const fragmentTicket = fragment.get("ticket");
const fragmentInstance = fragment.get("instance");
window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

let mounted: ReturnType<typeof mountWorkbench> | null = null;

function mountSession(input: unknown): boolean {
  const session = WorkbenchBrowserSessionSchema.safeParse(input);
  if (!session.success) return false;
  const api = new WorkbenchApiClient({
    bearer: session.data.bearer,
    instanceId: session.data.instance_id,
    baseUrl: window.location.origin,
  });
  mounted?.unmount();
  container.replaceChildren();
  mounted = mountWorkbench(container, { api });
  return true;
}

async function exchange(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || !mountSession(await response.json())) {
    throw new Error("SESSION_EXCHANGE_FAILED");
  }
}

function sessionGate(message: string): void {
  const gate = document.createElement("main");
  gate.className = "session-gate";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "MEMO GRAPH · LOCAL SESSION";
  const heading = document.createElement("h1");
  heading.textContent = "记忆工作台";
  const status = document.createElement("p");
  status.id = "session-status";
  status.role = "status";
  status.textContent = message;
  gate.append(eyebrow, heading, status);
  container.replaceChildren(gate);
}

const initialSession = globalThis.__MEMO_GRAPH_SESSION__;
globalThis.__MEMO_GRAPH_SESSION__ = undefined;
if (!mountSession(initialSession)) {
  sessionGate("正在建立本地安全会话…");
  if (fragmentTicket !== null && fragmentInstance !== null) {
    void exchange("/api/session/exchange", {
      ticket: fragmentTicket,
      instance_id: fragmentInstance,
    }).catch(() => {
      sessionGate(
        "启动链接无效或已过期，请重新运行工作台命令。",
      );
    });
  } else {
    void exchange("/api/session/auto", {}).catch(() => {
      sessionGate(
        "无法建立本地会话，请重新运行工作台命令。",
      );
    });
  }
}

globalThis.addEventListener("memo-graph-session", (event) => {
  if (event instanceof CustomEvent) mountSession(event.detail);
});

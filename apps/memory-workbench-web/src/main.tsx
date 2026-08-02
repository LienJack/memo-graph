import { WorkbenchBrowserSessionSchema } from "@memo-graph/contracts/workbench-host";

import { WorkbenchApiClient } from "./api/client.js";
import { mountWorkbench } from "./mount.js";

const container = document.querySelector<HTMLElement>("#root");
if (container === null) {
  throw new Error("workbench root element is missing");
}

function apiForSession(input: unknown): WorkbenchApiClient | null {
  const session = WorkbenchBrowserSessionSchema.safeParse(input);
  return session.success
    ? new WorkbenchApiClient({
        bearer: session.data.bearer,
        instanceId: session.data.instance_id,
        baseUrl: window.location.origin,
      })
    : null;
}

let api = apiForSession(globalThis.__MEMO_GRAPH_SESSION__);
globalThis.__MEMO_GRAPH_SESSION__ = undefined;
let root = mountWorkbench(container, api === null ? {} : { api });

globalThis.addEventListener("memo-graph-session", (event) => {
  if (!(event instanceof CustomEvent)) {
    return;
  }
  const nextApi = apiForSession(event.detail);
  if (nextApi === null) {
    return;
  }
  globalThis.__MEMO_GRAPH_SESSION__ = undefined;
  api = nextApi;
  root.unmount();
  root = mountWorkbench(container, { api });
});

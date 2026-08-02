import { describe, expect, it } from "vitest";

import { WorkbenchApiClient } from "./client.js";

describe("WorkbenchApiClient", () => {
  it("carries page authority and validates a successful response", async () => {
    const observed: { headers?: Headers } = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      observed.headers = new Headers(init?.headers);
      return Response.json({
        status: "ready_empty",
        items: [],
        page: null,
        excluded_count: 0,
        reason_codes: [],
        warnings: [],
      });
    };
    const client = new WorkbenchApiClient({
      bearer: "page-secret",
      instanceId: "instance-1",
      fetchImpl,
    });

    await expect(client.listMemories({})).resolves.toMatchObject({ status: "ready_empty" });
    expect(observed.headers?.get("Authorization")).toBe("Bearer page-secret");
    expect(observed.headers?.get("X-Memo-Graph-Instance")).toBe("instance-1");
  });

  it("rejects schema drift without returning unvalidated content", async () => {
    const client = new WorkbenchApiClient({
      bearer: "page-secret",
      instanceId: "instance-1",
      fetchImpl: async () => Response.json({ status: "ready", items: "not-an-array" }),
    });

    await expect(client.listMemories({})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 200,
    });
  });

  it("reads health with the same page authority and no mutation body", async () => {
    const observed: {
      method: string | undefined;
      body: unknown;
      headers: Headers | undefined;
    } = { method: undefined, body: undefined, headers: undefined };
    const fetchImpl: typeof fetch = async (_input, init) => {
      observed.method = init?.method;
      observed.body = init?.body;
      observed.headers = new Headers(init?.headers);
      return Response.json({ status: "wrong-contract" });
    };
    const client = new WorkbenchApiClient({
      bearer: "page-secret",
      instanceId: "instance-1",
      fetchImpl,
    });

    await expect(client.health()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 200,
    });
    expect(observed.method).toBe("GET");
    expect(observed.body).toBeUndefined();
    expect(observed.headers?.get("Authorization")).toBe("Bearer page-secret");
    expect(observed.headers?.get("Content-Type")).toBeNull();
  });
});

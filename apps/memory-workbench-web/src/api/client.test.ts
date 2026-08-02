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
});

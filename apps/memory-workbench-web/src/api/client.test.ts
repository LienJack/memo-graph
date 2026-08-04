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

  it("binds automatic undo to preview then explicit confirmation endpoints", async () => {
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      paths.push(String(input));
      if (String(input).endsWith("/preview")) {
        return Response.json({
          status: "ready",
          preview_id: "preview_automatic_1",
          memory_id: "memory_1",
          expected_revision_id: "revision_1",
          effect: "demote_from_automatic_recall",
          expires_at: "2026-08-03T08:05:00.000Z",
          warnings: ["history_and_provenance_are_preserved"],
        });
      }
      return Response.json({
        status: "ready",
        memory_id: "memory_1",
        current_revision_id: "revision_1",
        lifecycle: "candidate",
        replayed: false,
        receipt: {
          schema_version: "1.0.0",
          receipt_id: "receipt_automatic_undo_1",
          created_at: "2026-08-03T08:00:00.000Z",
          state: "durable",
          request_hash: `sha256:${"a".repeat(64)}`,
          receipt_hash: `sha256:${"b".repeat(64)}`,
          kind: "mutation",
          idempotency_key: "automatic-undo-operation-1",
          affected_memory_ids: ["memory_1"],
          affected_revision_ids: ["revision_1"],
          resulting_epoch: 2,
          projection_jobs: [],
          warnings: [],
        },
        warnings: [],
      });
    };
    const client = new WorkbenchApiClient({
      bearer: "page-secret",
      instanceId: "instance-1",
      fetchImpl,
    });

    const preview = await client.previewAutomaticMemoryUndo(
      "memory_1",
      "revision_1",
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("expected preview");
    await expect(client.confirmAutomaticMemoryUndo(preview.preview_id)).resolves
      .toMatchObject({ status: "ready", lifecycle: "candidate" });
    expect(paths).toEqual([
      "/api/workbench/automatic-memory/undo/preview",
      "/api/workbench/automatic-memory/undo/confirm",
    ]);
  });
});

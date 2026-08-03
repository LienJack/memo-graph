import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  classifyG6RunbookInvocation,
  runDirectG6RunbookHarness,
} from "../../scripts/g6-runbook-harness.mjs";

describe("G6 direct operator Runbook harness", () => {
  it("spawns and strictly decodes every frozen automation", async () => {
    const states = await runDirectG6RunbookHarness();

    expect(states).toEqual({
      inspect_readiness: "pass",
      inspect_backup: "pass",
      prepare_restore: "pass",
      inspect_keys: "pass",
      prepare_key_rotation: "pass",
      audit_purge: "pass",
      prepare_rebuild: "pass",
      verify_learning_rollback: "pass",
      verify_g6_candidate: "pass",
      execute_confirmed_restore: "pass",
    });
  });

  it("fails closed for timeout, exit, stream, JSON, schema, and path drift", () => {
    const schema = z.object({ status: z.literal("ok") }).strict();
    const classify = (
      result: Parameters<typeof classifyG6RunbookInvocation>[0],
    ) => classifyG6RunbookInvocation(result, schema, [0]).state;

    expect(
      classify({
        status: null,
        error: { code: "ETIMEDOUT" },
      }),
    ).toBe("blocked");
    expect(classify({ status: 3, stdout: '{"status":"ok"}' })).toBe(
      "fail",
    );
    expect(
      classify({
        status: 0,
        stdout: '{"status":"ok"}',
        stderr: "unexpected diagnostic",
      }),
    ).toBe("fail");
    expect(classify({ status: 0, stdout: "not-json" })).toBe("fail");
    expect(
      classify({ status: 0, stdout: '{"status":"changed"}' }),
    ).toBe("fail");
    expect(
      classify({
        status: 0,
        stdout: '{"status":"ok","path":"/private/tmp/value"}',
      }),
    ).toBe("fail");
    expect(
      classify({
        status: 0,
        stdout: '{"status":"ok","value":"FORBIDDEN_PURGED_CONTENT_MARKER"}',
      }),
    ).toBe("fail");
  });
});

import { McpServer } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";

import {
  GovernedResponseSchema,
  LocalPrincipalSchema,
  MEMORY_TOOL_SAFETY_CLASS,
  MutationRequestEnvelopeSchema,
  ReadRequestEnvelopeSchema,
  authorizeRequestClaims,
} from "../../packages/contracts/src/index.js";
import {
  NOW,
  USER_ACTOR,
  USER_SCOPE,
  validReadRequest,
} from "../helpers/examples.js";

describe("MCP boundary contracts", () => {
  it("pins the stable v2 server and stdio API surface", () => {
    expect(McpServer).toBeTypeOf("function");
    expect(StdioServerTransport).toBeTypeOf("function");
    expect(serveStdio).toBeTypeOf("function");
  });

  it("classifies every planned tool by safety class", () => {
    expect(MEMORY_TOOL_SAFETY_CLASS.memory_search).toBe("read_only");
    expect(MEMORY_TOOL_SAFETY_CLASS.memory_episode_commit).toBe("proposal");
    expect(MEMORY_TOOL_SAFETY_CLASS.memory_revoke).toBe(
      "important_mutation",
    );
    expect(MEMORY_TOOL_SAFETY_CLASS.memory_delete).toBe("destructive");
  });

  it("rejects a payload that understates a destructive tool safety class", () => {
    expect(
      ReadRequestEnvelopeSchema.safeParse({
        ...validReadRequest(),
        tool: "memory_delete",
      }).success,
    ).toBe(false);
    expect(
      MutationRequestEnvelopeSchema.safeParse({
        schema_version: "1.0.0",
        request_id: "request_delete",
        tool: "memory_delete",
        safety_class: "important_mutation",
        actor_claim: USER_ACTOR,
        scopes: [USER_SCOPE],
        purpose: "Delete sensitive memory",
        reason: "User explicitly requested deletion",
        requested_at: NOW,
        idempotency_key: "delete-request-001",
        expected_revision_id: "revision_pref_1",
        dry_run: false,
      }).success,
    ).toBe(false);
  });

  it("binds actor and scope claims to the configured principal", () => {
    const principal = LocalPrincipalSchema.parse({
      principal_id: "user_local",
      allowed_scopes: [USER_SCOPE],
      allowed_authorities: ["user_stated"],
      destructive_tools_enabled: false,
    });
    const request = ReadRequestEnvelopeSchema.parse(validReadRequest());

    expect(authorizeRequestClaims(principal, request)).toEqual({
      authorized: true,
      principal_id: "user_local",
    });
    const mismatchedRequest = ReadRequestEnvelopeSchema.parse({
      ...validReadRequest(),
      actor_claim: { ...USER_ACTOR, principal_id: "other_user" },
    });
    expect(
      authorizeRequestClaims(principal, mismatchedRequest),
    ).toMatchObject({
      authorized: false,
      code: "PRINCIPAL_MISMATCH",
    });
  });

  it.each(["NO_MATCH", "POLICY_EXCLUDED", "DEGRADED", "FAILED"] as const)(
    "does not collapse %s into an OK empty result",
    (status) => {
      const examples = {
        NO_MATCH: {
          status,
          receipt_id: "receipt_no_match",
          reason: "No live memory matched",
        },
        POLICY_EXCLUDED: {
          status,
          receipt_id: "receipt_excluded",
          excluded_count: 1,
          reason_codes: ["SCOPE_DENIED"],
        },
        DEGRADED: {
          status,
          receipt_id: "receipt_degraded",
          fallback_lane: "recent",
          warnings: ["FTS projection unavailable"],
          data: [],
        },
        FAILED: {
          status,
          receipt_id: null,
          error: {
            code: "INTERNAL_FAILURE",
            message: "Request could not be served safely",
            retryable: true,
            details: {},
          },
        },
      };

      expect(GovernedResponseSchema.parse(examples[status]).status).toBe(status);
    },
  );
});

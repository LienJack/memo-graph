import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";

import {
  GovernedResponseSchema,
  ContextSliceItemSchema,
  LaneRequestOverridesSchema,
  LocalPrincipalSchema,
  MEMORY_TOOL_SAFETY_CLASS,
  MemoryContextCompileInputSchema,
  MemoryEpisodeCommitInputSchema,
  MemorySearchInputSchema,
  MutationRequestEnvelopeSchema,
  RecallRequestSchema,
  ReadRequestEnvelopeSchema,
  authorizeRequestClaims,
  buildGraphPathEvidence,
} from "../../packages/contracts/src/index.js";
import {
  HASH_A,
  HASH_B,
  NOW,
  USER_ACTOR,
  USER_SCOPE,
  validReadRequest,
} from "../helpers/examples.js";

describe("MCP boundary contracts", () => {
  it("pins the stable v2 server and stdio API surface", () => {
    expect(McpServer).toBeTypeOf("function");
    expect(Client).toBeTypeOf("function");
    expect(StdioClientTransport).toBeTypeOf("function");
    expect(StdioServerTransport).toBeTypeOf("function");
    expect(serveStdio).toBeTypeOf("function");
  });

  it("binds tool-specific inputs to their declared name and safety class", () => {
    const search = {
      envelope: {
        ...validReadRequest(),
        tool: "memory_search",
      },
      query: "durable task context",
    };
    expect(MemorySearchInputSchema.safeParse(search).success).toBe(true);
    expect(
      MemorySearchInputSchema.safeParse({
        ...search,
        envelope: { ...search.envelope, tool: "memory_get" },
      }).success,
    ).toBe(false);
    expect(
      MemoryEpisodeCommitInputSchema.safeParse({
        ...search,
        envelope: {
          ...search.envelope,
          tool: "memory_episode_commit",
        },
      }).success,
    ).toBe(false);
    expect(
      MemoryContextCompileInputSchema.safeParse({
        envelope: {
          ...search.envelope,
          tool: "memory_context_compile",
        },
        recall: {
          schema_version: "1.0.0",
          request_id: "different_request",
          goal: "restore context",
          query: "durable task context",
          scopes: search.envelope.scopes,
          as_of: NOW,
          token_budget: 1_800,
          include_sensitive: false,
        },
      }).success,
    ).toBe(false);
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
    expect(
      authorizeRequestClaims(
        principal,
        ReadRequestEnvelopeSchema.parse({
          ...validReadRequest(),
          actor_claim: { ...USER_ACTOR, authority: "inferred" },
        }),
      ),
    ).toMatchObject({
      authorized: false,
      code: "AUTHORITY_NOT_ALLOWED",
    });
    expect(
      authorizeRequestClaims(
        principal,
        ReadRequestEnvelopeSchema.parse({
          ...validReadRequest(),
          scopes: [{ kind: "workspace", id: "another_workspace" }],
        }),
      ),
    ).toMatchObject({
      authorized: false,
      code: "SCOPE_NOT_ALLOWED",
    });
  });

  it("keeps lane overrides bounded and rejects duplicate requested lanes", () => {
    expect(
      LaneRequestOverridesSchema.safeParse({
        requested_lanes: ["recent_l1", "topic"],
        limits: {
          max_candidates_per_lane: 25,
          relation_max_depth: 1,
        },
      }).success,
    ).toBe(true);
    expect(
      LaneRequestOverridesSchema.safeParse({
        requested_lanes: ["topic", "topic"],
        limits: {},
      }).success,
    ).toBe(false);
    expect(
      LaneRequestOverridesSchema.safeParse({
        requested_lanes: ["relation_sqlite"],
        limits: { relation_max_depth: 100 },
      }).success,
    ).toBe(false);
  });

  it("accepts graph opt-in only through typed lane fields and proof evidence", () => {
    const recall = {
      schema_version: "1.0.0",
      request_id: "request_graph_1",
      goal: "Find a governed structural proof",
      query: "topic dependency scenario",
      scopes: [USER_SCOPE],
      as_of: NOW,
      token_budget: 1_000,
      include_sensitive: false,
      lane_overrides: {
        requested_lanes: ["relation_graph"],
        limits: {
          relation_max_depth: 2,
          graph_query_timeout_ms: 50,
        },
      },
    } as const;
    expect(RecallRequestSchema.safeParse(recall).success).toBe(true);
    expect(
      RecallRequestSchema.safeParse({
        ...recall,
        cypher: "MATCH (n) RETURN n",
      }).success,
    ).toBe(false);
    expect(
      RecallRequestSchema.safeParse({
        ...recall,
        graph_path: "/tmp/graph",
      }).success,
    ).toBe(false);

    const graphPath = buildGraphPathEvidence({
      node_revision_ids: ["revision_start", "revision_goal"],
      relation_revision_ids: ["relation_revision_1"],
      relation_types: ["supports"],
      depth: 1,
    });
    const item = {
      memory_id: "projection_relation_1",
      revision_id: "projection_relation_revision_1",
      abstraction: "l2_relation",
      lifecycle: "active",
      authority: "derived",
      sensitivity: "internal",
      scope: USER_SCOPE,
      content: {
        storage: "inline",
        text: "Governed relation proof",
        media_type: "text/plain",
      },
      evidence_ids: ["evidence_1"],
      selection_reason: "Selected by the governed graph lane.",
      uncertainty: null,
      token_estimate: 16,
      lane: "relation_graph",
      projection: {
        projection_id: "projection_relation_1",
        projection_revision_id: "projection_relation_revision_1",
        source_revision_ids: ["revision_source_1"],
        source_content_hashes: [HASH_A],
        transform: {
          name: "deterministic-g3-projection",
          version: "1.0.0",
        },
        frontier: {
          schema_version: "1.0.0",
          ledger_epoch: 10,
          tombstone_epoch: 2,
          projection_epoch: 4,
          transform: {
            name: "deterministic-g3-projection",
            version: "1.0.0",
          },
          source_frontier_hash: HASH_A,
          projection_frontier_hash: HASH_B,
        },
      },
      graph_path: graphPath,
      score_components: {
        relevance: 1,
        authority: 0,
        freshness: 1,
        evidence_diversity: 1,
        conflict_cost: 0,
        token_utility: 1,
        lane_contribution: 1,
      },
      conflict_group_id: null,
    } as const;
    expect(ContextSliceItemSchema.safeParse(item).success).toBe(true);
    expect(
      ContextSliceItemSchema.safeParse({
        ...item,
        graph_path: undefined,
      }).success,
    ).toBe(false);
    expect(
      ContextSliceItemSchema.safeParse({
        ...item,
        lane: "relation_sqlite",
      }).success,
    ).toBe(false);
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

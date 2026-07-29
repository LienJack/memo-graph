import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  canonicalSha256Omitting,
  receiptHashIsValid,
} from "../../packages/contracts/src/index.js";
import {
  CompileContextInputSchema,
  compileContext,
  estimateContextTokens,
} from "../../packages/context-compiler/src/index.js";
import {
  MemoryServerConfigSchema,
  openMemoryRuntime,
} from "../../packages/mcp-server/src/index.js";

import { inlineEpisode } from "../helpers/storage-examples.js";
import { NOW } from "../helpers/examples.js";
import { qualifiedVectorEpoch } from "../helpers/vector-examples.js";

function compilerInput(options: {
  tokenBudget: number;
  includeSensitive?: boolean;
  degradedLanes?: string[];
}) {
  const evidence = inlineEpisode({}).evidence[0];
  if (evidence === undefined) {
    throw new Error("fixture requires evidence");
  }
  return {
    request: {
      schema_version: "1.0.0",
      request_id: `recall_budget_${options.tokenBudget}`,
      goal: "Restore task context",
      query: "governed context",
      scopes: [evidence.scope],
      as_of: "2026-07-28T12:10:00.000Z",
      token_budget: options.tokenBudget,
      include_sensitive: options.includeSensitive ?? false,
    },
    candidates: [{ evidence, rank: -1, lane: "sqlite_fts" }],
    created_at: "2026-07-28T12:10:00.000Z",
    degraded_lanes: options.degradedLanes ?? [],
  };
}

describe("baseline context compiler", () => {
  it.each([1, 1_800, 32_000])(
    "never exceeds a %i-token hard budget",
    (tokenBudget) => {
      const result = compileContext(compilerInput({ tokenBudget }));

      expect(result.context_slice?.token_used ?? 0).toBeLessThanOrEqual(
        tokenBudget,
      );
      if (tokenBudget === 1) {
        expect(result.status).toBe("POLICY_EXCLUDED");
        expect(result.reason_codes).toContain("BUDGET_EXCEEDED");
      } else {
        expect(result.status).toBe("OK");
        expect(result.context_slice?.items).toHaveLength(1);
      }
      expect(receiptHashIsValid(result.receipt)).toBe(true);
    },
  );

  it("rejects zero, overflow, and cross-scope inputs", () => {
    expect(() =>
      CompileContextInputSchema.parse(compilerInput({ tokenBudget: 0 })),
    ).toThrow();
    expect(() =>
      CompileContextInputSchema.parse(
        compilerInput({ tokenBudget: 32_001 }),
      ),
    ).toThrow();
    const wrongScope = compilerInput({ tokenBudget: 1_800 });
    const wrongScopeCandidate = wrongScope.candidates[0];
    if (wrongScopeCandidate === undefined) {
      throw new Error("fixture requires a candidate");
    }
    const invalidScopeInput = {
      ...wrongScope,
      candidates: [
        {
          ...wrongScopeCandidate,
          evidence: {
            ...wrongScopeCandidate.evidence,
            scope: { kind: "workspace", id: "another_workspace" },
          },
        },
      ],
    };
    expect(() => CompileContextInputSchema.parse(invalidScopeInput)).toThrow(
      /outside the recall request/,
    );
  });

  it("counts content and provenance and seals deterministic output", () => {
    expect(estimateContextTokens("abcd")).toBe(1);
    expect(estimateContextTokens("记忆")).toBe(4);
    const input = compilerInput({ tokenBudget: 1_800 });
    const inputCandidate = input.candidates[0];
    if (inputCandidate === undefined) {
      throw new Error("fixture requires a candidate");
    }
    const first = compileContext(input);
    const second = compileContext(input);

    expect(first).toEqual(second);
    expect(first.context_slice?.token_used).toBeGreaterThan(
      estimateContextTokens(
        inputCandidate.evidence.payload.storage === "inline"
          ? inputCandidate.evidence.payload.text
          : "",
      ),
    );
    expect(first.context_slice?.frozen_hash).toBe(
      canonicalSha256Omitting(first.context_slice ?? {}, ["frozen_hash"]),
    );
  });

  it("distinguishes privacy exclusion and degraded partial recall", () => {
    const sensitiveInput = compilerInput({ tokenBudget: 1_800 });
    const sensitiveCandidate = sensitiveInput.candidates[0];
    if (sensitiveCandidate === undefined) {
      throw new Error("fixture requires a candidate");
    }
    const governedSensitiveInput = {
      ...sensitiveInput,
      candidates: [
        {
          ...sensitiveCandidate,
          evidence: {
            ...sensitiveCandidate.evidence,
            sensitivity: "sensitive" as const,
          },
        },
      ],
    };
    const excluded = compileContext(governedSensitiveInput);
    const allowed = compileContext({
      ...governedSensitiveInput,
      request: {
        ...governedSensitiveInput.request,
        include_sensitive: true,
      },
      degraded_lanes: ["sqlite_fts"],
    });

    expect(excluded).toMatchObject({
      status: "POLICY_EXCLUDED",
      context_slice: null,
      reason_codes: ["SENSITIVE_EXCLUDED"],
    });
    expect(allowed.status).toBe("DEGRADED");
    expect(allowed.context_slice?.items).toHaveLength(1);
    expect(allowed.warnings).toEqual(["lane unavailable: sqlite_fts"]);
  });

  it("compiles an eligible L1 revision with its evidence lineage", () => {
    const content = {
      storage: "inline",
      text: "Prefer one falsifiable conclusion with verification evidence.",
      media_type: "text/plain",
    } as const;
    const input = compilerInput({ tokenBudget: 1_800 });
    const result = compileContext({
      ...input,
      candidates: [
        ...input.candidates,
        {
          abstraction: "l1_memory",
          memory: {
            abstraction: "l1_memory",
            memory_id: "memory_pref",
            revision_id: "revision_pref_2",
            lifecycle: "active",
            kind: "semantic",
            scope: { kind: "workspace", id: "workspace_local" },
            authority: "user_stated",
            sensitivity: "personal",
            validity: {
              valid_from: NOW,
              valid_to: null,
              recorded_at: NOW,
            },
            content,
            content_hash: canonicalSha256(content),
            evidence_ids: ["evidence_storage_1"],
            transform: {
              name: "memory-proposal",
              version: "1.0.0",
            },
            reason_codes: ["CANONICAL_CURRENT", "ACTIVATED"],
          },
          rank: -2,
          lane: "memory_fts",
        },
      ],
    });

    expect(result.status).toBe("OK");
    expect(result.context_slice?.items).toEqual([
      expect.objectContaining({
        memory_id: "memory_pref",
        revision_id: "revision_pref_2",
        abstraction: "l1_memory",
        lifecycle: "active",
        evidence_ids: ["evidence_storage_1"],
      }),
    ]);
    expect(result.context_slice?.token_used ?? 0).toBeLessThanOrEqual(1_800);
  });

  it("records canonical L1 exclusions without accepting their content", () => {
    const input = compilerInput({ tokenBudget: 1_800 });
    const result = compileContext({
      ...input,
      candidates: [],
      exclusions: [
        {
          memory_id: "memory_expired",
          revision_id: "revision_expired",
          reason_code: "EXPIRED",
          lane: "canonical_eligibility",
          score: null,
        },
        {
          memory_id: "memory_revoked",
          revision_id: "revision_revoked",
          reason_code: "REVOKED",
          lane: "canonical_eligibility",
          score: null,
        },
      ],
    });

    expect(result).toMatchObject({
      status: "POLICY_EXCLUDED",
      context_slice: null,
      excluded_count: 2,
      reason_codes: ["EXPIRED", "REVOKED"],
    });
    expect(result.receipt.items).toEqual([
      expect.objectContaining({
        memory_id: "memory_expired",
        reason_codes: ["EXPIRED"],
      }),
      expect.objectContaining({
        memory_id: "memory_revoked",
        reason_codes: ["REVOKED"],
      }),
    ]);
  });
});

describe("MCP Context lane configuration", () => {
  it("keeps projection lanes operator-owned and defaults to the L1 baseline", () => {
    const base = {
      data_root: "/tmp/memo-graph-context-config",
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: ["user_stated"],
    } as const;
    expect(
      MemoryServerConfigSchema.parse(base).lane_policy.allowed_lanes,
    ).toEqual(["recent_l1"]);
    expect(MemoryServerConfigSchema.parse(base).graph).toEqual({
      enabled: false,
    });
    expect(MemoryServerConfigSchema.parse(base).vector).toEqual({
      enabled: false,
    });
    expect(
      MemoryServerConfigSchema.parse({
        ...base,
        lane_policy: {
          allowed_lanes: ["recent_l1", "topic"],
          limits: {
            max_candidates_per_lane: 12,
            relation_max_depth: 1,
            relation_max_fanout: 3,
            max_concurrent_lanes: 2,
          },
        },
      }).lane_policy,
    ).toEqual({
      allowed_lanes: ["recent_l1", "topic"],
      limits: {
        max_candidates_per_lane: 12,
        relation_max_depth: 1,
        relation_max_fanout: 3,
        max_concurrent_lanes: 2,
      },
    });
  });

  it("requires explicit operator graph configuration and rejects raw graph queries", () => {
    const base = {
      data_root: "/tmp/memo-graph-context-graph-config",
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: ["user_stated"],
      lane_policy: {
        allowed_lanes: ["recent_l1", "relation_graph"],
        limits: {
          max_candidates_per_lane: 12,
          relation_max_depth: 2,
          relation_max_fanout: 3,
          max_concurrent_lanes: 2,
        },
      },
      graph: {
        enabled: true,
        expected_identity: {
          schema_version: "1.0.0",
          backend: "ladybugdb",
          package_name: "@ladybugdb/core",
          package_version: "0.18.3",
          storage_version: "42",
          platform: process.platform,
          architecture: process.arch,
          native_binary_hash: `sha256:${"1".repeat(64)}`,
          dependency_lock_hash: `sha256:${"2".repeat(64)}`,
        },
        mode: "typed_path",
        relation_pattern: ["supports"],
        direction: "outbound",
      },
    } as const;
    expect(MemoryServerConfigSchema.safeParse(base).success).toBe(true);
    expect(
      MemoryServerConfigSchema.safeParse({
        ...base,
        graph: {
          ...base.graph,
          raw_query: "MATCH (n) RETURN n",
        },
      }).success,
    ).toBe(false);
    expect(
      MemoryServerConfigSchema.safeParse({
        ...base,
        graph: {
          ...base.graph,
          request_timeout_ms: 76,
        },
      }).success,
    ).toBe(false);
    expect(
      MemoryServerConfigSchema.safeParse({
        ...base,
        graph: {
          ...base.graph,
          generation_id: "../outside",
        },
      }).success,
    ).toBe(false);
  });

  it("does not create or start graph storage merely by opening an explicitly configured MCP runtime", async () => {
    const dataRoot = realpathSync(
      mkdtempSync(
        join(realpathSync(tmpdir()), "memo-graph-mcp-lazy-graph-"),
      ),
    );
    const opened = await openMemoryRuntime({
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: ["user_stated"],
      lane_policy: {
        allowed_lanes: ["recent_l1", "relation_graph"],
        limits: {
          max_candidates_per_lane: 12,
          relation_max_depth: 2,
          relation_max_fanout: 3,
          max_concurrent_lanes: 2,
        },
      },
      graph: {
        enabled: true,
        expected_identity: {
          schema_version: "1.0.0",
          backend: "ladybugdb",
          package_name: "@ladybugdb/core",
          package_version: "0.18.3",
          storage_version: "42",
          platform: process.platform,
          architecture: process.arch,
          native_binary_hash: `sha256:${"1".repeat(64)}`,
          dependency_lock_hash: `sha256:${"2".repeat(64)}`,
        },
        mode: "typed_path",
        relation_pattern: ["supports"],
        direction: "outbound",
      },
    });
    try {
      expect(
        existsSync(join(dataRoot, "derived", "graph", "ladybug.lbdb")),
      ).toBe(false);
    } finally {
      await opened.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("requires explicit vector configuration and opens it without starting optional dependencies", async () => {
    const dataRoot = realpathSync(
      mkdtempSync(
        join(realpathSync(tmpdir()), "memo-graph-mcp-lazy-vector-"),
      ),
    );
    const epoch = qualifiedVectorEpoch();
    const config = {
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: ["user_stated"],
      lane_policy: {
        allowed_lanes: ["recent_l1", "semantic_vector"],
        limits: {
          max_candidates_per_lane: 12,
          relation_max_depth: 2,
          relation_max_fanout: 3,
          max_concurrent_lanes: 2,
          vector_top_k: 8,
          vector_query_timeout_ms: 50,
          vector_max_response_bytes: 65_536,
        },
      },
      vector: {
        enabled: true,
        model_root: join(dataRoot, "models"),
        expected_epoch: epoch,
      },
    } as const;
    expect(MemoryServerConfigSchema.safeParse(config).success).toBe(true);
    expect(
      MemoryServerConfigSchema.safeParse({
        ...config,
        vector: {
          ...config.vector,
          model_root: "",
        },
      }).success,
    ).toBe(false);

    const opened = await openMemoryRuntime(config);
    try {
      expect(opened.config.vector).toMatchObject({
        enabled: true,
        allow_evaluating: false,
        expected_epoch: {
          epoch_id: epoch.epoch_id,
        },
      });
      expect(
        existsSync(join(dataRoot, "derived", "vector")),
      ).toBe(false);
    } finally {
      await opened.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

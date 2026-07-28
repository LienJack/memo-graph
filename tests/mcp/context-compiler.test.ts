import { describe, expect, it } from "vitest";

import {
  canonicalSha256Omitting,
  receiptHashIsValid,
} from "../../packages/contracts/src/index.js";
import {
  CompileContextInputSchema,
  compileContext,
  estimateContextTokens,
} from "../../packages/context-compiler/src/index.js";

import { inlineEpisode } from "../helpers/storage-examples.js";

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
});

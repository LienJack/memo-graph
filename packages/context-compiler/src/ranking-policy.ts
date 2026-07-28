import {
  ContextScoreComponentsSchema,
  type ContextScoreComponents,
} from "@memo-graph/contracts";

import {
  estimateContextTokens,
} from "./token-packer.js";
import type { PreparedLayeredCandidate } from "./hard-filters.js";

export type RankedLayeredCandidate = {
  candidate: PreparedLayeredCandidate;
  score_components: ContextScoreComponents;
  total_score: number;
  constraint_priority: number;
};

const AUTHORITY_SCORE = {
  user_stated: 1,
  observed: 0.8,
  tool_result: 0.7,
  derived: 0.6,
  imported: 0.5,
  inferred: 0.4,
} as const;

const LANE_SCORE = {
  recent_l1: 0.4,
  topic: 0.3,
  scenario_procedure: 0.9,
  core: 0.8,
  relation_sqlite: 0.5,
} as const;

function terms(value: string): Set<string> {
  return new Set(
    value.normalize("NFKC").toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu) ?? [],
  );
}

function relevance(
  candidate: PreparedLayeredCandidate,
  query: string,
): number {
  const queryTerms = terms(query);
  const contentTerms = terms(
    candidate.content.storage === "inline"
      ? candidate.content.text
      : "",
  );
  const overlap = [...queryTerms].filter((term) =>
    contentTerms.has(term)
  ).length;
  const lexical =
    queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
  return lexical + 1 / (1 + Math.max(0, candidate.rank));
}

function freshness(recordedAt: string, asOf: string): number {
  const ageDays = Math.max(
    0,
    (Date.parse(asOf) - Date.parse(recordedAt)) / 86_400_000,
  );
  return 1 / (1 + ageDays);
}

function constraintPriority(
  candidate: PreparedLayeredCandidate,
): number {
  const payload = candidate.projection_payload;
  if (payload?.kind === "procedure") {
    return 4;
  }
  if (payload?.kind === "core" && payload.constraints.length > 0) {
    return 3;
  }
  if (payload?.kind === "scenario" &&
      payload.preconditions.length > 0) {
    return 2;
  }
  return 0;
}

export function rankLayeredCandidates(options: {
  candidates: PreparedLayeredCandidate[];
  query: string;
  as_of: string;
}): RankedLayeredCandidate[] {
  return options.candidates.map((candidate) => {
    const provisionalTokens = Math.max(
      1,
      estimateContextTokens(
        candidate.content.storage === "inline"
          ? candidate.content.text
          : "",
      ),
    );
    const components = ContextScoreComponentsSchema.parse({
      relevance: relevance(candidate, options.query),
      authority: AUTHORITY_SCORE[candidate.authority],
      freshness: freshness(candidate.recorded_at, options.as_of),
      evidence_diversity: Math.min(
        1,
        new Set(candidate.evidence_ids).size / 3,
      ),
      conflict_cost: candidate.conflict_group_id === null ? 0 : -1,
      token_utility: 1 / provisionalTokens,
      lane_contribution: LANE_SCORE[candidate.lane],
    });
    const totalScore = Object.values(components).reduce(
      (sum, value) => sum + value,
      0,
    );
    return {
      candidate,
      score_components: components,
      total_score: totalScore,
      constraint_priority: constraintPriority(candidate),
    };
  }).sort(
    (left, right) =>
      right.constraint_priority - left.constraint_priority ||
      right.total_score - left.total_score ||
      left.candidate.lane.localeCompare(right.candidate.lane) ||
      left.candidate.revision_id.localeCompare(
        right.candidate.revision_id,
      ),
  );
}

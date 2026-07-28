import { canonicalJson, type RecallLane } from "@memo-graph/contracts";

export function estimateContextTokens(text: string): number {
  let asciiBytes = 0;
  let nonAsciiCodePoints = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x7f) {
      asciiBytes += Buffer.byteLength(character, "utf8");
    } else {
      nonAsciiCodePoints += 1;
    }
  }
  return Math.ceil(asciiBytes / 4) + nonAsciiCodePoints * 2;
}

export function estimateStructuredTokens(value: unknown): number {
  return estimateContextTokens(canonicalJson(value));
}

export type PackableContextItem<T> = {
  key: string;
  lane: RecallLane;
  constraint_priority: number;
  total_score: number;
  item: T & { token_estimate: number };
};

export type PackedContextDecision<T> = {
  candidate: PackableContextItem<T>;
  included: boolean;
  reason_code: "INCLUDED" | "BUDGET_EXCEEDED";
};

const LANE_ORDER: RecallLane[] = [
  "recent_l1",
  "topic",
  "scenario_procedure",
  "core",
  "relation_sqlite",
];

function scoreOrder<T>(
  left: PackableContextItem<T>,
  right: PackableContextItem<T>,
): number {
  return (
    right.constraint_priority - left.constraint_priority ||
    right.total_score - left.total_score ||
    left.key.localeCompare(right.key)
  );
}

export function packContextItems<T>(
  candidates: PackableContextItem<T>[],
  tokenBudget: number,
): {
  included: PackableContextItem<T>[];
  decisions: PackedContextDecision<T>[];
  token_used: number;
} {
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1 ||
      tokenBudget > 32_000) {
    throw new Error("token budget must be an integer from 1 through 32000");
  }
  const required = candidates
    .filter((candidate) => candidate.constraint_priority > 0)
    .sort(scoreOrder);
  const remaining = candidates
    .filter((candidate) => candidate.constraint_priority === 0)
    .sort(scoreOrder);
  const laneMinimums = LANE_ORDER.flatMap((lane) => {
    const first = remaining.find((candidate) => candidate.lane === lane);
    return first === undefined ? [] : [first];
  });
  const laneMinimumKeys = new Set(laneMinimums.map((candidate) =>
    candidate.key
  ));
  const ordered = [
    ...required,
    ...laneMinimums,
    ...remaining.filter((candidate) =>
      !laneMinimumKeys.has(candidate.key)
    ),
  ];
  const included: PackableContextItem<T>[] = [];
  const decisions: PackedContextDecision<T>[] = [];
  let tokenUsed = 0;
  for (const candidate of ordered) {
    if (tokenUsed + candidate.item.token_estimate > tokenBudget) {
      decisions.push({
        candidate,
        included: false,
        reason_code: "BUDGET_EXCEEDED",
      });
      continue;
    }
    included.push(candidate);
    tokenUsed += candidate.item.token_estimate;
    decisions.push({
      candidate,
      included: true,
      reason_code: "INCLUDED",
    });
  }
  return { included, decisions, token_used: tokenUsed };
}

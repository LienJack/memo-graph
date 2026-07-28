import {
  canonicalSha256,
  type ContextConflictSet,
} from "@memo-graph/contracts";

import type {
  LayeredCandidateExclusion,
  PreparedLayeredCandidate,
} from "./hard-filters.js";

function exclude(
  candidate: PreparedLayeredCandidate,
  reasonCode: string,
): LayeredCandidateExclusion {
  return {
    candidate: candidate.candidate,
    memory_id: candidate.memory_id,
    revision_id: candidate.revision_id,
    lane: candidate.lane,
    reason_code: reasonCode,
    score: candidate.rank,
  };
}

function lineageKey(candidate: PreparedLayeredCandidate): string | null {
  if (candidate.projection === null) {
    return null;
  }
  return canonicalSha256(
    [...candidate.projection.source_revision_ids].sort(),
  );
}

export function resolveConflictsAndDedupe(options: {
  candidates: PreparedLayeredCandidate[];
  conflict_sets: ContextConflictSet[];
}): {
  candidates: PreparedLayeredCandidate[];
  exclusions: LayeredCandidateExclusion[];
  conflict_sets: ContextConflictSet[];
} {
  const groupByRevision = new Map<string, string>();
  for (const set of options.conflict_sets) {
    for (const revisionId of set.member_revision_ids) {
      groupByRevision.set(revisionId, set.conflict_group_id);
    }
  }
  const annotated = options.candidates.map((candidate) => ({
    ...candidate,
    conflict_group_id:
      groupByRevision.get(candidate.revision_id) ?? null,
  }));

  const exclusions: LayeredCandidateExclusion[] = [];
  const identitySeen = new Set<string>();
  const identityUnique = annotated
    .sort((left, right) =>
      left.revision_id.localeCompare(right.revision_id)
    )
    .filter((candidate) => {
      if (identitySeen.has(candidate.revision_id)) {
        exclusions.push(exclude(candidate, "DUPLICATE_CANDIDATE"));
        return false;
      }
      identitySeen.add(candidate.revision_id);
      return true;
    });

  const coreLineages = new Set(
    identityUnique.flatMap((candidate) =>
      candidate.projection_payload?.kind === "core"
        ? [lineageKey(candidate)]
        : [],
    ),
  );
  const withoutRedundantTopics = identityUnique.filter((candidate) => {
    const redundant =
      candidate.conflict_group_id === null &&
      candidate.projection_payload?.kind === "topic" &&
      coreLineages.has(lineageKey(candidate));
    if (redundant) {
      exclusions.push(
        exclude(candidate, "DEDUPED_BY_HIGHER_ABSTRACTION"),
      );
    }
    return !redundant;
  });
  const abstractedSourceIds = new Set<string>(
    withoutRedundantTopics.flatMap((candidate) => {
      const kind = candidate.projection_payload?.kind;
      return kind !== undefined && kind !== "relation"
        ? candidate.projection?.source_revision_ids ?? []
        : [];
    }),
  );
  const deduplicated = withoutRedundantTopics.filter((candidate) => {
    const redundant =
      candidate.abstraction === "l1_memory" &&
      candidate.conflict_group_id === null &&
      abstractedSourceIds.has(candidate.revision_id);
    if (redundant) {
      exclusions.push(
        exclude(candidate, "DEDUPED_BY_HIGHER_ABSTRACTION"),
      );
    }
    return !redundant;
  });
  const retainedRevisionIds = new Set(
    deduplicated.map((candidate) => candidate.revision_id),
  );
  const retainedConflictSets = options.conflict_sets.filter((set) =>
    set.member_revision_ids.some((revisionId) =>
      retainedRevisionIds.has(revisionId)
    )
  );
  return {
    candidates: deduplicated,
    exclusions: exclusions.sort(
      (left, right) =>
        left.reason_code.localeCompare(right.reason_code) ||
        left.revision_id.localeCompare(right.revision_id),
    ),
    conflict_sets: retainedConflictSets,
  };
}

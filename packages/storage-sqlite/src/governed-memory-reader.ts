import type Database from "better-sqlite3";

import {
  GovernedSearchItemSchema,
  type Scope,
} from "@memo-graph/contracts";

import {
  MemoryEligibilityInputSchema,
  type EligibilityReasonCode,
  type GovernedMemorySearchResult,
  type GovernedMemoryLookupResult,
  type MemoryEligibilityResult,
  type ParsedGovernedMemorySearchQuery,
  type ParsedGovernedMemoryLookupInput,
  type ParsedMemoryEligibilityInput,
} from "./protocol.js";
import { StorageError } from "./errors.js";

type MemoryRow = {
  memory_id: string;
  logical_key_hash: string;
  principal_id: string;
  object_scope_kind: Scope["kind"];
  object_scope_id: string;
  object_lifecycle: string;
  current_revision_id: string | null;
  context_eligible: number;
  revision_id: string | null;
  revision_lifecycle: string | null;
  kind: "episodic" | "semantic" | "procedural" | null;
  scope_kind: Scope["kind"] | null;
  scope_id: string | null;
  authority:
    | "user_stated"
    | "observed"
    | "tool_result"
    | "inferred"
    | "derived"
    | "imported"
    | null;
  sensitivity:
    | "public"
    | "internal"
    | "personal"
    | "sensitive"
    | "secret"
    | null;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string | null;
  content_storage: "inline" | "blob" | "redacted" | null;
  content_inline: string | null;
  media_type: string | null;
  content_hash: string | null;
  transform_name: string | null;
  transform_version: string | null;
};

type RawSearchHit = {
  memory_id: string;
  revision_id: string;
  rank: number;
  lane: "memory_fts" | "sqlite_canonical";
};

function terms(query: string): string[] {
  return (query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(
    0,
    32,
  );
}

function compileFtsQuery(query: string): string {
  return terms(query)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function lifecycleReason(lifecycle: string): EligibilityReasonCode | null {
  return (
    {
      working: "CANDIDATE_ONLY",
      candidate: "CANDIDATE_ONLY",
      superseded: "SUPERSEDED",
      revoked: "REVOKED",
      quarantined: "QUARANTINED",
      purged: "TOMBSTONED",
    } as Record<string, EligibilityReasonCode>
  )[lifecycle] ?? null;
}

function excluded(
  input: ParsedMemoryEligibilityInput,
  reasonCode: EligibilityReasonCode,
): MemoryEligibilityResult {
  return {
    eligible: false,
    memory_id: input.memory_id,
    revision_id: input.revision_id,
    reason_code: reasonCode,
  };
}

export class GovernedMemoryReader {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  lookup(
    input: ParsedGovernedMemoryLookupInput,
  ): GovernedMemoryLookupResult {
    const row = this.#database
      .prepare(
        `SELECT coalesce(
           o.current_revision_id,
           t.revision_id,
           (
             SELECT r.revision_id FROM memory_revisions AS r
             WHERE r.memory_id = o.memory_id
             ORDER BY r.revision DESC LIMIT 1
           )
         ) AS revision_id
         FROM memory_objects AS o
         LEFT JOIN memory_tombstones AS t ON t.memory_id = o.memory_id
         WHERE o.memory_id = ?`,
      )
      .get(input.memory_id) as { revision_id: string | null } | undefined;
    if (row === undefined || row.revision_id === null) {
      return null;
    }
    return this.checkEligibility(
      MemoryEligibilityInputSchema.parse({
        ...input,
        revision_id: row.revision_id,
      }),
    );
  }

  checkEligibility(
    input: ParsedMemoryEligibilityInput,
  ): MemoryEligibilityResult {
    const row = this.#database
      .prepare(
        `SELECT
           o.memory_id, o.logical_key_hash, o.principal_id,
           o.scope_kind AS object_scope_kind, o.scope_id AS object_scope_id,
           o.lifecycle AS object_lifecycle, o.current_revision_id,
           o.context_eligible,
           r.revision_id, r.lifecycle AS revision_lifecycle, r.kind,
           r.scope_kind, r.scope_id, r.authority, r.sensitivity,
           r.valid_from, r.valid_to, r.recorded_at, r.content_storage,
           r.content_inline, r.media_type,
           r.content_hash, r.transform_name, r.transform_version
         FROM memory_objects AS o
         LEFT JOIN memory_revisions AS r
           ON r.memory_id = o.memory_id AND r.revision_id = ?
         WHERE o.memory_id = ?`,
      )
      .get(input.revision_id, input.memory_id) as MemoryRow | undefined;
    if (row === undefined) {
      return excluded(input, "NOT_FOUND");
    }
    if (row.principal_id !== input.principal_id) {
      return excluded(input, "WRONG_PRINCIPAL");
    }
    if (
      row.object_scope_kind !== input.scope.kind ||
      row.object_scope_id !== input.scope.id
    ) {
      return excluded(input, "WRONG_SCOPE");
    }
    const objectReason = lifecycleReason(row.object_lifecycle);
    if (objectReason !== null) {
      return excluded(input, objectReason);
    }
    if (
      row.current_revision_id !== input.revision_id ||
      row.context_eligible !== 1
    ) {
      return excluded(input, "SUPERSEDED");
    }
    if (
      row.revision_id === null ||
      row.revision_lifecycle === null ||
      row.kind === null ||
      row.scope_kind === null ||
      row.scope_id === null ||
      row.authority === null ||
      row.sensitivity === null ||
      row.valid_from === null ||
      row.recorded_at === null ||
      row.content_storage === null ||
      row.media_type === null ||
      row.content_hash === null ||
      row.transform_name === null ||
      row.transform_version === null
    ) {
      return excluded(input, "CORRUPT_LINEAGE");
    }
    const revisionReason = lifecycleReason(row.revision_lifecycle);
    if (revisionReason !== null || row.revision_lifecycle !== "active") {
      return excluded(input, revisionReason ?? "SUPERSEDED");
    }
    if (
      row.scope_kind !== input.scope.kind ||
      row.scope_id !== input.scope.id
    ) {
      return excluded(input, "CORRUPT_LINEAGE");
    }
    const hasActivation = this.#hasActivation(input.revision_id);
    if (!hasActivation || !this.#hasLiveEvidence(input, row)) {
      return excluded(
        input,
        hasActivation ? "NO_LIVE_EVIDENCE" : "NO_ACTIVATION",
      );
    }
    if (Date.parse(row.valid_from) > Date.parse(input.as_of)) {
      return excluded(input, "NOT_YET_VALID");
    }
    if (
      row.valid_to !== null &&
      Date.parse(row.valid_to) < Date.parse(input.as_of)
    ) {
      return excluded(input, "EXPIRED");
    }
    if (this.#hasOpenConflict(row)) {
      return excluded(input, "OPEN_CONFLICT");
    }
    if (this.#usageIsBlocked(input)) {
      return excluded(input, "USAGE_BLOCKED");
    }
    if (row.sensitivity === "secret") {
      return excluded(input, "SECRET_EXCLUDED");
    }
    if (row.sensitivity === "sensitive" && !input.include_sensitive) {
      return excluded(input, "SENSITIVE_EXCLUDED");
    }
    if (row.content_storage !== "inline" || row.content_inline === null) {
      return excluded(input, "CONTENT_NOT_INLINE");
    }
    const evidenceIds = (
      this.#database
        .prepare(
          `SELECT evidence_id FROM memory_revision_evidence
           WHERE revision_id = ? ORDER BY evidence_id`,
        )
        .all(input.revision_id) as Array<{ evidence_id: string }>
    ).map((evidence) => evidence.evidence_id);
    if (evidenceIds.length === 0) {
      return excluded(input, "CORRUPT_LINEAGE");
    }
    const item = GovernedSearchItemSchema.parse({
      abstraction: "l1_memory",
      memory_id: row.memory_id,
      revision_id: row.revision_id,
      lifecycle: "active",
      kind: row.kind,
      scope: { kind: row.scope_kind, id: row.scope_id },
      authority: row.authority,
      sensitivity: row.sensitivity,
      validity: {
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        recorded_at: row.recorded_at,
      },
      content: {
        storage: "inline",
        text: row.content_inline,
        media_type: row.media_type,
      },
      content_hash: row.content_hash,
      evidence_ids: evidenceIds,
      transform: {
        name: row.transform_name,
        version: row.transform_version,
      },
      reason_codes: ["CANONICAL_CURRENT", "ACTIVATED", "LIVE_EVIDENCE"],
    });
    return { eligible: true, item };
  }

  search(
    input: ParsedGovernedMemorySearchQuery,
  ): GovernedMemorySearchResult {
    const queryTerms = terms(input.query);
    if (queryTerms.length === 0) {
      throw new StorageError("INVALID_INPUT");
    }
    const rawHits: RawSearchHit[] = [];
    let ftsFailed = false;
    try {
      const compiled = compileFtsQuery(input.query);
      if (compiled.length > 0) {
        rawHits.push(
          ...(this.#database
            .prepare(
              `SELECT memory_id, revision_id, bm25(memory_fts) AS rank,
                      'memory_fts' AS lane
               FROM memory_fts
               WHERE memory_fts MATCH ?
                 AND principal_id = ?
                 AND scope_kind = ?
                 AND scope_id = ?
               ORDER BY rank, valid_from DESC, revision_id
               LIMIT ?`,
            )
            .all(
              compiled,
              input.principal_id,
              input.scope.kind,
              input.scope.id,
              input.limit,
            ) as RawSearchHit[]),
        );
      }
    } catch {
      ftsFailed = true;
    }

    const canonicalRows = this.#database
      .prepare(
        `SELECT o.memory_id, r.revision_id, r.content_inline
         FROM memory_objects AS o
         JOIN memory_revisions AS r ON r.revision_id = o.current_revision_id
         WHERE o.principal_id = ?
           AND o.scope_kind = ?
           AND o.scope_id = ?
           AND o.lifecycle = 'active'
           AND o.context_eligible = 1
           AND r.content_storage = 'inline'
         ORDER BY r.valid_from DESC, r.revision_id
         LIMIT 500`,
      )
      .all(
        input.principal_id,
        input.scope.kind,
        input.scope.id,
      ) as Array<{
      memory_id: string;
      revision_id: string;
      content_inline: string;
    }>;
    for (const [index, row] of canonicalRows.entries()) {
      const searchable = row.content_inline.toLocaleLowerCase();
      if (queryTerms.every((term) => searchable.includes(term))) {
        rawHits.push({
          memory_id: row.memory_id,
          revision_id: row.revision_id,
          rank: index,
          lane: "sqlite_canonical",
        });
      }
    }

    const seen = new Set<string>();
    const items: GovernedMemorySearchResult["items"] = [];
    const exclusions: GovernedMemorySearchResult["exclusions"] = [];
    for (const hit of rawHits) {
      const key = `${hit.memory_id}:${hit.revision_id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const result = this.checkEligibility(MemoryEligibilityInputSchema.parse({
        memory_id: hit.memory_id,
        revision_id: hit.revision_id,
        principal_id: input.principal_id,
        scope: input.scope,
        as_of: input.as_of,
        include_sensitive: input.include_sensitive,
        context_scope: input.context_scope,
      }));
      if (result.eligible) {
        items.push({ item: result.item, rank: hit.rank, lane: hit.lane });
      } else {
        exclusions.push({
          memory_id: result.memory_id,
          revision_id: result.revision_id,
          reason_code: result.reason_code,
          lane: hit.lane,
          score: hit.rank,
        });
      }
      if (items.length >= input.limit) {
        break;
      }
    }
    const degradedLanes = ftsFailed ? ["memory_fts:unavailable"] : [];
    const status =
      degradedLanes.length > 0
        ? "DEGRADED"
        : items.length > 0
          ? "OK"
          : exclusions.length > 0
            ? "POLICY_EXCLUDED"
            : "NO_MATCH";
    return { status, items, exclusions, degraded_lanes: degradedLanes };
  }

  #hasActivation(revisionId: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM admission_decisions
           WHERE revision_id = ? AND decision = 'activate'
           ORDER BY decided_at DESC, decision_id DESC LIMIT 1`,
        )
        .get(revisionId) !== undefined
    );
  }

  #hasLiveEvidence(
    input: ParsedMemoryEligibilityInput,
    row: MemoryRow,
  ): boolean {
    const counts = this.#database
      .prepare(
        `SELECT
           count(*) AS total,
           sum(CASE
             WHEN e.purged_at IS NULL
              AND e.principal_id = ?
              AND e.scope_kind = ?
              AND e.scope_id = ?
             THEN 1 ELSE 0 END) AS live
         FROM memory_revision_evidence AS l
         JOIN evidence_events AS e ON e.evidence_id = l.evidence_id
         WHERE l.revision_id = ?`,
      )
      .get(
        input.principal_id,
        row.scope_kind,
        row.scope_id,
        input.revision_id,
      ) as { total: number; live: number };
    return counts.total > 0 && counts.total === counts.live;
  }

  #hasOpenConflict(row: MemoryRow): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM memory_conflict_groups
           WHERE logical_key_hash = ?
             AND principal_id = ?
             AND scope_kind = ?
             AND scope_id = ?
             AND status = 'open'
           LIMIT 1`,
        )
        .get(
          row.logical_key_hash,
          row.principal_id,
          row.object_scope_kind,
          row.object_scope_id,
        ) !== undefined
    );
  }

  #usageIsBlocked(input: ParsedMemoryEligibilityInput): boolean {
    const context = input.context_scope;
    const row = this.#database
      .prepare(
        `SELECT effect FROM memory_usage_rules
         WHERE memory_id = ?
           AND revision_id = ?
           AND principal_id = ?
           AND occurred_at <= ?
           AND (
             (context_scope_kind IS NULL AND context_scope_id IS NULL)
             OR
             (context_scope_kind = ? AND context_scope_id = ?)
           )
         ORDER BY
           CASE WHEN context_scope_kind IS NULL THEN 0 ELSE 1 END DESC,
           occurred_at DESC, usage_rule_id DESC
         LIMIT 1`,
      )
      .get(
        input.memory_id,
        input.revision_id,
        input.principal_id,
        input.as_of,
        context?.kind ?? "",
        context?.id ?? "",
      ) as { effect: "allow" | "block" } | undefined;
    return row?.effect === "block";
  }
}

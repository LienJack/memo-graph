import type Database from "better-sqlite3";

import {
  GovernedSearchItemSchema,
  ProjectionRevisionSchema,
  canonicalJson,
  type ProjectionSource,
  type Scope,
} from "@memo-graph/contracts";

import {
  MemoryEligibilityInputSchema,
  ProjectionSourceBatchItemSchema,
  ProjectionSourceBatchQuerySchema,
  ProjectionSourceBatchResultSchema,
  type EligibilityReasonCode,
  type GovernedMemorySearchResult,
  type GovernedMemoryLookupResult,
  type MemoryEligibilityResult,
  type ParsedGovernedMemorySearchQuery,
  type ParsedGovernedMemoryLookupInput,
  type ParsedMemoryEligibilityInput,
  type ParsedProjectionSourceListInput,
  type ParsedProjectionSourceBatchQuery,
  type ProjectionSourceBatchItem,
  type ProjectionSourceBatchResult,
  type ProjectionSourceEligibilityReason,
  type ProjectionSourceListResult,
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

type ProjectionEligibilityRow = {
  projection_id: string;
  revision_json: string;
  revision_lifecycle: string;
  purged_at: string | null;
  object_lifecycle: string;
  current_revision_id: string | null;
  invalidated: number;
};

type ExactSourceRows = {
  preloaded_revision_ids: Set<string>;
  memory_by_revision: Map<string, string>;
  projection_by_revision: Map<string, ProjectionEligibilityRow>;
};

const EXACT_SOURCE_SQL_CHUNK = 500;
const PROJECTION_ELIGIBILITY_SELECT = `
  SELECT r.projection_revision_id, r.projection_id, r.revision_json,
         r.lifecycle AS revision_lifecycle, r.purged_at,
         o.lifecycle AS object_lifecycle, o.current_revision_id,
         EXISTS (
           SELECT 1 FROM projection_invalidations AS i
           WHERE i.projection_revision_id = r.projection_revision_id
         ) AS invalidated
  FROM projection_revisions AS r
  JOIN projection_objects AS o
    ON o.projection_id = r.projection_id`;

export function projectionSourceReason(
  reason: EligibilityReasonCode,
): ProjectionSourceEligibilityReason {
  return (
    {
      NOT_FOUND: "SOURCE_MISSING",
      WRONG_PRINCIPAL: "SOURCE_PRINCIPAL_MISMATCH",
      WRONG_SCOPE: "SOURCE_SCOPE_MISMATCH",
      SUPERSEDED: "SOURCE_SUPERSEDED",
      CANDIDATE_ONLY: "SOURCE_INACTIVE",
      QUARANTINED: "SOURCE_INACTIVE",
      REVOKED: "SOURCE_REVOKED",
      TOMBSTONED: "SOURCE_TOMBSTONED",
      NO_LIVE_EVIDENCE: "SOURCE_NO_LIVE_EVIDENCE",
      NO_ACTIVATION: "SOURCE_NO_ACTIVATION",
      NOT_YET_VALID: "SOURCE_NOT_YET_VALID",
      EXPIRED: "SOURCE_EXPIRED",
      OPEN_CONFLICT: "SOURCE_CONFLICT",
      USAGE_BLOCKED: "SOURCE_USAGE_BLOCKED",
      SENSITIVE_EXCLUDED: "SOURCE_SENSITIVE_EXCLUDED",
      SECRET_EXCLUDED: "SOURCE_SECRET_EXCLUDED",
      CONTENT_NOT_INLINE: "SOURCE_INACTIVE",
      CORRUPT_LINEAGE: "SOURCE_INVALIDATED",
    } as const
  )[reason];
}

function ineligible(
  revisionId: string,
  reasonCode: ProjectionSourceEligibilityReason,
): ProjectionSourceBatchItem {
  return ProjectionSourceBatchItemSchema.parse({
    revision_id: revisionId,
    status: "ineligible",
    reason_code: reasonCode,
  });
}

function sameProjectionSource(
  left: ProjectionSource,
  right: ProjectionSource,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

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

  listProjectionSources(
    input: ParsedProjectionSourceListInput,
  ): ProjectionSourceListResult {
    const rows = this.#database
      .prepare(
        `SELECT memory_id, current_revision_id
         FROM memory_objects
         WHERE principal_id = ?
           AND scope_kind = ?
           AND scope_id = ?
           AND current_revision_id IS NOT NULL
         ORDER BY memory_id
         LIMIT ?`,
      )
      .all(
        input.principal_id,
        input.scope.kind,
        input.scope.id,
        input.limit,
      ) as Array<{
      memory_id: string;
      current_revision_id: string;
    }>;
    const items = rows.flatMap((row) => {
      const result = this.checkEligibility(
        MemoryEligibilityInputSchema.parse({
          memory_id: row.memory_id,
          revision_id: row.current_revision_id,
          principal_id: input.principal_id,
          scope: input.scope,
          as_of: input.as_of,
          include_sensitive: input.include_sensitive,
          context_scope: input.context_scope,
        }),
      );
      return result.eligible ? [result.item] : [];
    });
    const ledgerEpoch = (
      this.#database
        .prepare(
          "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
        )
        .get() as { ledger_epoch: number }
    ).ledger_epoch;
    const tombstoneEpoch = (
      this.#database
        .prepare(
          "SELECT tombstone_epoch FROM tombstone_state WHERE singleton = 1",
        )
        .get() as { tombstone_epoch: number }
    ).tombstone_epoch;
    return {
      ledger_epoch: ledgerEpoch,
      tombstone_epoch: tombstoneEpoch,
      items,
    };
  }

  exactProjectionSources(input: unknown): ProjectionSourceBatchResult {
    const query = ProjectionSourceBatchQuerySchema.parse(input);
    return this.#database
      .transaction(() => {
        const sourceRows = this.#preloadExactSourceRows(
          query.revision_ids,
        );
        const ledgerEpoch = (
          this.#database
            .prepare(
              "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
            )
            .get() as { ledger_epoch: number }
        ).ledger_epoch;
        const tombstoneEpoch = (
          this.#database
            .prepare(
              `SELECT tombstone_epoch
               FROM tombstone_state WHERE singleton = 1`,
            )
            .get() as { tombstone_epoch: number }
        ).tombstone_epoch;
        const results = query.revision_ids.map((revisionId) =>
          this.#exactProjectionSource(
            revisionId,
            query,
            new Set(),
            sourceRows,
          )
        );
        return ProjectionSourceBatchResultSchema.parse({
          ledger_epoch: ledgerEpoch,
          tombstone_epoch: tombstoneEpoch,
          requested_revision_ids: query.revision_ids,
          requested_count: query.revision_ids.length,
          complete: true,
          results,
        });
      })
      .deferred();
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

  #exactProjectionSource(
    revisionId: string,
    query: ParsedProjectionSourceBatchQuery,
    seen: Set<string>,
    sourceRows: ExactSourceRows,
  ): ProjectionSourceBatchItem {
    if (seen.has(revisionId)) {
      return ineligible(revisionId, "SOURCE_INVALIDATED");
    }
    seen.add(revisionId);
    const preloaded = sourceRows.preloaded_revision_ids.has(revisionId);
    const memoryId =
      sourceRows.memory_by_revision.get(revisionId) ??
      (preloaded
        ? undefined
        : (this.#database
            .prepare(
              `SELECT memory_id
               FROM memory_revisions
               WHERE revision_id = ?`,
            )
            .get(revisionId) as { memory_id: string } | undefined)
            ?.memory_id);
    if (memoryId !== undefined) {
      const result = this.checkEligibility(
        MemoryEligibilityInputSchema.parse({
          memory_id: memoryId,
          revision_id: revisionId,
          principal_id: query.principal_id,
          scope: query.scope,
          as_of: query.as_of,
          include_sensitive: query.include_sensitive,
          context_scope: query.context_scope,
        }),
      );
      if (!result.eligible) {
        return ineligible(
          revisionId,
          projectionSourceReason(result.reason_code),
        );
      }
      return ProjectionSourceBatchItemSchema.parse({
        revision_id: revisionId,
        status: "eligible",
        source: {
          memory_id: result.item.memory_id,
          revision_id: result.item.revision_id,
          abstraction: "l1_memory",
          principal_id: query.principal_id,
          scope: result.item.scope,
          authority: result.item.authority,
          sensitivity: result.item.sensitivity,
          validity: result.item.validity,
          content_hash: result.item.content_hash,
          evidence_ids: result.item.evidence_ids,
        },
      });
    }

    const row =
      sourceRows.projection_by_revision.get(revisionId) ??
      (preloaded
        ? undefined
        : this.#database
            .prepare(
              `${PROJECTION_ELIGIBILITY_SELECT}
               WHERE r.projection_revision_id = ?`,
            )
            .get(revisionId) as ProjectionEligibilityRow | undefined);
    if (row === undefined) {
      const tombstone = this.#database
        .prepare(
          `SELECT 1 FROM memory_tombstones WHERE revision_id = ?`,
        )
        .get(revisionId);
      return ineligible(
        revisionId,
        tombstone === undefined
          ? "SOURCE_MISSING"
          : "SOURCE_TOMBSTONED",
      );
    }
    if (
      row.purged_at !== null ||
      row.revision_lifecycle === "purged" ||
      row.object_lifecycle === "purged"
    ) {
      return ineligible(revisionId, "SOURCE_PURGED");
    }
    if (
      row.revision_lifecycle === "revoked" ||
      row.object_lifecycle === "revoked"
    ) {
      return ineligible(revisionId, "SOURCE_REVOKED");
    }
    if (row.current_revision_id !== revisionId) {
      return ineligible(revisionId, "SOURCE_SUPERSEDED");
    }
    if (
      row.revision_lifecycle !== "active" ||
      row.object_lifecycle !== "active"
    ) {
      return ineligible(revisionId, "SOURCE_INACTIVE");
    }
    if (row.invalidated !== 0) {
      return ineligible(revisionId, "SOURCE_INVALIDATED");
    }
    let projection: ReturnType<typeof ProjectionRevisionSchema.parse>;
    try {
      projection = ProjectionRevisionSchema.parse(
        JSON.parse(row.revision_json) as unknown,
      );
    } catch {
      return ineligible(revisionId, "SOURCE_INVALIDATED");
    }
    if (projection.principal_id !== query.principal_id) {
      return ineligible(revisionId, "SOURCE_PRINCIPAL_MISMATCH");
    }
    if (
      projection.scope.kind !== query.scope.kind ||
      projection.scope.id !== query.scope.id
    ) {
      return ineligible(revisionId, "SOURCE_SCOPE_MISMATCH");
    }
    if (Date.parse(projection.validity.valid_from) > Date.parse(query.as_of)) {
      return ineligible(revisionId, "SOURCE_NOT_YET_VALID");
    }
    if (
      projection.validity.valid_to !== null &&
      Date.parse(projection.validity.valid_to) < Date.parse(query.as_of)
    ) {
      return ineligible(revisionId, "SOURCE_EXPIRED");
    }
    if (projection.sensitivity === "secret") {
      return ineligible(revisionId, "SOURCE_SECRET_EXCLUDED");
    }
    if (
      projection.sensitivity === "sensitive" &&
      !query.include_sensitive
    ) {
      return ineligible(revisionId, "SOURCE_SENSITIVE_EXCLUDED");
    }
    for (const source of projection.source_revisions) {
      const canonical = this.#exactProjectionSource(
        source.revision_id,
        query,
        new Set(seen),
        sourceRows,
      );
      if (canonical.status === "ineligible") {
        return ineligible(revisionId, canonical.reason_code);
      }
      if (!sameProjectionSource(source, canonical.source)) {
        return ineligible(revisionId, "SOURCE_INVALIDATED");
      }
    }
    if (projection.abstraction === "l3_core") {
      return ineligible(revisionId, "SOURCE_INVALIDATED");
    }
    return ProjectionSourceBatchItemSchema.parse({
      revision_id: revisionId,
      status: "eligible",
      source: {
        memory_id: projection.projection_id,
        revision_id: projection.projection_revision_id,
        abstraction: projection.abstraction,
        principal_id: projection.principal_id,
        scope: projection.scope,
        authority: projection.authority,
        sensitivity: projection.sensitivity,
        validity: projection.validity,
        content_hash: projection.content_hash,
        evidence_ids: projection.evidence_ids,
      },
    });
  }

  #preloadExactSourceRows(
    revisionIds: readonly string[],
  ): ExactSourceRows {
    const memoryByRevision = new Map<string, string>();
    const projectionByRevision = new Map<
      string,
      ProjectionEligibilityRow
    >();
    for (
      let offset = 0;
      offset < revisionIds.length;
      offset += EXACT_SOURCE_SQL_CHUNK
    ) {
      const chunk = revisionIds.slice(
        offset,
        offset + EXACT_SOURCE_SQL_CHUNK,
      );
      const placeholders = chunk.map(() => "?").join(", ");
      const memoryRows = this.#database
        .prepare(
          `SELECT revision_id, memory_id
           FROM memory_revisions
           WHERE revision_id IN (${placeholders})`,
        )
        .all(...chunk) as Array<{
        revision_id: string;
        memory_id: string;
      }>;
      for (const row of memoryRows) {
        memoryByRevision.set(row.revision_id, row.memory_id);
      }
      const projectionRows = this.#database
        .prepare(
          `${PROJECTION_ELIGIBILITY_SELECT}
           WHERE r.projection_revision_id IN (${placeholders})`,
        )
        .all(...chunk) as Array<
        ProjectionEligibilityRow & { projection_revision_id: string }
      >;
      for (const row of projectionRows) {
        projectionByRevision.set(row.projection_revision_id, row);
      }
    }
    return {
      preloaded_revision_ids: new Set(revisionIds),
      memory_by_revision: memoryByRevision,
      projection_by_revision: projectionByRevision,
    };
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

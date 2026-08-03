import type Database from "better-sqlite3";

import {
  WorkbenchMemoryCandidateSetSchema,
  WorkbenchMemoryDetailResultSchema,
  WorkbenchGraphResultSchema,
  WorkbenchGraphEdgeSchema,
  WorkbenchGraphNodeSchema,
  WorkbenchMemoryGroupSchema,
  WorkbenchMemorySummaryBatchResultSchema,
  WorkbenchMemorySummarySchema,
  CanonicalHashSchema,
  ScopeSchema,
  canonicalSha256,
  scopeKey,
  type Scope,
  type WorkbenchContent,
  type WorkbenchMemoryDetailResult,
  type WorkbenchGraphResult,
  type WorkbenchMemorySummary,
} from "@memo-graph/contracts";

import type { GovernedMemoryReader } from "./governed-memory-reader.js";
import {
  MemoryEligibilityInputSchema,
  type EligibilityReasonCode,
  type ParsedWorkbenchMemoryDetailQuery,
  type ParsedWorkbenchGraphQuery,
  type ParsedWorkbenchMemoryListQuery,
  type ParsedWorkbenchMemorySummaryBatchQuery,
  type WorkbenchMemoryCandidateSet,
  type WorkbenchMemorySummaryBatchResult,
} from "./protocol.js";

type RevisionRow = {
  memory_id: string;
  logical_key_hash: string;
  principal_id: string;
  object_scope_kind: Scope["kind"];
  object_scope_id: string;
  object_lifecycle: string;
  current_revision_id: string | null;
  context_eligible: number;
  pinned: number;
  revision_id: string;
  revision: number;
  abstraction: "l1_memory";
  revision_lifecycle:
    | "working"
    | "candidate"
    | "active"
    | "superseded"
    | "revoked"
    | "quarantined"
    | "purged";
  kind: "episodic" | "semantic" | "procedural";
  scope_kind: Scope["kind"];
  scope_id: string;
  authority:
    | "user_stated"
    | "observed"
    | "tool_result"
    | "inferred"
    | "derived"
    | "imported";
  sensitivity:
    | "public"
    | "internal"
    | "personal"
    | "sensitive"
    | "secret";
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  content_storage: "inline" | "blob" | "redacted";
  content_inline: string | null;
  media_type: string;
  content_hash: `sha256:${string}`;
  supersedes_revision_id: string | null;
  purged_at: string | null;
};

type EvidenceRow = {
  evidence_id: string;
  principal_id: string;
  scope_kind: Scope["kind"];
  scope_id: string;
  payload_storage: "inline" | "blob";
  payload_inline: string | null;
  media_type: string;
  content_hash: `sha256:${string}`;
  sensitivity:
    | "public"
    | "internal"
    | "personal"
    | "sensitive"
    | "secret";
  purged_at: string | null;
};

type ProjectionRow = {
  projection_id: string;
  projection_revision_id: string;
  current_revision_id: string | null;
  projection_type: "topic" | "scenario" | "procedure" | "relation" | "core";
  lifecycle: RevisionRow["revision_lifecycle"];
  principal_id: string;
  scope_kind: Scope["kind"];
  scope_id: string;
  sensitivity: RevisionRow["sensitivity"];
  valid_from: string;
  valid_to: string | null;
  payload_json: string | null;
  content_json: string | null;
  content_hash: `sha256:${string}`;
};

type GraphNode = Extract<
  WorkbenchGraphResult,
  { status: "ready" | "ready_empty" | "degraded" }
>["nodes"][number];

type GraphEdge = Extract<
  WorkbenchGraphResult,
  { status: "ready" | "ready_empty" | "degraded" }
>["edges"][number];

type GraphNeighbor = {
  neighbor_revision_id: string;
  edge: GraphEdge;
};

const REVISION_SELECT = `
  SELECT o.memory_id, o.logical_key_hash, o.principal_id,
         o.scope_kind AS object_scope_kind,
         o.scope_id AS object_scope_id,
         o.lifecycle AS object_lifecycle, o.current_revision_id,
         o.context_eligible, o.pinned,
         r.revision_id, r.revision, r.abstraction,
         r.lifecycle AS revision_lifecycle, r.kind,
         r.scope_kind, r.scope_id, r.authority, r.sensitivity,
         r.valid_from, r.valid_to, r.recorded_at,
         r.content_storage, r.content_inline, r.media_type,
         r.content_hash, r.supersedes_revision_id, r.purged_at
  FROM memory_objects AS o
  JOIN memory_revisions AS r ON r.memory_id = o.memory_id`;

function queryTerms(query: string): string[] {
  return (query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(
    0,
    32,
  );
}

function mappedReason(reason: EligibilityReasonCode): WorkbenchMemorySummary["non_current_reason"] {
  if (reason === "WRONG_PRINCIPAL" || reason === "WRONG_SCOPE" || reason === "NOT_FOUND") {
    return "CORRUPT_LINEAGE";
  }
  return reason;
}

function historicalReason(row: RevisionRow): NonNullable<WorkbenchMemorySummary["non_current_reason"]> {
  return (
    {
      working: "CANDIDATE_ONLY",
      candidate: "CANDIDATE_ONLY",
      active: "SUPERSEDED",
      superseded: "SUPERSEDED",
      revoked: "REVOKED",
      quarantined: "QUARANTINED",
      purged: "TOMBSTONED",
    } as const
  )[row.revision_lifecycle];
}

function content(
  row: RevisionRow,
  includeSensitive = true,
): WorkbenchContent {
  if (
    row.sensitivity === "secret" ||
    (row.sensitivity === "sensitive" && !includeSensitive)
  ) {
    return {
      status: "not_permitted",
      reason_code:
        row.sensitivity === "secret"
          ? "SECRET_EXCLUDED"
          : "SENSITIVE_EXCLUDED",
    };
  }
  if (row.purged_at !== null || row.content_storage === "redacted") {
    return { status: "purged", reason_code: "PURGED" };
  }
  if (row.content_storage === "blob" || row.content_inline === null) {
    return { status: "blob_unavailable", reason_code: "CONTENT_NOT_INLINE" };
  }
  return {
    status: "available",
    text: row.content_inline,
    media_type: row.media_type,
    content_hash: CanonicalHashSchema.parse(row.content_hash),
  };
}

function evidenceContent(
  row: EvidenceRow,
  includeSensitive: boolean,
): WorkbenchContent {
  if (
    row.sensitivity === "secret" ||
    (row.sensitivity === "sensitive" && !includeSensitive)
  ) {
    return {
      status: "not_permitted",
      reason_code:
        row.sensitivity === "secret"
          ? "SECRET_EXCLUDED"
          : "SENSITIVE_EXCLUDED",
    };
  }
  if (row.purged_at !== null) {
    return { status: "purged", reason_code: "PURGED" };
  }
  if (row.payload_storage === "blob" || row.payload_inline === null) {
    return { status: "blob_unavailable", reason_code: "CONTENT_NOT_INLINE" };
  }
  return {
    status: "available",
    text: row.payload_inline,
    media_type: row.media_type,
    content_hash: CanonicalHashSchema.parse(row.content_hash),
  };
}

function group(scope: Scope): WorkbenchMemorySummary["group"] {
  if (scope.kind === "workspace") {
    return WorkbenchMemoryGroupSchema.parse({
      kind: "workspace_project",
      scope,
    });
  }
  if (scope.kind === "topic") {
    return WorkbenchMemoryGroupSchema.parse({ kind: "topic", scope });
  }
  return WorkbenchMemoryGroupSchema.parse({ kind: "other", scope });
}

function edgeId(value: unknown): string {
  return `edge:${canonicalSha256(value).slice("sha256:".length, 55)}`;
}

export class WorkbenchReader {
  readonly #database: Database.Database;
  readonly #governed: GovernedMemoryReader;

  constructor(database: Database.Database, governed: GovernedMemoryReader) {
    this.#database = database;
    this.#governed = governed;
  }

  list(input: ParsedWorkbenchMemoryListQuery): WorkbenchMemoryCandidateSet {
    const { sql, parameters } = this.#listSql(input);
    const rows = this.#database
      .prepare(`${sql} LIMIT ?`)
      .all(...parameters, input.max_snapshot_members + 1) as RevisionRow[];
    const truncated = rows.length > input.max_snapshot_members;
    const total = truncated
      ? Number(
          (
            this.#database
              .prepare(`SELECT count(*) AS count FROM (${sql})`)
              .get(...parameters) as { count: number | bigint }
          ).count,
        )
      : rows.length;
    const boundedRows = rows.slice(0, input.max_snapshot_members);
    const items: WorkbenchMemorySummary[] = [];
    const reasons = new Set<NonNullable<WorkbenchMemorySummary["non_current_reason"]>>();
    let excludedCount = 0;
    for (const row of boundedRows) {
      const result = this.#summary(row, input);
      if (result === null) {
        excludedCount += 1;
        continue;
      }
      if (
        result.non_current_reason === "SECRET_EXCLUDED" ||
        result.non_current_reason === "SENSITIVE_EXCLUDED"
      ) {
        excludedCount += 1;
        reasons.add(result.non_current_reason);
        continue;
      }
      if (result.non_current_reason !== null && !input.request.include_non_current) {
        excludedCount += 1;
        reasons.add(result.non_current_reason);
        continue;
      }
      if (result.non_current_reason !== null) {
        reasons.add(result.non_current_reason);
      }
      items.push(result);
    }
    const epochs = this.#epochs();
    return WorkbenchMemoryCandidateSetSchema.parse({
      frontier_hash: canonicalSha256(epochs),
      items,
      candidate_space_truncated: truncated,
      omitted_count: Math.max(0, total - boundedRows.length),
      excluded_count: excludedCount,
      exclusion_reason_codes: [...reasons].sort(),
      warnings: truncated ? ["candidate_space_truncated"] : [],
    });
  }

  summaries(
    input: ParsedWorkbenchMemorySummaryBatchQuery,
  ): WorkbenchMemorySummaryBatchResult {
    const items: WorkbenchMemorySummary[] = [];
    const reasons = new Set<NonNullable<WorkbenchMemorySummary["non_current_reason"]>>();
    let missingCount = 0;
    for (const member of input.members) {
      const row = this.#revision(member.memory_id, member.revision_id);
      if (row === undefined || !this.#rowIsAllowed(row, input.allowed_scopes, input.principal_id)) {
        missingCount += 1;
        continue;
      }
      const summary = this.#summary(row, {
        ...input,
        max_snapshot_members: input.members.length,
        request: {
          query: null,
          scope: null,
          kinds: [],
          lifecycles: [],
          authorities: [],
          sources: [],
          recorded_after: null,
          recorded_before: null,
          include_non_current: true,
          limit: input.members.length,
          cursor: null,
        },
      });
      if (summary === null) {
        missingCount += 1;
        continue;
      }
      items.push(summary);
      if (summary.non_current_reason !== null) {
        reasons.add(summary.non_current_reason);
      }
    }
    return WorkbenchMemorySummaryBatchResultSchema.parse({
      items,
      missing_count: missingCount,
      reason_codes: [...reasons].sort(),
    });
  }

  detail(
    input: ParsedWorkbenchMemoryDetailQuery,
  ): WorkbenchMemoryDetailResult {
    const object = this.#database
      .prepare(
        `SELECT memory_id, logical_key_hash, principal_id,
                scope_kind, scope_id, current_revision_id
         FROM memory_objects WHERE memory_id = ?`,
      )
      .get(input.request.memory_id) as
      | {
          memory_id: string;
          logical_key_hash: string;
          principal_id: string;
          scope_kind: Scope["kind"];
          scope_id: string;
          current_revision_id: string | null;
        }
      | undefined;
    const allowed = new Set(input.allowed_scopes.map(scopeKey));
    if (
      object === undefined ||
      object.principal_id !== input.principal_id ||
      !allowed.has(
        scopeKey(
          ScopeSchema.parse({ kind: object.scope_kind, id: object.scope_id }),
        ),
      )
    ) {
      return WorkbenchMemoryDetailResultSchema.parse({
        status: "not_found",
        reason_code: "NOT_FOUND",
        retryable: false,
        warnings: [],
      });
    }
    const selectedRevisionId =
      input.request.revision_id ??
      object.current_revision_id ??
      (this.#database
        .prepare(
          `SELECT revision_id FROM memory_revisions
           WHERE memory_id = ? ORDER BY revision DESC LIMIT 1`,
        )
        .get(object.memory_id) as { revision_id: string } | undefined)
        ?.revision_id;
    if (selectedRevisionId === undefined) {
      return WorkbenchMemoryDetailResultSchema.parse({
        status: "not_found",
        reason_code: "NOT_FOUND",
        retryable: false,
        warnings: [],
      });
    }
    const selected = this.#revision(object.memory_id, selectedRevisionId);
    if (selected === undefined) {
      return WorkbenchMemoryDetailResultSchema.parse({
        status: "not_found",
        reason_code: "REVISION_NOT_FOUND",
        retryable: false,
        warnings: [],
      });
    }
    const summary = this.#summary(selected, {
      ...input,
      max_snapshot_members: 1,
      request: {
        query: null,
        scope: null,
        kinds: [],
        lifecycles: [],
        authorities: [],
        sources: [],
        recorded_after: null,
        recorded_before: null,
        include_non_current: true,
        limit: 1,
        cursor: null,
      },
    });
    if (summary === null) {
      return WorkbenchMemoryDetailResultSchema.parse({
        status: "not_found",
        reason_code: "NOT_FOUND",
        retryable: false,
        warnings: [],
      });
    }
    if (
      summary.non_current_reason === "SECRET_EXCLUDED" ||
      summary.non_current_reason === "SENSITIVE_EXCLUDED" ||
      (input.request.revision_id === null &&
        summary.non_current_reason !== null)
    ) {
      return WorkbenchMemoryDetailResultSchema.parse({
        status: "governance_excluded",
        memory_id: summary.memory_id,
        revision_id: summary.revision_id,
        reason_code: summary.non_current_reason,
        warnings: [],
      });
    }
    const historyRows = this.#database
      .prepare(
        `${REVISION_SELECT}
         WHERE o.memory_id = ?
         ORDER BY r.revision DESC, r.revision_id
         LIMIT ?`,
      )
      .all(object.memory_id, input.max_history + 1) as RevisionRow[];
    const historyTruncated = historyRows.length > input.max_history;
    const boundedHistory = historyRows.slice(0, input.max_history);
    const history = boundedHistory.map((row) => ({
      revision_id: row.revision_id,
      revision: row.revision,
      lifecycle: row.revision_lifecycle,
      authority: row.authority,
      validity: {
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        recorded_at: row.recorded_at,
      },
      content: content(row, input.include_sensitive),
      is_current: row.revision_id === object.current_revision_id,
      supersedes_revision_id: row.supersedes_revision_id,
    }));
    const provenance = this.#provenance(
      boundedHistory,
      input.max_provenance_nodes,
      input.include_sensitive,
    );
    const warnings = [
      ...(historyTruncated ? ["history_truncated"] : []),
      ...(provenance.truncated ? ["provenance_truncated"] : []),
    ];
    return WorkbenchMemoryDetailResultSchema.parse({
      status: "ready",
      memory: {
        ...summary,
        current_revision_id: object.current_revision_id,
        conflicts: this.#conflicts(object),
        projection_state: this.#projectionState(selected.revision_id),
      },
      history,
      provenance,
      warnings,
    });
  }

  graph(input: ParsedWorkbenchGraphQuery): WorkbenchGraphResult {
    const center = this.#graphNode(
      input.request.center.kind,
      input.request.center.revision_id,
      input,
    );
    if (center === null) {
      return WorkbenchGraphResultSchema.parse({
        status: "not_found",
        reason_code: "GRAPH_CENTER_NOT_FOUND",
        retryable: false,
        warnings: [],
      });
    }

    const nodes = new Map<string, GraphNode>([[center.node_id, center]]);
    const edges = new Map<string, GraphEdge>();
    const omittedNodes = new Set<string>();
    const omittedEdges = new Set<string>();
    const visited = new Set<string>();
    let frontier: string[] = [center.node_id];
    for (
      let depth = 0;
      depth < input.request.max_depth && frontier.length > 0;
      depth += 1
    ) {
      const next = new Set<string>();
      for (const revisionId of [...frontier].sort()) {
        if (visited.has(revisionId)) {
          continue;
        }
        visited.add(revisionId);
        const observed = this.#graphNeighbors(revisionId, input);
        const retained = observed.slice(0, input.request.max_fanout);
        for (const omitted of observed.slice(input.request.max_fanout)) {
          omittedNodes.add(omitted.neighbor_revision_id);
          omittedEdges.add(omitted.edge.edge_id);
        }
        for (const neighbor of retained) {
          if (!nodes.has(neighbor.neighbor_revision_id)) {
            const node = this.#graphNode(
              null,
              neighbor.neighbor_revision_id,
              input,
            );
            if (node === null || nodes.size >= input.request.max_nodes) {
              omittedNodes.add(neighbor.neighbor_revision_id);
              omittedEdges.add(neighbor.edge.edge_id);
              continue;
            }
            nodes.set(node.node_id, node);
            next.add(node.node_id);
          }
          if (
            !nodes.has(neighbor.edge.from_node_id) ||
            !nodes.has(neighbor.edge.to_node_id)
          ) {
            omittedEdges.add(neighbor.edge.edge_id);
          } else if (
            !edges.has(neighbor.edge.edge_id) &&
            edges.size >= input.request.max_edges
          ) {
            omittedEdges.add(neighbor.edge.edge_id);
          } else {
            edges.set(neighbor.edge.edge_id, neighbor.edge);
          }
        }
      }
      frontier = [...next];
    }

    const projectionState = this.#graphProjectionState(
      input.principal_id,
      input.request.scope,
    );
    const truncated = omittedNodes.size + omittedEdges.size > 0;
    const warnings = [
      ...(projectionState === "ready"
        ? []
        : [`graph_projection_${projectionState}`]),
      ...(truncated ? ["graph_snapshot_truncated"] : []),
      ...(!center.is_current ? ["historical_center"] : []),
    ];
    const status =
      projectionState !== "ready" || truncated
        ? "degraded"
        : edges.size === 0
          ? "ready_empty"
          : "ready";
    return WorkbenchGraphResultSchema.parse({
      status,
      center_node_id: center.node_id,
      nodes: [...nodes.values()].sort((left, right) =>
        left.node_id.localeCompare(right.node_id)
      ),
      edges: [...edges.values()].sort((left, right) =>
        left.edge_id.localeCompare(right.edge_id)
      ),
      projection_state: projectionState,
      truncated,
      omitted_node_count: omittedNodes.size,
      omitted_edge_count: omittedEdges.size,
      warnings,
    });
  }

  #listSql(input: ParsedWorkbenchMemoryListQuery): {
    sql: string;
    parameters: unknown[];
  } {
    const request = input.request;
    const scopes = request.scope === null ? input.allowed_scopes : [request.scope];
    const where = ["o.principal_id = ?"];
    const parameters: unknown[] = [input.principal_id];
    where.push(
      `(${scopes.map(() => "(o.scope_kind = ? AND o.scope_id = ?)").join(" OR ")})`,
    );
    for (const scope of scopes) {
      parameters.push(scope.kind, scope.id);
    }
    if (!request.include_non_current) {
      where.push("r.revision_id = o.current_revision_id");
    }
    const inFilter = (column: string, values: readonly string[]) => {
      if (values.length === 0) return;
      where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
      parameters.push(...values);
    };
    inFilter("r.kind", request.kinds);
    inFilter("r.lifecycle", request.lifecycles);
    inFilter("r.authority", request.authorities);
    if (request.sources.length > 0) {
      where.push(
        `EXISTS (
           SELECT 1 FROM memory_revision_evidence AS re
           JOIN evidence_events AS e ON e.evidence_id = re.evidence_id
           WHERE re.revision_id = r.revision_id
             AND e.source IN (${request.sources.map(() => "?").join(", ")})
         )`,
      );
      parameters.push(...request.sources);
    }
    if (request.recorded_after !== null) {
      where.push("r.recorded_at >= ?");
      parameters.push(request.recorded_after);
    }
    if (request.recorded_before !== null) {
      where.push("r.recorded_at <= ?");
      parameters.push(request.recorded_before);
    }
    if (request.query !== null) {
      for (const term of queryTerms(request.query)) {
        where.push("instr(lower(coalesce(r.content_inline, '')), ?) > 0");
        parameters.push(term);
      }
    }
    return {
      sql: `${REVISION_SELECT}
            WHERE ${where.join(" AND ")}
            ORDER BY
              CASE r.scope_kind WHEN 'workspace' THEN 0 WHEN 'topic' THEN 1 ELSE 2 END,
              r.scope_kind, r.scope_id, r.recorded_at DESC,
              o.memory_id, r.revision DESC, r.revision_id`,
      parameters,
    };
  }

  #summary(
    row: RevisionRow,
    input: Pick<
      ParsedWorkbenchMemoryListQuery,
      "principal_id" | "allowed_scopes" | "as_of" | "include_sensitive" | "context_scope"
    > & { request: ParsedWorkbenchMemoryListQuery["request"]; max_snapshot_members: number },
  ): WorkbenchMemorySummary | null {
    if (!this.#rowIsAllowed(row, input.allowed_scopes, input.principal_id)) {
      return null;
    }
    if (row.sensitivity === "secret") {
      return this.#rowSummary(row, false, "SECRET_EXCLUDED", {
        status: "not_permitted",
        reason_code: "SECRET_EXCLUDED",
      });
    }
    if (row.sensitivity === "sensitive" && !input.include_sensitive) {
      return this.#rowSummary(row, false, "SENSITIVE_EXCLUDED", {
        status: "not_permitted",
        reason_code: "SENSITIVE_EXCLUDED",
      });
    }
    if (row.revision_id !== row.current_revision_id) {
      return this.#rowSummary(row, false, historicalReason(row));
    }
    const eligibility = this.#governed.checkEligibility(
      MemoryEligibilityInputSchema.parse({
        memory_id: row.memory_id,
        revision_id: row.revision_id,
        principal_id: input.principal_id,
        scope: { kind: row.scope_kind, id: row.scope_id },
        as_of: input.as_of,
        include_sensitive: input.include_sensitive,
        context_scope: input.context_scope,
      }),
    );
    if (!eligibility.eligible) {
      return this.#rowSummary(row, false, mappedReason(eligibility.reason_code));
    }
    return this.#rowSummary(row, true, null);
  }

  #rowSummary(
    row: RevisionRow,
    writable: boolean,
    nonCurrentReason: WorkbenchMemorySummary["non_current_reason"],
    contentOverride?: WorkbenchContent,
  ): WorkbenchMemorySummary {
    const scope = ScopeSchema.parse({
      kind: row.scope_kind,
      id: row.scope_id,
    });
    return WorkbenchMemorySummarySchema.parse({
      memory_id: row.memory_id,
      revision_id: row.revision_id,
      revision: row.revision,
      abstraction: "l1_memory",
      lifecycle: row.revision_lifecycle,
      kind: row.kind,
      scope,
      group: group(scope),
      authority: row.authority,
      sensitivity: row.sensitivity,
      validity: {
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        recorded_at: row.recorded_at,
      },
      content: contentOverride ?? content(row),
      is_current: nonCurrentReason === null,
      writable,
      non_current_reason: nonCurrentReason,
    });
  }

  #rowIsAllowed(
    row: RevisionRow,
    allowedScopes: readonly Scope[],
    principalId: string,
  ): boolean {
    const allowed = new Set(allowedScopes.map(scopeKey));
    return (
      row.principal_id === principalId &&
      row.scope_kind === row.object_scope_kind &&
      row.scope_id === row.object_scope_id &&
      allowed.has(
        scopeKey(ScopeSchema.parse({ kind: row.scope_kind, id: row.scope_id })),
      )
    );
  }

  #revision(memoryId: string, revisionId: string): RevisionRow | undefined {
    return this.#database
      .prepare(
        `${REVISION_SELECT}
         WHERE o.memory_id = ? AND r.revision_id = ?`,
      )
      .get(memoryId, revisionId) as RevisionRow | undefined;
  }

  #epochs(): { ledger_epoch: number; tombstone_epoch: number } {
    return this.#database
      .prepare(
        `SELECT
           (SELECT ledger_epoch FROM ledger_state WHERE singleton = 1) AS ledger_epoch,
           (SELECT tombstone_epoch FROM tombstone_state WHERE singleton = 1) AS tombstone_epoch`,
      )
      .get() as { ledger_epoch: number; tombstone_epoch: number };
  }

  #conflicts(object: {
    logical_key_hash: string;
    principal_id: string;
    scope_kind: Scope["kind"];
    scope_id: string;
  }) {
    return this.#database
      .prepare(
        `SELECT g.conflict_group_id, g.status, g.resolved_revision_id,
                count(c.candidate_id) AS candidate_count
         FROM memory_conflict_groups AS g
         JOIN memory_conflict_candidates AS c
           ON c.conflict_group_id = g.conflict_group_id
         WHERE g.logical_key_hash = ? AND g.principal_id = ?
           AND g.scope_kind = ? AND g.scope_id = ?
         GROUP BY g.conflict_group_id
         ORDER BY g.created_at, g.conflict_group_id`,
      )
      .all(
        object.logical_key_hash,
        object.principal_id,
        object.scope_kind,
        object.scope_id,
      );
  }

  #projectionState(revisionId: string) {
    const rows = this.#database
      .prepare(
        `SELECT status FROM projection_outbox_jobs
         WHERE EXISTS (
           SELECT 1 FROM json_each(source_revision_ids_json)
           WHERE value = ?
         )`,
      )
      .all(revisionId) as Array<{
      status: "pending" | "processing" | "processed" | "failed";
    }>;
    if (rows.some((row) => row.status === "failed")) return "failed" as const;
    if (rows.some((row) => row.status === "processing")) return "rebuilding" as const;
    if (rows.some((row) => row.status === "pending")) return "pending" as const;
    return "ready" as const;
  }

  #graphProjectionState(principalId: string, scope: Scope) {
    const row = this.#database
      .prepare(
        `SELECT status FROM graph_projection_scope_state
         WHERE backend = 'ladybugdb' AND principal_id = ?
           AND scope_kind = ? AND scope_id = ?`,
      )
      .get(principalId, scope.kind, scope.id) as
      | { status: "disabled" | "pending" | "rebuilding" | "ready" | "unavailable" }
      | undefined;
    if (row?.status === "ready") return "ready" as const;
    if (row?.status === "pending") return "pending" as const;
    if (row?.status === "rebuilding") return "rebuilding" as const;
    return "unavailable" as const;
  }

  #graphNode(
    expectedKind: "memory_revision" | "projection_revision" | null,
    revisionId: string,
    input: ParsedWorkbenchGraphQuery,
  ): GraphNode | null {
    if (expectedKind !== "projection_revision") {
      const row = this.#revisionById(revisionId);
      if (
        row !== undefined &&
        row.principal_id === input.principal_id &&
        row.scope_kind === input.request.scope.kind &&
        row.scope_id === input.request.scope.id
      ) {
        const summary = this.#summary(row, {
          ...input,
          max_snapshot_members: 1,
          request: {
            query: null,
            scope: input.request.scope,
            kinds: [],
            lifecycles: [],
            authorities: [],
            sources: [],
            recorded_after: null,
            recorded_before: null,
            include_non_current: true,
            limit: 1,
            cursor: null,
          },
        });
        if (
          summary !== null &&
          summary.non_current_reason !== "SECRET_EXCLUDED" &&
          summary.non_current_reason !== "SENSITIVE_EXCLUDED"
        ) {
          const label = summary.content.status === "available"
            ? summary.content.text
            : `Memory revision ${summary.revision}`;
          return WorkbenchGraphNodeSchema.parse({
            node_id: summary.revision_id,
            kind: "memory_revision",
            authority_plane: "canonical",
            reference_id: summary.memory_id,
            revision_id: summary.revision_id,
            label: label.slice(0, 8_000),
            scope: summary.scope,
            lifecycle: summary.lifecycle,
            is_current: summary.is_current,
            content: summary.content,
          });
        }
      }
      if (expectedKind === "memory_revision") {
        return null;
      }
    }
    const projection = this.#projectionRevision(revisionId, input);
    if (
      projection === undefined ||
      projection.projection_type === "relation" ||
      projection.sensitivity === "secret" ||
      (projection.sensitivity === "sensitive" && !input.include_sensitive)
    ) {
      return null;
    }
    const projectionContent = this.#projectionContent(projection);
    return WorkbenchGraphNodeSchema.parse({
      node_id: projection.projection_revision_id,
      kind: projection.projection_type,
      authority_plane: "projection",
      reference_id: projection.projection_id,
      revision_id: projection.projection_revision_id,
      label: this.#projectionLabel(projection, projectionContent),
      scope: { kind: projection.scope_kind, id: projection.scope_id },
      lifecycle: projection.lifecycle,
      is_current:
        projection.projection_revision_id === projection.current_revision_id,
      content: projectionContent,
    });
  }

  #graphNeighbors(
    revisionId: string,
    input: ParsedWorkbenchGraphQuery,
  ): GraphNeighbor[] {
    const limit = input.request.max_fanout + 1;
    const lineage = this.#database
      .prepare(
        `SELECT s.projection_revision_id, s.source_revision_id
         FROM projection_revision_sources AS s
         JOIN projection_revisions AS p
           ON p.projection_revision_id = s.projection_revision_id
         JOIN projection_objects AS o
           ON o.projection_id = p.projection_id
          AND o.current_revision_id = p.projection_revision_id
         WHERE (s.source_revision_id = ? OR s.projection_revision_id = ?)
           AND p.principal_id = ? AND p.scope_kind = ? AND p.scope_id = ?
           AND p.projection_type <> 'relation'
           AND p.sensitivity <> 'secret'
           AND (? = 1 OR p.sensitivity <> 'sensitive')
           AND o.lifecycle = 'active' AND p.lifecycle = 'active'
           AND p.purged_at IS NULL AND p.valid_from <= ?
           AND (p.valid_to IS NULL OR p.valid_to > ?)
           AND NOT EXISTS (
             SELECT 1 FROM projection_invalidations AS i
             WHERE i.projection_revision_id = p.projection_revision_id
           )
         ORDER BY s.projection_revision_id, s.ordinal
         LIMIT ?`,
      )
      .all(
        revisionId,
        revisionId,
        input.principal_id,
        input.request.scope.kind,
        input.request.scope.id,
        input.include_sensitive ? 1 : 0,
        input.as_of,
        input.as_of,
        limit,
      ) as Array<{
        projection_revision_id: string;
        source_revision_id: string;
      }>;
    const relations = this.#database
      .prepare(
        `SELECT r.relation_id, r.relation_revision_id,
                r.source_revision_id, r.target_revision_id,
                r.relation_type, r.direction, r.description
         FROM relation_revisions AS r
         JOIN relation_objects AS o
           ON o.relation_id = r.relation_id
          AND o.current_relation_revision_id = r.relation_revision_id
         JOIN projection_revisions AS p
           ON p.projection_revision_id = r.projection_revision_id
         WHERE (r.source_revision_id = ? OR r.target_revision_id = ?)
           AND r.principal_id = ? AND r.scope_kind = ? AND r.scope_id = ?
           AND p.sensitivity <> 'secret'
           AND (? = 1 OR p.sensitivity <> 'sensitive')
           AND o.lifecycle = 'active' AND r.lifecycle = 'active'
           AND p.purged_at IS NULL AND r.valid_from <= ?
           AND (r.valid_to IS NULL OR r.valid_to > ?)
           AND NOT EXISTS (
             SELECT 1 FROM projection_invalidations AS i
             WHERE i.projection_revision_id = r.projection_revision_id
           )
         ORDER BY r.relation_type, r.relation_id, r.relation_revision_id
         LIMIT ?`,
      )
      .all(
        revisionId,
        revisionId,
        input.principal_id,
        input.request.scope.kind,
        input.request.scope.id,
        input.include_sensitive ? 1 : 0,
        input.as_of,
        input.as_of,
        limit,
      ) as Array<{
        relation_id: string;
        relation_revision_id: string;
        source_revision_id: string;
        target_revision_id: string;
        relation_type: GraphEdge["relation"];
        direction: GraphEdge["direction"];
        description: string | null;
      }>;
    const neighbors: GraphNeighbor[] = lineage.map((row) => ({
      neighbor_revision_id:
        row.projection_revision_id === revisionId
          ? row.source_revision_id
          : row.projection_revision_id,
      edge: WorkbenchGraphEdgeSchema.parse({
        edge_id: edgeId({
          from: row.projection_revision_id,
          to: row.source_revision_id,
          relation: "derived_from",
        }),
        from_node_id: row.projection_revision_id,
        to_node_id: row.source_revision_id,
        relation: "derived_from",
        direction: "directed",
        authority_plane: "projection_lineage",
        source_reference_id: row.projection_revision_id,
        description: null,
      }),
    }));
    for (const row of relations) {
      neighbors.push({
        neighbor_revision_id:
          row.source_revision_id === revisionId
            ? row.target_revision_id
            : row.source_revision_id,
        edge: WorkbenchGraphEdgeSchema.parse({
          edge_id: edgeId({
            relation_revision_id: row.relation_revision_id,
            from: row.source_revision_id,
            to: row.target_revision_id,
          }),
          from_node_id: row.source_revision_id,
          to_node_id: row.target_revision_id,
          relation: row.relation_type,
          direction: row.direction,
          authority_plane: "governed_relation",
          source_reference_id: row.relation_revision_id,
          description: row.description,
        }),
      });
    }
    return [...new Map(
      neighbors
        .sort((left, right) => left.edge.edge_id.localeCompare(right.edge.edge_id))
        .map((neighbor) => [neighbor.edge.edge_id, neighbor]),
    ).values()];
  }

  #revisionById(revisionId: string): RevisionRow | undefined {
    return this.#database
      .prepare(`${REVISION_SELECT} WHERE r.revision_id = ?`)
      .get(revisionId) as RevisionRow | undefined;
  }

  #projectionRevision(
    revisionId: string,
    input: ParsedWorkbenchGraphQuery,
  ): ProjectionRow | undefined {
    return this.#database
      .prepare(
        `SELECT p.projection_id, p.projection_revision_id,
                o.current_revision_id, p.projection_type, p.lifecycle,
                p.principal_id, p.scope_kind, p.scope_id, p.sensitivity,
                p.valid_from, p.valid_to, p.payload_json, p.content_json,
                p.content_hash
         FROM projection_revisions AS p
         JOIN projection_objects AS o ON o.projection_id = p.projection_id
         WHERE p.projection_revision_id = ? AND p.principal_id = ?
           AND p.scope_kind = ? AND p.scope_id = ?
           AND p.purged_at IS NULL AND p.valid_from <= ?
           AND (p.valid_to IS NULL OR p.valid_to > ?)
           AND NOT EXISTS (
             SELECT 1 FROM projection_invalidations AS i
             WHERE i.projection_revision_id = p.projection_revision_id
           )`,
      )
      .get(
        revisionId,
        input.principal_id,
        input.request.scope.kind,
        input.request.scope.id,
        input.as_of,
        input.as_of,
      ) as ProjectionRow | undefined;
  }

  #projectionContent(row: ProjectionRow): WorkbenchContent {
    if (row.content_json === null) {
      return { status: "unavailable", reason_code: "PROJECTION_CONTENT_UNAVAILABLE" };
    }
    try {
      const parsed = JSON.parse(row.content_json) as {
        storage?: string;
        text?: string;
        media_type?: string;
      };
      if (
        parsed.storage === "inline" &&
        typeof parsed.text === "string" &&
        parsed.text.length > 0 &&
        typeof parsed.media_type === "string"
      ) {
        return {
          status: "available",
          text: parsed.text,
          media_type: parsed.media_type,
          content_hash: CanonicalHashSchema.parse(row.content_hash),
        };
      }
    } catch {
      // A corrupt projection remains an explicit unavailable node.
    }
    return { status: "unavailable", reason_code: "PROJECTION_CONTENT_INVALID" };
  }

  #projectionLabel(row: ProjectionRow, nodeContent: WorkbenchContent): string {
    if (row.payload_json !== null) {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        for (const field of ["summary", "trigger", "goal", "statement", "key"]) {
          const value = payload[field];
          if (typeof value === "string" && value.trim().length > 0) {
            return value.trim().slice(0, 8_000);
          }
        }
      } catch {
        // The content fallback below preserves the typed unavailable boundary.
      }
    }
    if (nodeContent.status === "available") {
      return nodeContent.text.slice(0, 8_000);
    }
    return `${row.projection_type} projection ${row.projection_id}`;
  }

  #provenance(
    historyRows: RevisionRow[],
    maxNodes: number,
    includeSensitive: boolean,
  ) {
    const nodes: Array<Record<string, unknown>> = [];
    const edges: Array<Record<string, unknown>> = [];
    const nodeIds = new Set<string>();
    let omittedCount = 0;
    const addNode = (node: Record<string, unknown> & { node_id: string }) => {
      if (nodeIds.has(node.node_id)) return true;
      if (nodes.length >= maxNodes) {
        omittedCount += 1;
        return false;
      }
      nodes.push(node);
      nodeIds.add(node.node_id);
      return true;
    };
    for (const row of historyRows) {
      const revisionContent = content(row, includeSensitive);
      addNode({
        kind: "memory_revision",
        node_id: row.revision_id,
        revision_id: row.revision_id,
        status:
          revisionContent.status === "available"
            ? "available"
            : revisionContent.status === "purged"
              ? "purged"
              : "unavailable",
        label: `Revision ${row.revision}`,
        content: revisionContent,
      });
    }
    for (const row of historyRows) {
      if (
        row.supersedes_revision_id !== null &&
        nodeIds.has(row.revision_id) &&
        nodeIds.has(row.supersedes_revision_id)
      ) {
        edges.push({
          edge_id: edgeId({
            from: row.revision_id,
            to: row.supersedes_revision_id,
            relation: "supersedes",
          }),
          from_node_id: row.revision_id,
          to_node_id: row.supersedes_revision_id,
          relation: "supersedes",
        });
      }
      const evidenceRows = this.#database
        .prepare(
          `SELECT e.evidence_id, e.principal_id, e.scope_kind, e.scope_id,
                  e.payload_storage, e.payload_inline, e.media_type,
                  e.content_hash, e.sensitivity, e.purged_at
           FROM memory_revision_evidence AS re
           JOIN evidence_events AS e ON e.evidence_id = re.evidence_id
           WHERE re.revision_id = ?
           ORDER BY e.sequence, e.evidence_id`,
        )
        .all(row.revision_id) as EvidenceRow[];
      for (const evidence of evidenceRows) {
        if (
          evidence.principal_id !== row.principal_id ||
          evidence.scope_kind !== row.scope_kind ||
          evidence.scope_id !== row.scope_id
        ) {
          omittedCount += 1;
          continue;
        }
        const sourceContent = evidenceContent(evidence, includeSensitive);
        const added = addNode({
          kind: "evidence",
          node_id: evidence.evidence_id,
          evidence_id: evidence.evidence_id,
          status:
            sourceContent.status === "available"
              ? "available"
              : sourceContent.status === "purged"
                ? "purged"
                : "unavailable",
          label:
            sourceContent.status === "purged"
              ? "Purged evidence"
              : "Source evidence",
          content: sourceContent,
        });
        if (added && nodeIds.has(row.revision_id)) {
          edges.push({
            edge_id: edgeId({
              from: row.revision_id,
              to: evidence.evidence_id,
              relation: "supported_by",
            }),
            from_node_id: row.revision_id,
            to_node_id: evidence.evidence_id,
            relation: "supported_by",
          });
        }
      }
    }
    return {
      nodes,
      edges,
      truncated: omittedCount > 0,
      omitted_count: omittedCount,
      cycle_detected: hasCycle(edges),
    };
  }
}

function hasCycle(edges: Array<Record<string, unknown>>): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (
      typeof edge.from_node_id !== "string" ||
      typeof edge.to_node_id !== "string"
    ) {
      continue;
    }
    const targets = adjacency.get(edge.from_node_id) ?? [];
    targets.push(edge.to_node_id);
    adjacency.set(edge.from_node_id, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return [...adjacency.keys()].some(visit);
}

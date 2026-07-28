import type Database from "better-sqlite3";

import {
  RelationTraversalInputSchema,
  RelationTraversalResultSchema,
  type RelationTraversalResult,
} from "./protocol.js";

type RelationRow = {
  relation_id: string;
  relation_revision_id: string;
  source_revision_id: string;
  target_revision_id: string;
  relation_type:
    | "supports"
    | "contradicts"
    | "supersedes"
    | "depends_on"
    | "causes"
    | "precedes"
    | "belongs_to_topic"
    | "applies_to_scenario"
    | "references_entity";
  direction: "directed" | "undirected";
};

export class RelationRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  traverse(input: unknown): RelationTraversalResult {
    const query = RelationTraversalInputSchema.parse(input);
    if (query.max_depth === 0) {
      return { hits: [], truncated: false };
    }

    const visitedNodes = new Set<string>(query.start_revision_ids);
    const visitedRelations = new Set<string>();
    let frontier: string[] = [...query.start_revision_ids].sort();
    const hits: Array<{
      depth: number;
      from_revision_id: string;
      to_revision_id: string;
      relation_id: string;
      relation_revision_id: string;
      relation_type: RelationRow["relation_type"];
      direction: "outbound" | "inbound";
    }> = [];
    let truncated = false;

    for (
      let depth = 1;
      depth <= query.max_depth && frontier.length > 0;
      depth += 1
    ) {
      const next = new Set<string>();
      for (const revisionId of frontier) {
        const rows = this.#adjacent(
          revisionId,
          query,
          query.max_fanout + 1,
        );
        if (rows.length > query.max_fanout) {
          truncated = true;
        }
        for (const row of rows.slice(0, query.max_fanout)) {
          if (visitedRelations.has(row.relation_revision_id)) {
            continue;
          }
          visitedRelations.add(row.relation_revision_id);
          const followsStoredDirection =
            row.source_revision_id === revisionId;
          const toRevisionId = followsStoredDirection
            ? row.target_revision_id
            : row.source_revision_id;
          const traversalDirection =
            query.direction === "outbound"
              ? "outbound"
              : query.direction === "inbound"
                ? "inbound"
                : followsStoredDirection
                  ? "outbound"
                  : "inbound";
          hits.push({
            depth,
            from_revision_id: revisionId,
            to_revision_id: toRevisionId,
            relation_id: row.relation_id,
            relation_revision_id: row.relation_revision_id,
            relation_type: row.relation_type,
            direction: traversalDirection,
          });
          if (!visitedNodes.has(toRevisionId)) {
            visitedNodes.add(toRevisionId);
            next.add(toRevisionId);
          }
        }
      }
      frontier = [...next].sort();
    }

    return RelationTraversalResultSchema.parse({
      hits,
      truncated,
    });
  }

  #adjacent(
    revisionId: string,
    query: ReturnType<typeof RelationTraversalInputSchema.parse>,
    limit: number,
  ): RelationRow[] {
    const directionClause =
      query.direction === "outbound"
        ? `(r.source_revision_id = ?
             OR (r.direction = 'undirected' AND r.target_revision_id = ?))`
        : query.direction === "inbound"
          ? `(r.target_revision_id = ?
               OR (r.direction = 'undirected' AND r.source_revision_id = ?))`
          : `(r.source_revision_id = ? OR r.target_revision_id = ?)`;
    const relationTypeClause =
      query.relation_types === undefined
        ? ""
        : `AND r.relation_type IN (${query.relation_types
            .map(() => "?")
            .join(", ")})`;
    return this.#database
      .prepare(
        `SELECT r.relation_id, r.relation_revision_id,
                r.source_revision_id, r.target_revision_id,
                r.relation_type, r.direction
         FROM relation_revisions AS r
         JOIN relation_objects AS o
           ON o.relation_id = r.relation_id
          AND o.current_relation_revision_id = r.relation_revision_id
         JOIN projection_revisions AS p
           ON p.projection_revision_id = r.projection_revision_id
         WHERE r.principal_id = ?
           AND r.scope_kind = ?
           AND r.scope_id = ?
           AND o.lifecycle = 'active'
           AND r.lifecycle = 'active'
           AND p.purged_at IS NULL
           AND r.valid_from <= ?
           AND (r.valid_to IS NULL OR r.valid_to > ?)
           AND NOT EXISTS (
             SELECT 1 FROM projection_invalidations AS i
             WHERE i.projection_revision_id = r.projection_revision_id
           )
           AND ${directionClause}
           ${relationTypeClause}
         ORDER BY r.relation_type, r.relation_id, r.relation_revision_id
         LIMIT ?`,
      )
      .all(
        query.principal_id,
        query.scope.kind,
        query.scope.id,
        query.as_of,
        query.as_of,
        revisionId,
        revisionId,
        ...(query.relation_types ?? []),
        limit,
      ) as RelationRow[];
  }
}

import {
  ProjectionRevisionSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  memoryProposal,
} from "./governance-examples.js";
import { NOW } from "./examples.js";
import { inlineEpisode } from "./storage-examples.js";

type SeededSource = {
  memory_id: string;
  revision_id: string;
  abstraction: "l1_memory";
  principal_id: string;
  scope: { kind: "workspace"; id: string };
  authority: "user_stated";
  sensitivity: "personal";
  validity: {
    valid_from: string;
    valid_to: null;
    recorded_at: string;
  };
  content_hash: string;
  evidence_ids: string[];
};

export async function seedProjectionSources(
  storage: SqliteStorageClient,
): Promise<[SeededSource, SeededSource]> {
  const candidates = [
    memoryCandidate({
      candidateId: "candidate_projection_a",
      logicalKey: "projection.source.a",
      scope: { kind: "workspace", id: "workspace_local" },
      text: "SQLite is the canonical memory authority.",
      evidenceIds: ["evidence_projection_a"],
    }),
    memoryCandidate({
      candidateId: "candidate_projection_b",
      logicalKey: "projection.source.b",
      scope: { kind: "workspace", id: "workspace_local" },
      text: "Derived views must revalidate exact source revisions.",
      evidenceIds: ["evidence_projection_b"],
    }),
  ] as const;

  for (const [index, candidate] of candidates.entries()) {
    const suffix = index === 0 ? "a" : "b";
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: `episode_projection_${suffix}`,
        evidenceId: `evidence_projection_${suffix}`,
        idempotencyKey: `commit:projection:${suffix}:0001`,
        text: candidate.content.storage === "inline"
          ? candidate.content.text
          : `projection source ${suffix}`,
      }),
    );
  }

  const admitted = [];
  for (const [index, candidate] of candidates.entries()) {
    const suffix = index === 0 ? "a" : "b";
    admitted.push(
      await storage.admitMemory({
        request: memoryProposal({
          candidate,
          idempotencyKey: `memory-projection-${suffix}-0001`,
          requestId: `request_projection_${suffix}`,
        }),
        evaluation: {
          decision: "activate",
          reason: "Projection fixtures require live exact-scope sources.",
        },
      }),
    );
  }

  const sources = admitted.map((result, index): SeededSource => {
    const candidate = candidates[index];
    if (candidate === undefined) {
      throw new Error("projection source fixture is incomplete");
    }
    return {
      memory_id: result.memory_id,
      revision_id: result.current_revision_id,
      abstraction: "l1_memory" as const,
      principal_id: "user_local",
      scope: { kind: "workspace" as const, id: "workspace_local" },
      authority: "user_stated",
      sensitivity: "personal",
      validity: {
        valid_from: NOW,
        valid_to: null,
        recorded_at: NOW,
      },
      content_hash: candidate.content_hash,
      evidence_ids: [...candidate.evidence_ids],
    };
  });
  const sourceA = sources[0];
  const sourceB = sources[1];
  if (sourceA === undefined || sourceB === undefined) {
    throw new Error("projection source fixture is incomplete");
  }
  return [sourceA, sourceB];
}

export async function seedLayeredProjectionSources(
  storage: SqliteStorageClient,
  options: {
    prefix?: string;
    scopeId?: string;
  } = {},
) {
  const prefix = options.prefix ?? "layered";
  const scopeId = options.scopeId ?? "workspace_local";
  const definitions = [
    {
      suffix: "semantic_a",
      kind: "semantic" as const,
      text: "Agent memory must remain governed.",
      validFrom: "2026-07-28T11:00:00.000Z",
    },
    {
      suffix: "semantic_b",
      kind: "semantic" as const,
      text: "  agent   memory must remain governed.  ",
      validFrom: "2026-07-28T11:10:00.000Z",
    },
    {
      suffix: "episode",
      kind: "episodic" as const,
      text: "Agent memory projection became stale.",
      validFrom: "2026-07-28T11:20:00.000Z",
    },
    {
      suffix: "procedure",
      kind: "procedural" as const,
      text: "Agent memory requires exact revalidation.",
      validFrom: "2026-07-28T11:30:00.000Z",
    },
  ] as const;
  const admitted = [];
  for (const definition of definitions) {
    const identity = `${prefix}_${definition.suffix}`;
    const evidenceId = `evidence_${identity}`;
    const candidate = memoryCandidate({
      candidateId: `candidate_${identity}`,
      logicalKey: `projection.${identity}`,
      kind: definition.kind,
      scope: { kind: "workspace", id: scopeId },
      text: definition.text,
      evidenceIds: [evidenceId],
      validFrom: definition.validFrom,
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: `episode_${identity}`,
        evidenceId,
        idempotencyKey: `commit:${identity}:0001`,
        scopeId,
        text: definition.text.trim(),
      }),
    );
    admitted.push(
      await storage.admitMemory({
        request: memoryProposal({
          candidate,
          idempotencyKey: `memory-${identity}-0001`,
          requestId: `request_${identity}`,
        }),
        evaluation: {
          decision: "activate",
          reason: "Layered recall fixtures require governed sources.",
        },
      }),
    );
  }
  return admitted;
}

export function projectionFrontier(options: {
  ledgerEpoch: number;
  tombstoneEpoch: number;
  projectionEpoch: number;
}) {
  const transform = {
    name: "deterministic-g3-projection",
    version: "1.0.0",
  } as const;
  return {
    schema_version: "1.0.0",
    ledger_epoch: options.ledgerEpoch,
    tombstone_epoch: options.tombstoneEpoch,
    projection_epoch: options.projectionEpoch,
    transform,
    source_frontier_hash: canonicalSha256({
      ledger_epoch: options.ledgerEpoch,
      tombstone_epoch: options.tombstoneEpoch,
    }),
    projection_frontier_hash: canonicalSha256({
      projection_epoch: options.projectionEpoch,
      transform,
    }),
  } as const;
}

export function topicProjection(
  sources: [SeededSource, SeededSource],
  frontier: ReturnType<typeof projectionFrontier>,
) {
  const payload = {
    kind: "topic",
    key: "agent_memory_runtime",
    summary: "SQLite is authoritative; projections remain disposable.",
    open_items: ["Measure G3 task utility and context pollution."],
  } as const;
  const content = {
    storage: "inline",
    text: payload.summary,
    media_type: "text/plain",
  } as const;
  return ProjectionRevisionSchema.parse({
    schema_version: "1.0.0",
    projection_id: "projection_topic_runtime",
    projection_revision_id: "projection_revision_topic_runtime_1",
    revision: 1,
    projection_type: "topic",
    abstraction: "l2_topic",
    principal_id: "user_local",
    scope: { kind: "workspace", id: "workspace_local" },
    lifecycle: "active",
    authority: "derived",
    sensitivity: "personal",
    validity: {
      valid_from: NOW,
      valid_to: null,
      recorded_at: NOW,
    },
    payload,
    content,
    content_hash: canonicalSha256(content),
    source_revisions: sources,
    evidence_ids: sources.flatMap((source) => source.evidence_ids),
    supersedes_projection_revision_id: null,
    transform: frontier.transform,
    frontier,
    created_at: NOW,
    invalidated_at: null,
    invalidation_reason: null,
  });
}

export function relationProjection(
  sources: [SeededSource, SeededSource],
  frontier: ReturnType<typeof projectionFrontier>,
) {
  const payload = {
    kind: "relation",
    source_revision_id: sources[0].revision_id,
    target_revision_id: sources[1].revision_id,
    relation_type: "supports",
    direction: "directed",
    description: "The authority rule supports exact lineage revalidation.",
  } as const;
  const content = {
    storage: "inline",
    text: payload.description,
    media_type: "text/plain",
  } as const;
  return ProjectionRevisionSchema.parse({
    schema_version: "1.0.0",
    projection_id: "projection_relation_runtime",
    projection_revision_id: "projection_revision_relation_runtime_1",
    revision: 1,
    projection_type: "relation",
    abstraction: "l2_relation",
    principal_id: "user_local",
    scope: { kind: "workspace", id: "workspace_local" },
    lifecycle: "active",
    authority: "derived",
    sensitivity: "personal",
    validity: {
      valid_from: NOW,
      valid_to: null,
      recorded_at: NOW,
    },
    payload,
    content,
    content_hash: canonicalSha256(content),
    source_revisions: sources,
    evidence_ids: sources.flatMap((source) => source.evidence_ids),
    supersedes_projection_revision_id: null,
    transform: frontier.transform,
    frontier,
    created_at: NOW,
    invalidated_at: null,
    invalidation_reason: null,
  });
}

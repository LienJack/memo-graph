import {
  EvidenceAdaptationSchema,
  EvidenceAdapterRequestSchema,
  EvidenceRecordSchema,
  EpisodeSchema,
  canonicalSha256,
  type Authority,
  type EvidenceAdaptation,
  type EvidenceAdapterRequest,
  type EvidenceIngestItem,
} from "@memo-graph/contracts";
import type { z } from "zod";

function authorityFor(item: EvidenceIngestItem): Authority {
  if (item.kind === "conversation_turn") {
    return item.speaker === "user" ? "user_stated" : "observed";
  }
  return item.kind === "tool_result" ? "tool_result" : "imported";
}

function sourceFor(
  item: EvidenceIngestItem,
): "conversation_turn" | "tool_result" | "import" {
  if (item.kind === "conversation_turn") {
    return "conversation_turn";
  }
  return item.kind === "tool_result" ? "tool_result" : "import";
}

function mediaTypeFor(item: EvidenceIngestItem): string {
  return item.kind === "text_file" ? item.media_type : "text/plain";
}

export function adaptEvidenceFastL0(
  input: z.input<typeof EvidenceAdapterRequestSchema>,
): EvidenceAdaptation {
  const request = EvidenceAdapterRequestSchema.parse(input);
  const episodeId = `episode:${canonicalSha256({
    domain: "memo-graph/evidence-adapter/episode/v1",
    idempotency_key: request.idempotency_key,
    principal_id: request.principal_id,
    batch: request.batch,
  }).slice("sha256:".length)}`;

  const evidence = request.batch.items.map((item, sequence) => {
    const authority = authorityFor(item);
    const payload = {
      storage: "inline" as const,
      text: item.text,
      media_type: mediaTypeFor(item),
    };
    return EvidenceRecordSchema.parse({
      schema_version: "1.0.0",
      evidence_id: `evidence:${canonicalSha256({
        domain: "memo-graph/evidence-adapter/evidence/v1",
        episode_id: episodeId,
        sequence,
        kind: item.kind,
        occurred_at: item.occurred_at,
        payload_hash: canonicalSha256(payload),
      }).slice("sha256:".length)}`,
      sequence,
      occurred_at: item.occurred_at,
      recorded_at: request.recorded_at,
      scope: request.batch.scope,
      actor: {
        principal_id: request.principal_id,
        authority,
      },
      source: sourceFor(item),
      authority,
      sensitivity: item.sensitivity,
      payload,
      content_hash: canonicalSha256(payload),
    });
  });

  const timestamps = evidence.map((record) => Date.parse(record.occurred_at));
  const unsealedEpisode = {
    schema_version: "1.0.0" as const,
    episode_id: episodeId,
    scope: request.batch.scope,
    started_at: new Date(Math.min(...timestamps)).toISOString(),
    ended_at: new Date(Math.max(...timestamps)).toISOString(),
    event_ids: evidence.map((record) => record.evidence_id),
    artifact_hashes: [],
    outcome: request.batch.outcome,
  };
  const episode = EpisodeSchema.parse({
    ...unsealedEpisode,
    sealed_hash: canonicalSha256(unsealedEpisode),
  });

  return EvidenceAdaptationSchema.parse({
    schema_version: "1.0.0",
    mode: "fast_l0",
    episode,
    evidence,
    blobs: [],
    candidate_count: 0,
  });
}

export type { EvidenceAdaptation, EvidenceAdapterRequest };

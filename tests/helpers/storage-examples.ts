import { createHash } from "node:crypto";

import {
  EpisodeSchema,
  EvidenceRecordSchema,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";

export function inlineEpisode(options: {
  episodeId?: string;
  evidenceId?: string;
  idempotencyKey?: string;
  principalId?: string;
  scopeId?: string;
  text?: string;
}) {
  const episodeId = options.episodeId ?? "episode_storage_1";
  const evidenceId = options.evidenceId ?? "evidence_storage_1";
  const principalId = options.principalId ?? "user_local";
  const scopeId = options.scopeId ?? "workspace_local";
  const text = options.text ?? "Governed context survives a later session.";
  const occurredAt = "2026-07-28T12:00:00.000Z";
  const payload = {
    storage: "inline",
    text,
    media_type: "text/plain",
  } as const;

  const evidence = EvidenceRecordSchema.parse({
    schema_version: "1.0.0",
    evidence_id: evidenceId,
    sequence: 0,
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    scope: {
      kind: "workspace",
      id: scopeId,
    },
    actor: {
      principal_id: principalId,
      authority: "user_stated",
    },
    source: "conversation_turn",
    authority: "user_stated",
    sensitivity: "internal",
    payload,
    content_hash: canonicalSha256(payload),
  });

  const unsealedEpisode = {
    schema_version: "1.0.0",
    episode_id: episodeId,
    scope: {
      kind: "workspace",
      id: scopeId,
    },
    started_at: occurredAt,
    ended_at: "2026-07-28T12:01:00.000Z",
    event_ids: [evidenceId],
    artifact_hashes: [],
    outcome: "succeeded",
  } as const;

  const episode = EpisodeSchema.parse({
    ...unsealedEpisode,
    sealed_hash: canonicalSha256(unsealedEpisode),
  });

  return {
    idempotencyKey: options.idempotencyKey ?? `commit:${episodeId}:0001`,
    episode,
    evidence: [evidence],
    blobs: [],
  };
}

export function blobEpisode(options: {
  bytes: Uint8Array;
  episodeId?: string;
  evidenceId?: string;
  idempotencyKey?: string;
}) {
  const episodeId = options.episodeId ?? "episode_blob_1";
  const evidenceId = options.evidenceId ?? "evidence_blob_1";
  const occurredAt = "2026-07-28T12:00:00.000Z";
  const contentHash =
    `sha256:${createHash("sha256").update(options.bytes).digest("hex")}` as const;

  const payload = {
    storage: "blob",
    content_hash: contentHash,
    size_bytes: options.bytes.byteLength,
    media_type: "application/octet-stream",
  } as const;

  const evidence = EvidenceRecordSchema.parse({
    schema_version: "1.0.0",
    evidence_id: evidenceId,
    sequence: 0,
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    scope: {
      kind: "workspace",
      id: "workspace_local",
    },
    actor: {
      principal_id: "user_local",
      authority: "tool_result",
    },
    source: "artifact",
    authority: "tool_result",
    sensitivity: "internal",
    payload,
    content_hash: contentHash,
  });

  const unsealedEpisode = {
    schema_version: "1.0.0",
    episode_id: episodeId,
    scope: evidence.scope,
    started_at: occurredAt,
    ended_at: "2026-07-28T12:01:00.000Z",
    event_ids: [evidenceId],
    artifact_hashes: [contentHash],
    outcome: "succeeded",
  } as const;

  const episode = EpisodeSchema.parse({
    ...unsealedEpisode,
    sealed_hash: canonicalSha256(unsealedEpisode),
  });

  return {
    idempotencyKey: options.idempotencyKey ?? `commit:${episodeId}:0001`,
    episode,
    evidence: [evidence],
    blobs: [
      {
        content_hash: contentHash,
        media_type: "application/octet-stream",
        bytes: options.bytes,
      },
    ],
  };
}

export function resealEpisode<T extends { sealed_hash: string }>(
  episode: T,
): T {
  return {
    ...episode,
    sealed_hash: canonicalSha256Omitting(episode, ["sealed_hash"]),
  };
}

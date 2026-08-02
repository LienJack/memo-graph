import { describe, expect, it } from "vitest";

import {
  EvidenceAdapterRequestSchema,
  EvidenceAdaptationSchema,
  EvidenceIngestBatchSchema,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import { adaptEvidenceFastL0 } from "../../packages/evidence-adapter/src/index.js";

const NOW = "2026-08-02T08:00:00.000Z";

function request() {
  return EvidenceAdapterRequestSchema.parse({
    idempotency_key: "evidence-ingest-contract-001",
    principal_id: "user_local",
    recorded_at: NOW,
    batch: {
      scope: { kind: "workspace", id: "workspace_local" },
      outcome: "succeeded",
      items: [
        {
          kind: "conversation_turn",
          speaker: "user",
          occurred_at: "2026-08-02T07:58:00.000Z",
          sensitivity: "personal",
          text: "Please keep the evidence boundary explicit.",
        },
        {
          kind: "conversation_turn",
          speaker: "assistant",
          occurred_at: "2026-08-02T07:59:00.000Z",
          sensitivity: "internal",
          text: "I will preserve source lineage.",
        },
        {
          kind: "tool_result",
          tool_name: "workspace_read",
          occurred_at: NOW,
          sensitivity: "internal",
          text: "read completed",
        },
        {
          kind: "text_file",
          source_name: "architecture.md",
          media_type: "text/markdown",
          occurred_at: NOW,
          sensitivity: "internal",
          text: "# Architecture\n\nEvidence remains L0.",
        },
      ],
    },
  });
}

describe("deterministic fast L0 evidence adapter", () => {
  it("maps common sources into one sealed episode without memory candidates", () => {
    const first = adaptEvidenceFastL0(request());
    const replay = adaptEvidenceFastL0(request());
    const changed = adaptEvidenceFastL0({
      ...request(),
      batch: {
        ...request().batch,
        items: request().batch.items.map((item, index) =>
          index === 0 ? { ...item, text: `${item.text} changed` } : item,
        ),
      },
    });

    expect(replay).toEqual(first);
    expect(changed.episode.episode_id).not.toBe(first.episode.episode_id);
    expect(changed.evidence[0]?.evidence_id).not.toBe(
      first.evidence[0]?.evidence_id,
    );
    expect(
      adaptEvidenceFastL0(
        EvidenceAdapterRequestSchema.parse({
          ...request(),
          principal_id: "another_user",
        }),
      ).episode.episode_id,
    ).not.toBe(first.episode.episode_id);
    expect(first.mode).toBe("fast_l0");
    expect(first.candidate_count).toBe(0);
    expect(first.blobs).toEqual([]);
    expect(first.evidence.map((record) => record.authority)).toEqual([
      "user_stated",
      "observed",
      "tool_result",
      "imported",
    ]);
    expect(first.evidence.map((record) => record.source)).toEqual([
      "conversation_turn",
      "conversation_turn",
      "tool_result",
      "import",
    ]);
    expect(new Set(first.episode.event_ids).size).toBe(4);
    expect(first.episode.sealed_hash).toBe(
      canonicalSha256Omitting(first.episode, ["sealed_hash"]),
    );
    expect(
      EvidenceAdaptationSchema.safeParse({
        ...first,
        evidence: first.evidence.map((record, index) =>
          index === 0
            ? { ...record, authority: "inferred" }
            : record,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects secret plaintext and oversized UTF-8 batches", () => {
    const base = request().batch;
    expect(
      EvidenceIngestBatchSchema.safeParse({
        ...base,
        items: [
          {
            ...base.items[0],
            sensitivity: "secret",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      EvidenceIngestBatchSchema.safeParse({
        ...base,
        items: [{ ...base.items[0], text: "界".repeat(22_000) }],
      }).success,
    ).toBe(false);
    expect(
      EvidenceIngestBatchSchema.safeParse({
        ...base,
        items: [
          { ...base.items[0], text: "界".repeat(64_000) },
          { ...base.items[0], text: "界".repeat(64_000) },
        ],
      }).success,
    ).toBe(false);
    expect(
      EvidenceIngestBatchSchema.safeParse({
        ...base,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

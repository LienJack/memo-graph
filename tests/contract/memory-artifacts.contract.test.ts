import { describe, expect, it } from "vitest";

import {
  EpisodeSchema,
  MemoryObjectSchema,
  MemoryRevisionSchema,
} from "../../packages/contracts/src/index.js";
import {
  HASH_A,
  HASH_B,
  LATER,
  NOW,
  USER_SCOPE,
  validMemoryRevision,
} from "../helpers/examples.js";

describe("memory artifact contracts", () => {
  it("accepts a governed L1 revision", () => {
    expect(MemoryRevisionSchema.parse(validMemoryRevision())).toMatchObject({
      revision_id: "revision_pref_1",
      lifecycle: "active",
    });
  });

  it("requires later revisions to identify their predecessor", () => {
    expect(
      MemoryRevisionSchema.safeParse({
        ...validMemoryRevision(),
        revision_id: "revision_pref_2",
        revision: 2,
        content_hash: HASH_B,
      }).success,
    ).toBe(false);
  });

  it("requires L2/L3 projections to carry lower-level lineage", () => {
    expect(
      MemoryRevisionSchema.safeParse({
        ...validMemoryRevision(),
        abstraction: "l3_core",
        authority: "derived",
        derived_from_revision_ids: [],
      }).success,
    ).toBe(false);
  });

  it("prevents purged revisions from retaining content", () => {
    expect(
      MemoryRevisionSchema.safeParse({
        ...validMemoryRevision(),
        lifecycle: "purged",
      }).success,
    ).toBe(false);
  });

  it("prevents revoked memory from entering context", () => {
    expect(
      MemoryObjectSchema.safeParse({
        schema_version: "1.0.0",
        memory_id: "memory_pref",
        kind: "semantic",
        scope: USER_SCOPE,
        lifecycle: "revoked",
        current_revision_id: "revision_pref_1",
        pinned: false,
        context_eligible: true,
        created_at: NOW,
        updated_at: LATER,
      }).success,
    ).toBe(false);
  });

  it("rejects episodes whose end precedes their start", () => {
    expect(
      EpisodeSchema.safeParse({
        schema_version: "1.0.0",
        episode_id: "episode_1",
        scope: USER_SCOPE,
        started_at: LATER,
        ended_at: NOW,
        event_ids: ["event_1"],
        artifact_hashes: [HASH_A],
        outcome: "succeeded",
        sealed_hash: HASH_B,
      }).success,
    ).toBe(false);
  });
});

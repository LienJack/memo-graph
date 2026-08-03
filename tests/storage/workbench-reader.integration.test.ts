import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EpisodeSchema,
  EvidenceRecordSchema,
  MemoryCandidateSchema,
  MemoryProposeInputSchema,
  ScopeSchema,
  canonicalSha256,
  type Scope,
} from "../../packages/contracts/src/index.js";
import {
  SqliteStorageClient,
  type WorkbenchMemoryListQuery,
} from "@memo-graph/storage-sqlite";

const NOW = "2026-08-02T06:00:00.000Z";
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function memoryArtifacts(options: {
  suffix: string;
  scope: Scope;
  text: string;
  sensitivity?: "personal" | "sensitive";
}) {
  const evidenceId = `evidence_workbench_${options.suffix}`;
  const episodeId = `episode_workbench_${options.suffix}`;
  const payload = {
    storage: "inline",
    text: `Source: ${options.text}`,
    media_type: "text/plain",
  } as const;
  const evidence = EvidenceRecordSchema.parse({
    schema_version: "1.0.0",
    evidence_id: evidenceId,
    sequence: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    scope: options.scope,
    actor: {
      principal_id: "user_local",
      authority: "user_stated",
    },
    source: "conversation_turn",
    authority: "user_stated",
    sensitivity: options.sensitivity ?? "personal",
    payload,
    content_hash: canonicalSha256(payload),
  });
  const episodeDraft = {
    schema_version: "1.0.0",
    episode_id: episodeId,
    scope: options.scope,
    started_at: NOW,
    ended_at: "2026-08-02T06:01:00.000Z",
    event_ids: [evidenceId],
    artifact_hashes: [],
    outcome: "succeeded",
  } as const;
  const episode = EpisodeSchema.parse({
    ...episodeDraft,
    sealed_hash: canonicalSha256(episodeDraft),
  });
  const content = {
    storage: "inline",
    text: options.text,
    media_type: "text/plain",
  } as const;
  const candidate = MemoryCandidateSchema.parse({
    schema_version: "1.0.0",
    candidate_id: `candidate_workbench_${options.suffix}`,
    logical_key: `workbench.${options.suffix}`,
    kind: "semantic",
    scope: options.scope,
    sensitivity: options.sensitivity ?? "personal",
    inferred: false,
    content,
    content_hash: canonicalSha256(content),
    evidence_ids: [evidenceId],
    validity: {
      valid_from: NOW,
      valid_to: null,
      recorded_at: NOW,
    },
    injection_risk: "none",
    requires_user_confirmation: false,
    transform: { name: "workbench-test", version: "1.0.0" },
  });
  const request = MemoryProposeInputSchema.parse({
    envelope: {
      schema_version: "1.0.0",
      request_id: `request_workbench_${options.suffix}`,
      tool: "memory_propose",
      safety_class: "proposal",
      actor_claim: {
        principal_id: "user_local",
        authority: "user_stated",
      },
      scopes: [options.scope],
      purpose: "Seed governed workbench memory",
      reason: "Verify governed browser reads",
      requested_at: NOW,
      idempotency_key: `workbench-propose-${options.suffix}-0001`,
    },
    candidate,
  });
  return { candidate, episode, evidence, request };
}

async function seedMemory(
  storage: SqliteStorageClient,
  options: Parameters<typeof memoryArtifacts>[0],
) {
  const artifacts = memoryArtifacts(options);
  await storage.commitEpisode({
    idempotencyKey: `workbench-episode-${options.suffix}-0001`,
    episode: artifacts.episode,
    evidence: [artifacts.evidence],
    blobs: [],
  });
  const result = await storage.admitMemory({
    request: artifacts.request,
    evaluation: {
      decision:
        options.sensitivity === "sensitive" ? "quarantine" : "activate",
      reason:
        options.sensitivity === "sensitive"
          ? "sensitive evidence requires explicit review"
          : "exact-scope user evidence is eligible",
    },
  });
  return { ...artifacts, result };
}

const workspaceScope = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_local",
});
const topicScope = ScopeSchema.parse({ kind: "topic", id: "topic_alpha" });
const userScope = ScopeSchema.parse({ kind: "user", id: "user_local" });

function listInput(): WorkbenchMemoryListQuery {
  return {
    principal_id: "user_local",
    allowed_scopes: [workspaceScope, topicScope, userScope],
    as_of: NOW,
    include_sensitive: false,
    context_scope: null,
    max_snapshot_members: 100,
    request: {
      query: null,
      scope: null,
      kinds: [],
      lifecycles: [],
      authorities: [],
      sources: [],
      recorded_after: null,
      recorded_before: null,
      include_non_current: false,
      limit: 40,
      cursor: null,
    },
  };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("workbench governed reader", () => {
  it("lists current eligible memory across exact peer scope axes", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("workbench-list"),
    });
    await seedMemory(storage, {
      suffix: "workspace",
      scope: workspaceScope,
      text: "Workspace memory",
    });
    await seedMemory(storage, {
      suffix: "topic",
      scope: topicScope,
      text: "Topic memory",
    });
    await seedMemory(storage, {
      suffix: "other",
      scope: userScope,
      text: "Other exact-scope memory",
    });

    const result = await storage.listWorkbenchMemories(listInput());
    const bounded = await storage.listWorkbenchMemories({
      ...listInput(),
      max_snapshot_members: 1,
    });
    await storage.close();

    expect(result.candidate_space_truncated).toBe(false);
    expect(result.omitted_count).toBe(0);
    expect(result.items).toHaveLength(3);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: workspaceScope,
          group: { kind: "workspace_project", scope: workspaceScope },
          is_current: true,
          writable: true,
        }),
        expect.objectContaining({
          scope: topicScope,
          group: { kind: "topic", scope: topicScope },
          is_current: true,
          writable: true,
        }),
        expect.objectContaining({
          scope: userScope,
          group: { kind: "other", scope: userScope },
          is_current: true,
          writable: true,
        }),
      ]),
    );
    expect(bounded).toMatchObject({
      candidate_space_truncated: true,
      omitted_count: 2,
    });
  });

  it("reloads immutable snapshot members as historical after correction", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("workbench-members"),
    });
    const seeded = await seedMemory(storage, {
      suffix: "stable",
      scope: workspaceScope,
      text: "Original stable member",
    });
    const snapshot = await storage.listWorkbenchMemories({
      ...listInput(),
      allowed_scopes: [workspaceScope],
    });
    const original = snapshot.items[0];
    if (original === undefined) {
      throw new Error("expected one snapshot member");
    }
    const replacementContent = {
      storage: "inline",
      text: "Corrected current member",
      media_type: "text/plain",
    } as const;
    const replacement = MemoryCandidateSchema.parse({
      ...seeded.candidate,
      candidate_id: "candidate_workbench_stable_corrected",
      content: replacementContent,
      content_hash: canonicalSha256(replacementContent),
      transform: { name: "memory-correction", version: "1.0.0" },
    });
    const corrected = await storage.applyMemoryRevision({
      idempotency_key: "workbench-correction-stable-0001",
      principal_id: "user_local",
      actor_authority: "user_stated",
      scope: workspaceScope,
      requested_at: NOW,
      memory_id: seeded.result.memory_id,
      expected_revision_id: original.revision_id,
      candidate: replacement,
      evaluation: {
        decision: "activate",
        reason: "exact-scope user evidence is eligible",
      },
    });

    const historical = await storage.getWorkbenchMemorySummaries({
      principal_id: "user_local",
      allowed_scopes: [workspaceScope],
      as_of: NOW,
      include_sensitive: false,
      context_scope: null,
      members: [
        {
          memory_id: original.memory_id,
          revision_id: original.revision_id,
        },
      ],
    });
    const current = await storage.listWorkbenchMemories({
      ...listInput(),
      allowed_scopes: [workspaceScope],
    });
    await storage.close();

    expect(historical).toMatchObject({
      missing_count: 0,
      items: [
        {
          memory_id: original.memory_id,
          revision_id: original.revision_id,
          is_current: false,
          writable: false,
          non_current_reason: "SUPERSEDED",
        },
      ],
    });
    expect(current.items).toHaveLength(1);
    expect(current.items[0]?.revision_id).toBe(
      corrected.current_revision_id,
    );
  });

  it("returns bounded history and read-only evidence provenance", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("workbench-detail"),
    });
    const seeded = await seedMemory(storage, {
      suffix: "detail",
      scope: workspaceScope,
      text: "Detail and provenance",
    });

    const detail = await storage.getWorkbenchMemoryDetail({
      principal_id: "user_local",
      allowed_scopes: [workspaceScope],
      as_of: NOW,
      include_sensitive: false,
      context_scope: null,
      max_history: 100,
      max_provenance_nodes: 200,
      request: {
        memory_id: seeded.result.memory_id,
        revision_id: null,
      },
    });
    const foreign = await storage.getWorkbenchMemoryDetail({
      principal_id: "user_local",
      allowed_scopes: [topicScope],
      as_of: NOW,
      include_sensitive: false,
      context_scope: null,
      max_history: 100,
      max_provenance_nodes: 200,
      request: {
        memory_id: seeded.result.memory_id,
        revision_id: null,
      },
    });
    await storage.close();

    expect(detail.status).toBe("ready");
    if (detail.status !== "ready") {
      throw new Error("expected ready workbench detail");
    }
    expect(detail.history).toHaveLength(1);
    expect(detail.provenance.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memory_revision",
          revision_id: seeded.result.current_revision_id,
        }),
        expect.objectContaining({
          kind: "evidence",
          evidence_id: seeded.evidence.evidence_id,
          status: "available",
        }),
      ]),
    );
    expect(detail.provenance.edges).toContainEqual(
      expect.objectContaining({ relation: "supported_by" }),
    );
    expect(detail.provenance.nodes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ editable: true })]),
    );
    expect(foreign.status).toBe("not_found");
  });

  it("reports policy exclusions without leaking sensitive content", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("workbench-sensitive"),
    });
    const seeded = await seedMemory(storage, {
      suffix: "sensitive",
      scope: workspaceScope,
      text: "sensitive-body-must-not-leak",
      sensitivity: "sensitive",
    });

    const listed = await storage.listWorkbenchMemories({
      ...listInput(),
      allowed_scopes: [workspaceScope],
      request: {
        ...listInput().request,
        include_non_current: true,
      },
    });
    const detail = await storage.getWorkbenchMemoryDetail({
      principal_id: "user_local",
      allowed_scopes: [workspaceScope],
      as_of: NOW,
      include_sensitive: false,
      context_scope: null,
      max_history: 100,
      max_provenance_nodes: 200,
      request: {
        memory_id: seeded.result.memory_id,
        revision_id: null,
      },
    });
    await storage.close();

    expect(listed).toMatchObject({
      items: [],
      excluded_count: 1,
      exclusion_reason_codes: ["SENSITIVE_EXCLUDED"],
    });
    expect(detail).toMatchObject({
      status: "governance_excluded",
      reason_code: "SENSITIVE_EXCLUDED",
    });
    expect(JSON.stringify({ listed, detail })).not.toContain(
      "sensitive-body-must-not-leak",
    );
  });
});

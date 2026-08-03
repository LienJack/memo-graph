import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const NOW = "2026-07-28T12:00:00.000Z";
const scope = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-workbench-correct-")),
  );
  cleanupPaths.push(root);
  return root;
}

function ids() {
  let sequence = 0;
  return (prefix: string) => `${prefix}_${++sequence}`;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("Memory Workbench correction service", () => {
  it("keeps preview read-only and commits feedback, successor, and approval once", async () => {
    const dataRoot = temporaryRoot();
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_workbench_correction_source",
          logicalKey: "workbench.correction.source",
          scope,
          text: "Original workbench memory",
        }),
        idempotencyKey: "workbench-correction-source-0001",
        requestId: "request_workbench_correction_source",
      }),
      evaluation: {
        decision: "activate",
        reason: "exact-scope user evidence is eligible",
      },
    });
    const before = await storage.health();
    const runtime = new MemoryRuntime({
      storage,
      clock: () => NOW,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: [scope],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: true,
        },
      },
    });
    const workbench = runtime.createWorkbenchService(
      {
        create: () => {
          throw new Error("snapshot registry is not used by correction");
        },
        read: () => ({ status: "stale", reason_code: "CURSOR_INVALID" }),
      },
      {
        sessionId: "session_workbench_correction",
        idFactory: ids(),
      },
    );

    const preview = await workbench.previewCorrection({
      memory_id: admitted.memory_id,
      expected_revision_id: admitted.current_revision_id,
      replacement: {
        text: "Corrected workbench memory",
        media_type: "text/plain",
      },
      reason: "The user explicitly corrected the stored memory",
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") {
      throw new Error("expected correction preview");
    }
    expect(await storage.health()).toMatchObject({
      ledger_epoch: before.ledger_epoch,
      counts: {
        evidence_events: before.counts.evidence_events,
        memory_revisions: before.counts.memory_revisions,
        approval_consumptions: before.counts.approval_consumptions,
      },
    });

    const confirmed = await workbench.confirmCorrection({
      preview_id: preview.preview_id,
      confirmed: true,
    });
    expect(confirmed).toMatchObject({
      status: "ready",
      replayed: false,
      previous_revision_id: admitted.current_revision_id,
    });
    if (confirmed.status !== "ready") {
      throw new Error("expected confirmed correction");
    }
    expect(confirmed.current_revision_id).not.toBe(admitted.current_revision_id);

    const replayed = await workbench.confirmCorrection({
      preview_id: preview.preview_id,
      confirmed: true,
    });
    expect(replayed).toMatchObject({
      status: "ready",
      replayed: true,
      receipt: confirmed.receipt,
    });
    await storage.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    expect(
      (
        database
          .prepare(
            "SELECT count(*) AS count FROM evidence_events WHERE source = 'user_feedback'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        database
          .prepare("SELECT count(*) AS count FROM approval_consumptions")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    database.close();
  });

  it("allows only one CAS winner across two sealed previews", async () => {
    const storage = await SqliteStorageClient.open({ dataRoot: temporaryRoot() });
    await storage.commitEpisode(inlineEpisode({}));
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_workbench_race_source",
          logicalKey: "workbench.correction.race",
          scope,
          text: "Original race memory",
        }),
        idempotencyKey: "workbench-correction-race-source-0001",
        requestId: "request_workbench_correction_race_source",
      }),
      evaluation: {
        decision: "activate",
        reason: "exact-scope user evidence is eligible",
      },
    });
    const runtime = new MemoryRuntime({
      storage,
      clock: () => NOW,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: [scope],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: true,
        },
      },
    });
    const workbench = runtime.createWorkbenchService(
      {
        create: () => {
          throw new Error("not used");
        },
        read: () => ({ status: "stale", reason_code: "CURSOR_INVALID" }),
      },
      { sessionId: "session_workbench_race", idFactory: ids() },
    );
    const draft = {
      memory_id: admitted.memory_id,
      expected_revision_id: admitted.current_revision_id,
      replacement: { text: "First race correction" },
      reason: "First sealed correction",
    };
    const first = await workbench.previewCorrection(draft);
    const second = await workbench.previewCorrection({
      ...draft,
      replacement: { text: "Second race correction" },
      reason: "Second sealed correction",
    });
    if (first.status !== "ready" || second.status !== "ready") {
      throw new Error("both previews must seal before either commit");
    }

    expect(
      await workbench.confirmCorrection({
        preview_id: first.preview_id,
        confirmed: true,
      }),
    ).toMatchObject({ status: "ready", replayed: false });
    expect(
      await workbench.confirmCorrection({
        preview_id: second.preview_id,
        confirmed: true,
      }),
    ).toMatchObject({
      status: "stale_preview",
      reason_code: "STALE_REVISION",
    });
    await storage.close();
  });
});

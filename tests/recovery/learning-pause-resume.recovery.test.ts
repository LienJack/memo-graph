import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import { NOW } from "../helpers/examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const WORKSPACE_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function runtime(
  storage: SqliteStorageClient,
  approvals: TestApprovalRegistry,
) {
  return new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    clock: () => NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [WORKSPACE_SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: false,
      },
    },
  });
}

function envelope(
  tool: "learning_pause" | "learning_resume",
  suffix: string,
) {
  return {
    schema_version: "1.0.0",
    request_id: `request_${suffix}`,
    tool,
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated",
    },
    scopes: [WORKSPACE_SCOPE],
    purpose: "recover the governed learning control state",
    reason: "verify exact restart and drift semantics",
    requested_at: NOW,
    safety_class: "important_mutation",
    idempotency_key: `learning-recovery-${suffix}-001`,
    expected_revision_id: null,
    approval_id: `approval_${suffix}`,
    dry_run: false,
  } as const;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("learning pause and resume recovery", () => {
  it("survives restart and requires exact identity unless abandonment is explicit", async () => {
    const dataRoot = temporaryRoot("learning-pause-restart");
    const approvals = new TestApprovalRegistry();
    let storage = await SqliteStorageClient.open({ dataRoot });
    const initialRuntime = runtime(storage, approvals);
    const initialFrontier =
      (await initialRuntime.learningInspection()).action_frontier;
    const pauseRequest = {
      envelope: envelope("learning_pause", "restart_pause"),
      expected_control_epoch: initialFrontier.expected_control_epoch,
      expected_frontier_hash: initialFrontier.expected_frontier_hash,
      runtime_identity_hash: initialFrontier.runtime_identity_hash,
      configuration_hash: initialFrontier.configuration_hash,
      corpus_hash: initialFrontier.corpus_hash,
    } as const;
    approvals.approve(pauseRequest);
    expect(await initialRuntime.learningPause(pauseRequest))
      .toMatchObject({ status: "OK" });
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    try {
      const recovered = runtime(storage, approvals);
      expect((await recovered.learningInspection()).control).toMatchObject({
        status: "paused",
        control_epoch: 1,
      });
      const changedCorpus = inlineEpisode({
        episodeId: "episode_pause_corpus_drift",
        evidenceId: "evidence_pause_corpus_drift",
        idempotencyKey: "commit:episode_pause_corpus_drift:0001",
      });
      await storage.commitEpisode({
        idempotencyKey: changedCorpus.idempotencyKey,
        episode: changedCorpus.episode,
        evidence: changedCorpus.evidence,
        blobs: [],
      });
      const live = (await recovered.learningInspection()).action_frontier;
      const drifted = {
        envelope: envelope("learning_resume", "restart_drift"),
        expected_control_epoch: live.expected_control_epoch,
        expected_frontier_hash: live.expected_frontier_hash,
        runtime_identity_hash: live.runtime_identity_hash,
        configuration_hash: live.configuration_hash,
        corpus_hash: live.corpus_hash,
        abandon_in_flight: false,
      } as const;
      approvals.approve(drifted);
      expect(await recovered.learningResume(drifted)).toMatchObject({
        status: "FAILED",
        error: { code: "CONFLICT" },
      });

      const abandoned = {
        ...drifted,
        envelope: envelope("learning_resume", "restart_abandon"),
        abandon_in_flight: true,
      } as const;
      approvals.approve(abandoned);
      expect(await recovered.learningResume(abandoned)).toMatchObject({
        status: "OK",
        data: {
          control: {
            status: "active",
            control_epoch: 2,
            reason_code: "IN_FLIGHT_ABANDONED_AFTER_DRIFT",
          },
        },
      });
    } finally {
      await storage.close();
    }

    const finalStorage = await SqliteStorageClient.open({ dataRoot });
    try {
      expect(
        (await runtime(finalStorage, approvals).learningInspection()).control,
      ).toMatchObject({
        status: "active",
        control_epoch: 2,
      });
    } finally {
      await finalStorage.close();
    }
  });

  it("advances principal-local control epochs independently", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-pause-multi-principal"),
    });
    try {
      const firstScope = {
        kind: "workspace",
        id: "workspace_principal_a",
      } as const;
      const secondScope = {
        kind: "workspace",
        id: "workspace_principal_b",
      } as const;
      const firstApprovals = new TestApprovalRegistry();
      const secondApprovals = new TestApprovalRegistry();
      const create = (
        principalId: string,
        scope: typeof firstScope | typeof secondScope,
        approvals: TestApprovalRegistry,
      ) =>
        new MemoryRuntime({
          storage,
          approvalRegistry: approvals,
          clock: () => NOW,
          policy: {
            principal: {
              principal_id: principalId,
              allowed_scopes: [scope],
              allowed_authorities: ["user_stated"],
              destructive_tools_enabled: false,
            },
          },
        });
      const first = create(
        "principal_a",
        firstScope,
        firstApprovals,
      );
      const second = create(
        "principal_b",
        secondScope,
        secondApprovals,
      );
      const pause = async (
        memory: MemoryRuntime,
        approvals: TestApprovalRegistry,
        principalId: string,
        scope: typeof firstScope | typeof secondScope,
      ) => {
        const frontier =
          (await memory.learningInspection()).action_frontier;
        const request = {
          envelope: {
            schema_version: "1.0.0",
            request_id: `request_pause_${principalId}`,
            tool: "learning_pause",
            actor_claim: {
              principal_id: principalId,
              authority: "user_stated",
            },
            scopes: [scope],
            purpose: "pause one principal learning loop",
            reason: "prove principal-local control epoch isolation",
            requested_at: NOW,
            safety_class: "important_mutation",
            idempotency_key: `learning-pause-${principalId}-001`,
            expected_revision_id: null,
            approval_id: `approval_pause_${principalId}`,
            dry_run: false,
          },
          expected_control_epoch: frontier.expected_control_epoch,
          expected_frontier_hash: frontier.expected_frontier_hash,
          runtime_identity_hash: frontier.runtime_identity_hash,
          configuration_hash: frontier.configuration_hash,
          corpus_hash: frontier.corpus_hash,
        } as const;
        approvals.approve(request);
        return memory.learningPause(request);
      };

      expect(
        await pause(first, firstApprovals, "principal_a", firstScope),
      ).toMatchObject({
        status: "OK",
        data: { control: { control_epoch: 1 } },
      });
      expect(
        await pause(
          second,
          secondApprovals,
          "principal_b",
          secondScope,
        ),
      ).toMatchObject({
        status: "OK",
        data: { control: { control_epoch: 1 } },
      });
    } finally {
      await storage.close();
    }
  });
});

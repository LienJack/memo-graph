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

const WORKSPACE_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const HASH_RUNTIME = `sha256:${"8".repeat(64)}` as const;
const HASH_CONFIGURATION = `sha256:${"9".repeat(64)}` as const;
const HASH_CORPUS = `sha256:${"a".repeat(64)}` as const;
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
    const pauseRequest = {
      envelope: envelope("learning_pause", "restart_pause"),
      expected_control_epoch: 0,
      expected_frontier_hash:
        (await storage.health()).learning_frontier.frontier_hash,
      runtime_identity_hash: HASH_RUNTIME,
      configuration_hash: HASH_CONFIGURATION,
      corpus_hash: HASH_CORPUS,
    } as const;
    approvals.approve(pauseRequest);
    expect(await runtime(storage, approvals).learningPause(pauseRequest))
      .toMatchObject({ status: "OK" });
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    try {
      const recovered = runtime(storage, approvals);
      expect((await recovered.learningInspection()).control).toMatchObject({
        status: "paused",
        control_epoch: 1,
      });
      const frontier =
        (await storage.health()).learning_frontier.frontier_hash;
      const drifted = {
        envelope: envelope("learning_resume", "restart_drift"),
        expected_control_epoch: 1,
        expected_frontier_hash: frontier,
        runtime_identity_hash: `sha256:${"b".repeat(64)}`,
        configuration_hash: HASH_CONFIGURATION,
        corpus_hash: HASH_CORPUS,
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
});

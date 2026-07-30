import {
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationIntentSchema,
  OperatorConfirmationTrustSchema,
  ScopeSchema,
  canonicalSha256,
  scopeKey,
  type OperationIntent,
} from "../../packages/contracts/src/index.js";
import { LearningReleaseManager } from "../../packages/learning-lab/dist/index.js";
import {
  FileRecoveryHeadProvider,
  SqliteStorageClient,
  WorkerRequestSchema,
  operatorKeyRotationParameters,
} from "@memo-graph/storage-sqlite";

import {
  keyRotationStateBindings,
  runConfirmedKeyRotation,
} from "../../apps/operator-cli/src/commands/key.js";
import {
  rebuildStateBindings,
  runConfirmedCanonicalProjectionRebuild,
  runConfirmedFtsRebuild,
} from "../../apps/operator-cli/src/commands/rebuild.js";
import {
  learningRollbackStateBindings,
  runConfirmedLearningRollback,
} from "../../apps/operator-cli/src/commands/rollback.js";
import { signOperatorConfirmationFromDescriptor } from "../../apps/operator-cli/src/confirmation-authority.js";
import { OperatorActionLedger } from "../../apps/operator-cli/src/operator-action-ledger.js";
import {
  authorizeRelease,
  authorizeRollback,
  preparePassedCanary,
  releaseRequest,
  rollbackRequest,
  TestReleaseApprovalRegistry,
} from "../helpers/g5-release.js";
import { learningCandidate } from "../helpers/learning-examples.js";

const cleanupPaths: string[] = [];
const EXECUTED_AT = "2026-07-30T10:02:00.000Z";
const ISSUED_AT = "2026-07-30T10:00:00.000Z";
const EXPIRES_AT = "2026-07-30T10:04:00.000Z";
const SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_operator_effect",
});

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function recoveryProvider(root: string): FileRecoveryHeadProvider {
  const keys = generateKeyPairSync("ed25519");
  return new FileRecoveryHeadProvider({
    directory: join(root, "recovery-head"),
    authorityKeyId: `${root.split("/").at(-1) ?? "fixture"}_recovery`,
    trustRootVersion: 1,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    create: true,
  });
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function signedIntent(input: {
  root: string;
  operationId: string;
  command:
    | "rebuild_fts"
    | "rebuild_layered_projection"
    | "key_rotate"
    | "learning_rollback";
  principalId: string;
  sourceRef: string;
  targetRef: string;
  parameters: unknown;
  bindings: Pick<
    OperationIntent,
    | "recovery_anchor_hash"
    | "configuration_digest"
    | "key_state_digest"
    | "expected_state_digest"
    | "expected_frontier_digest"
  >;
  issuedAt?: string;
  expiresAt?: string;
}) {
  const issuedAt = input.issuedAt ?? ISSUED_AT;
  const expiresAt = input.expiresAt ?? EXPIRES_AT;
  const body = {
    schema_version: "1.0.0" as const,
    operation_id: input.operationId,
    command: input.command,
    principal_id: input.principalId,
    root_ref: "root_primary",
    source_ref: input.sourceRef,
    target_ref: input.targetRef,
    ...input.bindings,
    parameters_digest: canonicalSha256(input.parameters),
    nonce: `${input.operationId}_nonce`,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const intent = OperationIntentSchema.parse({
    ...body,
    intent_hash: canonicalSha256(body),
  });
  const keys = generateKeyPairSync("ed25519");
  const privatePath = join(input.root, `${input.operationId}.pk8`);
  writeFileSync(
    privatePath,
    keys.privateKey.export({ type: "pkcs8", format: "der" }),
    { mode: 0o600 },
  );
  const trust = OperatorConfirmationTrustSchema.parse({
    algorithm: "Ed25519",
    purpose: "memo-graph/operator-confirmation/v1",
    authority_key_id: `${input.operationId}_authority`,
    authority_key_generation: 1,
    public_key_spki: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    max_ttl_seconds: 300,
    revoked_key_ids: [],
  });
  const descriptor = openSync(privatePath, "r");
  try {
    return {
      intent,
      trust,
      confirmation: signOperatorConfirmationFromDescriptor({
        descriptor,
        intent,
        trust,
        confirmationId: `${input.operationId}_confirmation`,
        issuedAt,
        expiresAt,
      }),
    };
  } finally {
    closeSync(descriptor);
  }
}

function operatorTableCount(dataRoot: string, table: string): number {
  const database = new DatabaseSync(
    join(dataRoot, "ledger", "memory.db"),
    { readOnly: true },
  );
  try {
    return Number(
      (
        database
          .prepare(`SELECT count(*) AS count FROM ${table}`)
          .get() as { count: number }
      ).count,
    );
  } finally {
    database.close();
  }
}

describe("confirmed operator effect runners", () => {
  it("does not authorize an unrelated worker operation from rotation context", () => {
    expect(() =>
      WorkerRequestSchema.parse({
        requestId: "00000000-0000-4000-8000-000000000001",
        operation: "install_encryption_key",
        payload: null,
        operator_authorization: "confirmed_key_rotation",
      }),
    ).toThrow("operator authorization is invalid");
  });

  it("executes and replays one FTS repair with one durable receipt", async () => {
    const root = temporaryRoot("confirmed-fts");
    const dataRoot = join(root, "data");
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: recoveryProvider(root),
    });
    try {
      const bindings = await rebuildStateBindings(storage);
      const plan = signedIntent({
        root,
        operationId: "confirmed_fts_repair_1",
        command: "rebuild_fts",
        principalId: "user_local",
        sourceRef: "canonical_sqlite",
        targetRef: "fts",
        parameters: {
          repair_kind: "fts",
          source: "canonical_sqlite",
          target: "fts",
        },
        bindings,
      });
      const ledger = new OperatorActionLedger(join(root, "action-ledger"));
      const execute = () =>
        runConfirmedFtsRebuild({
          storage,
          ...plan,
          now: EXECUTED_AT,
          ledger,
        });
      const first = await execute();
      expect(await execute()).toEqual(first);
      expect(first).toMatchObject({
        status: "completed",
        repair_kind: "fts",
      });
      await expect(
        storage.inspectOperationalRepair({
          operation_id: plan.intent.operation_id,
        }),
      ).resolves.toMatchObject({ state: "completed" });
      expect(ledger.read(plan.intent.operation_id)?.state).toBe("responded");
      expect(operatorTableCount(dataRoot, "operator_action_receipts")).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it.each([
    "layered_projection",
    "sqlite_relations",
  ] as const)(
    "executes and replays one %s repair with one durable receipt",
    async (repairKind) => {
      const root = temporaryRoot(`confirmed-${repairKind}`);
      const dataRoot = join(root, "data");
      const storage = await SqliteStorageClient.open({
        dataRoot,
        recoveryHeadProvider: recoveryProvider(root),
      });
      try {
        const bindings = await rebuildStateBindings(storage);
        const plan = signedIntent({
          root,
          operationId: `confirmed_${repairKind}_repair_1`,
          command: "rebuild_layered_projection",
          principalId: "user_local",
          sourceRef: "canonical_sqlite",
          targetRef: repairKind,
          parameters: {
            repair_kind: repairKind,
            source: "canonical_sqlite",
            target: repairKind,
            principal_id: "user_local",
            scope: SCOPE,
          },
          bindings,
        });
        const ledger = new OperatorActionLedger(
          join(root, "action-ledger"),
        );
        const execute = () =>
          runConfirmedCanonicalProjectionRebuild({
            storage,
            repairKind,
            principalId: "user_local",
            scope: SCOPE,
            ...plan,
            now: EXECUTED_AT,
            ledger,
          });
        const first = await execute();
        expect(await execute()).toEqual(first);
        expect(first).toMatchObject({
          status: "completed",
          repair_kind: repairKind,
        });
        await expect(
          storage.inspectOperationalRepair({
            operation_id: plan.intent.operation_id,
          }),
        ).resolves.toMatchObject({
          state: "completed",
          repair_kind: repairKind,
        });
        expect(ledger.read(plan.intent.operation_id)?.state).toBe(
          "responded",
        );
        expect(
          operatorTableCount(dataRoot, "operator_action_receipts"),
        ).toBe(1);
      } finally {
        await storage.close();
      }
    },
  );

  it("executes and replays one key rotation with one confirmation binding and receipt", async () => {
    const root = temporaryRoot("confirmed-key-rotation");
    const dataRoot = join(root, "data");
    const descriptorNames = [
      "old-key",
      "old-authority",
      "old-commitment",
      "new-key",
      "new-authority",
      "new-commitment",
    ];
    const descriptors = descriptorNames.map((name, index) => {
      const path = join(root, `${name}.bin`);
      writeFileSync(path, Buffer.alloc(32, index + 1), { mode: 0o600 });
      return openSync(path, "r");
    });
    const [
      oldKey,
      oldAuthority,
      oldCommitment,
      newKey,
      newAuthority,
      newCommitment,
    ] = descriptors as [number, number, number, number, number, number];
    const provider = recoveryProvider(root);
    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      recoveryHeadProvider: provider,
    });
    try {
      await storage.darkLaunchInstallEncryptionKey({
        idempotency_key: "confirmed-key-install-1",
        key_id: "key_confirmed_old",
        key_generation: 1,
        key_descriptor: oldKey,
        authority_key_id: "authority_confirmed_old",
        authority_descriptor: oldAuthority,
        commitment_key_id: "commitment_confirmed_old",
        commitment_descriptor: oldCommitment,
      });
      await storage.close();
      storage = await SqliteStorageClient.open({
        dataRoot,
        recoveryHeadProvider: provider,
      });
      const begin = {
        rotation_id: "rotation_confirmed_runner_1",
        new_key_id: "key_confirmed_new",
        new_key_generation: 2,
        new_key_descriptor: newKey,
        new_authority_key_id: "authority_confirmed_new",
        new_authority_descriptor: newAuthority,
        new_commitment_key_id: "commitment_confirmed_new",
        new_commitment_descriptor: newCommitment,
      };
      const resume = {
        old_key_descriptor: oldKey,
        new_key_descriptor: newKey,
        old_authority_descriptor: oldAuthority,
        new_commitment_descriptor: newCommitment,
        max_items: 10,
      };
      const state = await keyRotationStateBindings(storage);
      const plan = signedIntent({
        root,
        operationId: "confirmed_key_rotation_1",
        command: "key_rotate",
        principalId: "user_local",
        sourceRef: begin.rotation_id,
        targetRef: begin.new_key_id,
        parameters: operatorKeyRotationParameters({ begin, resume }),
        bindings: state.bindings,
      });
      const ledger = new OperatorActionLedger(join(root, "action-ledger"));
      await expect(
        storage.darkLaunchBeginKeyRotation(begin),
      ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
      const capability = await storage.authorizeOperatorKeyRotation({
        ...plan,
        now: EXECUTED_AT,
        begin,
        resume,
      });
      await expect(capability.begin()).resolves.toMatchObject({
        progress: {
          state: "in_progress",
          rotation_id: begin.rotation_id,
        },
      });
      await storage.close();
      storage = await SqliteStorageClient.open({
        dataRoot,
        recoveryHeadProvider: provider,
      });
      const execute = () =>
        runConfirmedKeyRotation({
          storage,
          begin,
          resume,
          ...plan,
          now: EXECUTED_AT,
          ledger,
        });
      const first = await execute();
      await storage.close();
      storage = await SqliteStorageClient.open({
        dataRoot,
        recoveryHeadProvider: provider,
      });
      expect(await execute()).toEqual(first);
      expect(first).toMatchObject({
        status: "completed",
        current_key_id: begin.new_key_id,
        remaining_items: 0,
      });
      expect(ledger.read(plan.intent.operation_id)?.state).toBe("responded");
      expect(operatorTableCount(dataRoot, "operator_action_receipts")).toBe(1);
      expect(
        operatorTableCount(dataRoot, "operator_confirmation_bindings"),
      ).toBe(1);
    } finally {
      await storage.close();
      for (const descriptor of descriptors) {
        closeSync(descriptor);
      }
    }
  });

  it("executes and replays one governed named-release rollback with one receipt", async () => {
    const root = temporaryRoot("confirmed-learning-rollback");
    const dataRoot = join(root, "data");
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: recoveryProvider(root),
    });
    try {
      const approvals = new TestReleaseApprovalRegistry();
      const firstPrepared = await preparePassedCanary({
        storage,
        suffix: "operator-confirmed-first",
      });
      const firstRequest = releaseRequest({
        suffix: "operator-confirmed-first",
      });
      authorizeRelease({
        request: firstRequest,
        prepared: firstPrepared,
        approvals,
      });
      const first = await new LearningReleaseManager({
        storage,
        authorityRegistry: firstPrepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      }).apply(firstRequest);

      const secondCandidate = learningCandidate({
        candidate_id: "candidate_operator_confirmed_second",
        target: {
          kind: "retrieval_policy",
          requested_lanes: ["recent_l1"],
          limits: { max_candidates_per_lane: 5 },
        },
        base_release_ids: [first.release.release_id],
        active_base_release_id: first.release.release_id,
        trace_ids: ["trace_operator_confirmed_second"],
        rollback_target_release_id: first.release.release_id,
      });
      const secondPrepared = await preparePassedCanary({
        storage,
        suffix: "operator-confirmed-second",
        candidate: secondCandidate,
      });
      const secondRequest = releaseRequest({
        suffix: "operator-confirmed-second",
        candidateId: secondCandidate.candidate_id,
      });
      authorizeRelease({
        request: secondRequest,
        prepared: secondPrepared,
        approvals,
        baseReleaseId: first.release.release_id,
        expectedPointerRevision: first.pointer.pointer_revision,
      });
      const manager = new LearningReleaseManager({
        storage,
        authorityRegistry: secondPrepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:06:00.000Z",
      });
      const second = await manager.apply(secondRequest);
      const rollback = rollbackRequest({
        suffix: "operator-confirmed-second",
        released: second,
        targetReleaseId: first.release.release_id,
      });
      authorizeRollback({
        request: rollback,
        prepared: secondPrepared,
        released: second,
        targetRelease: first,
        approvals,
      });
      const registryHash = canonicalSha256({
        authority: "operator-confirmed-learning-authority",
        approvals: "operator-confirmed-learning-approvals",
      });
      const bindings = await learningRollbackStateBindings(
        storage,
        registryHash,
      );
      const canonicalRollback = {
        ...rollback,
        scopes: rollback.scopes
          .map((scope) => ScopeSchema.parse(scope))
          .sort((left, right) =>
            scopeKey(left).localeCompare(scopeKey(right)),
          ),
      };
      const plan = signedIntent({
        root,
        operationId: "confirmed_learning_rollback_1",
        command: "learning_rollback",
        principalId: rollback.principal_id,
        sourceRef: rollback.candidate_id,
        targetRef: first.release.release_id,
        parameters: canonicalRollback,
        bindings,
        issuedAt: "2026-07-28T12:05:00.000Z",
        expiresAt: "2026-07-28T12:09:00.000Z",
      });
      const ledger = new OperatorActionLedger(join(root, "action-ledger"));
      const execute = () =>
        runConfirmedLearningRollback({
          storage,
          manager,
          learningRegistryHash: registryHash,
          request: canonicalRollback,
          ...plan,
          now: "2026-07-28T12:06:00.000Z",
          ledger,
        });
      const result = await execute();
      expect(await execute()).toEqual(result);
      expect(result).toMatchObject({
        status: "completed",
        action: "rollback",
        target_release_id: first.release.release_id,
      });
      const learningLedger = await storage.readLearningLedger({
        principal_id: rollback.principal_id,
        scopes: rollback.scopes,
        candidate_id: rollback.candidate_id,
      });
      expect(learningLedger.pointers).toEqual([
        expect.objectContaining({
          active_release_id: first.release.release_id,
          pointer_revision: 3,
        }),
      ]);
      expect(ledger.read(plan.intent.operation_id)?.state).toBe("responded");
      expect(operatorTableCount(dataRoot, "operator_action_receipts")).toBe(1);
    } finally {
      await storage.close();
    }
  });
});

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
  ArtifactPurgeAuditSchema,
  ArtifactStoreIdSchema,
  OperationIntentSchema,
  OperatorConfirmationTrustSchema,
  canonicalJson,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import {
  OperatorActionLedger,
} from "../../apps/operator-cli/src/operator-action-ledger.js";
import {
  signOperatorConfirmationFromDescriptor,
} from "../../apps/operator-cli/src/confirmation-authority.js";
import {
  purgeRetryStateBindings,
  runConfirmedPurgeRetry,
} from "../../apps/operator-cli/src/commands/purge-audit.js";
import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import {
  PURGE_NOW,
  PURGE_SCOPE,
  deleteRequest,
} from "../helpers/purge-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const NOW = "2026-07-30T11:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function runtime(
  storage: SqliteStorageClient,
  approvals: TestApprovalRegistry,
): MemoryRuntime {
  return new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    clock: () => PURGE_NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [PURGE_SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: true,
      },
      default_token_budget: 1_800,
    },
  });
}

async function proposeShared(
  kernel: MemoryRuntime,
  suffix: string,
  evidenceIds?: string[],
): Promise<{ memory_id: string; current_revision_id: string }> {
  const response = await kernel.memoryPropose(
    memoryProposal({
      candidate: memoryCandidate({
        candidateId: `candidate_purge_audit_${suffix}`,
        logicalKey: `user.preference.purge_audit_${suffix}`,
        scope: PURGE_SCOPE,
        text: "Shared purge audit marker 4892.",
        ...(evidenceIds === undefined ? {} : { evidenceIds }),
      }),
      idempotencyKey: `memory-propose-purge-audit-${suffix}`,
      requestId: `request_purge_audit_${suffix}`,
    }),
  );
  if (response.status !== "OK") {
    throw new Error(
      `purge audit fixture must activate: ${JSON.stringify(response)}`,
    );
  }
  return response.data as {
    memory_id: string;
    current_revision_id: string;
  };
}

async function tombstone(
  kernel: MemoryRuntime,
  approvals: TestApprovalRegistry,
  memory: { memory_id: string; current_revision_id: string },
  suffix: string,
): Promise<string> {
  const request = deleteRequest({
    memoryId: memory.memory_id,
    revisionId: memory.current_revision_id,
    idempotencyKey: `memory-delete-purge-audit-${suffix}`,
    approvalId: `approval_delete_purge_audit_${suffix}`,
  });
  approvals.approve(request);
  const response = await kernel.memoryDelete(request);
  if (response.status !== "OK") {
    throw new Error("purge audit fixture must tombstone");
  }
  return (response.data as { purge_job_id: string }).purge_job_id;
}

describe("complete artifact purge audit", () => {
  it("enumerates the 0015 registry without rewriting historical purge receipts", async () => {
    const dataRoot = temporaryRoot("purge-audit-complete");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const audit = await storage.auditPurgeArtifacts({
      audit_id: "artifact_purge_audit_1",
      expected_tombstone_epoch: 0,
      checked_at: NOW,
    });
    expect(ArtifactPurgeAuditSchema.parse(audit)).toMatchObject({
      completed: true,
      tombstone_epoch: 0,
    });
    expect(audit.stores.map(({ store_id }) => store_id)).toEqual(
      ArtifactStoreIdSchema.options,
    );
    expect(
      audit.stores.filter(({ outcome }) => outcome === "verified_ineligible")
        .map(({ store_id }) => store_id),
    ).toEqual([
      "graph_projection_disabled",
      "vector_projection_disabled",
    ]);
    expect(
      await storage.auditPurgeArtifacts({
        audit_id: "artifact_purge_audit_1",
        expected_tombstone_epoch: 0,
        checked_at: NOW,
      }),
    ).toEqual(audit);
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    expect(
      database
        .prepare("SELECT count(*) AS count FROM purge_store_outcomes")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT audit_hash, audit_json FROM operational_purge_audits",
        )
        .get(),
    ).toEqual({
      audit_hash: audit.audit_hash,
      audit_json: canonicalJson(audit),
    });
    database.close();
  });

  it("blocks missing and stale frontiers after tombstone advancement", async () => {
    const dataRoot = temporaryRoot("purge-audit-frontier-proof");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({ text: "Shared purge audit marker 4892." }),
    );
    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals);
    const first = await proposeShared(kernel, "proof_first");
    const firstJob = await tombstone(
      kernel,
      approvals,
      first,
      "proof_first",
    );
    const missing = await storage.auditPurgeArtifacts({
      audit_id: "artifact_purge_audit_missing_frontier",
      expected_tombstone_epoch: 1,
      checked_at: NOW,
    });
    expect(missing.completed).toBe(false);
    expect(
      missing.stores.every(
        ({ outcome, error_code }) =>
          outcome === "blocked" &&
          error_code === "PURGE_FRONTIER_MISSING",
      ),
    ).toBe(true);
    await storage.runPurge({ purge_job_id: firstJob });

    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_purge_frontier_second",
        evidenceId: "evidence_purge_frontier_second",
        idempotencyKey: "commit-purge-frontier-second",
        text: "Shared purge audit marker 4892.",
      }),
    );
    const second = await proposeShared(kernel, "proof_second", [
      "evidence_purge_frontier_second",
    ]);
    await tombstone(
      kernel,
      approvals,
      second,
      "proof_second",
    );
    const stale = await storage.auditPurgeArtifacts({
      audit_id: "artifact_purge_audit_stale_frontier",
      expected_tombstone_epoch: 2,
      checked_at: NOW,
    });
    expect(stale.completed).toBe(false);
    expect(
      stale.stores.some(
        ({ outcome, error_code }) =>
          outcome === "blocked" &&
          error_code === "PURGE_FRONTIER_STALE",
      ),
    ).toBe(true);
    await storage.close();
  });

  it("blocks completion on registered debt and converges only through a confirmed retry", async () => {
    const dataRoot = temporaryRoot("purge-audit-debt");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({ text: "Shared purge audit marker 4892." }),
    );
    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals);
    const first = await proposeShared(kernel, "first");
    const second = await proposeShared(kernel, "second");
    const firstJob = await tombstone(
      kernel,
      approvals,
      first,
      "first",
    );
    const firstPartial = await storage.runPurge({
      purge_job_id: firstJob,
    });
    expect(firstPartial).toMatchObject({
      completed: false,
      state: "partial",
    });
    const blocked = await storage.auditPurgeArtifacts({
      audit_id: "artifact_purge_audit_blocked",
      expected_tombstone_epoch: 1,
      checked_at: NOW,
    });
    expect(blocked.completed).toBe(false);
    expect(
      blocked.stores.find(
        ({ store_id }) => store_id === "canonical_evidence",
      ),
    ).toMatchObject({
      outcome: "retryable",
      debt_count: 1,
      error_code: "PURGE_DEBT_REMAINS",
    });
    const secondJob = await tombstone(
      kernel,
      approvals,
      second,
      "second",
    );
    expect(
      await storage.runPurge({ purge_job_id: secondJob }),
    ).toMatchObject({ completed: true, state: "purged" });

    const stateBindings = await purgeRetryStateBindings(storage, {
      purgeJobId: firstJob,
      expectedPriorReceiptId: firstPartial.receipt_id,
    });
    const intentBody = {
      schema_version: "1.0.0" as const,
      operation_id: "confirmed_purge_retry_1",
      command: "purge_retry" as const,
      principal_id: "user_local",
      root_ref: "root_primary",
      source_ref: firstJob,
      target_ref: firstPartial.receipt_id,
      ...stateBindings,
      parameters_digest: canonicalSha256({
        purge_job_id: firstJob,
        expected_prior_receipt_id: firstPartial.receipt_id,
      }),
      nonce: "confirmed_purge_retry_nonce_1",
      issued_at: NOW,
      expires_at: "2026-07-30T11:05:00.000Z",
    };
    const intent = OperationIntentSchema.parse({
      ...intentBody,
      intent_hash: canonicalSha256(intentBody),
    });
    const keys = generateKeyPairSync("ed25519");
    const trust = OperatorConfirmationTrustSchema.parse({
      algorithm: "Ed25519",
      purpose: "memo-graph/operator-confirmation/v1",
      authority_key_id: "purge_confirmation_authority_1",
      authority_key_generation: 1,
      public_key_spki: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
      max_ttl_seconds: 300,
      revoked_key_ids: [],
    });
    const keyPath = join(
      temporaryRoot("purge-confirmation-key"),
      "key.pk8",
    );
    writeFileSync(
      keyPath,
      keys.privateKey.export({ type: "pkcs8", format: "der" }),
      { mode: 0o600 },
    );
    const descriptor = openSync(keyPath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor,
      intent,
      trust,
      confirmationId: "confirmed_purge_retry_confirmation_1",
      issuedAt: "2026-07-30T11:00:01.000Z",
      expiresAt: "2026-07-30T11:04:00.000Z",
    });
    closeSync(descriptor);
    const result = await runConfirmedPurgeRetry({
      storage,
      purgeJobId: firstJob,
      intent,
      confirmation,
      trust,
      now: "2026-07-30T11:02:00.000Z",
      ledger: new OperatorActionLedger(
        join(temporaryRoot("purge-action-ledger"), "ledger"),
      ),
    });
    expect(result).toMatchObject({
      status: "completed",
      purge_job_id: firstJob,
      completed: true,
      residual_count: 0,
    });
    const recovered = await storage.auditPurgeArtifacts({
      audit_id: "artifact_purge_audit_recovered",
      expected_tombstone_epoch: 2,
      checked_at: "2026-07-30T11:03:00.000Z",
    });
    expect(
      recovered.completed,
      JSON.stringify(recovered.stores),
    ).toBe(true);
    expect(
      recovered.stores.find(
        ({ store_id }) => store_id === "canonical_evidence",
      ),
    ).toMatchObject({
      outcome: "verified_retained_identity_only",
      debt_count: 0,
      error_code: null,
    });
    await storage.close();
  });

  it("never hides active encrypted ownership when a same-epoch retry otherwise converges", async () => {
    const root = temporaryRoot("purge-audit-encrypted-owner");
    const dataRoot = join(root, "data");
    const descriptorPaths = [
      "encryption-key",
      "authority-key",
      "commitment-key",
      "secret-input",
    ].map((name, index) => {
      const path = join(root, `${name}.bin`);
      writeFileSync(
        path,
        index === 3 ? Buffer.alloc(64, 0x53) : Buffer.alloc(32, index + 1),
        { mode: 0o600 },
      );
      return path;
    });
    const descriptors = descriptorPaths.map((path) => openSync(path, "r"));
    const [
      keyDescriptor,
      authorityDescriptor,
      commitmentDescriptor,
      secretDescriptor,
    ] = descriptors as [number, number, number, number];
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "user_local",
    });
    try {
      await storage.commitEpisode(
        inlineEpisode({ text: "Shared purge audit marker 4892." }),
      );
      const approvals = new TestApprovalRegistry();
      const kernel = runtime(storage, approvals);
      const first = await proposeShared(kernel, "encrypted_first");
      const second = await proposeShared(kernel, "encrypted_second");
      const firstJob = await tombstone(
        kernel,
        approvals,
        first,
        "encrypted_first",
      );
      await expect(
        storage.runPurge({ purge_job_id: firstJob }),
      ).resolves.toMatchObject({ completed: false });
      const secondJob = await tombstone(
        kernel,
        approvals,
        second,
        "encrypted_second",
      );
      await expect(
        storage.runPurge({ purge_job_id: secondJob }),
      ).resolves.toMatchObject({ completed: true });

      await storage.darkLaunchInstallEncryptionKey({
        idempotency_key: "install-purge-audit-encryption-key",
        key_id: "key:purge-audit:1",
        key_generation: 1,
        key_descriptor: keyDescriptor,
        authority_key_id: "authority:purge-audit:1",
        authority_descriptor: authorityDescriptor,
        commitment_key_id: "commitment:purge-audit:1",
        commitment_descriptor: commitmentDescriptor,
      });
      await storage.darkLaunchAdmitSecret({
        idempotency_key: "admit-purge-audit-secret",
        request_digest: canonicalSha256({
          operation: "purge-audit-active-owner",
        }),
        principal_id: "user_local",
        owner: {
          kind: "evidence",
          id: "evidence:purge-audit:active",
          generation: 1,
        },
        scope: PURGE_SCOPE,
        content_identity: "content:purge-audit:active",
        media_type: "application/octet-stream",
        input_descriptor: secretDescriptor,
      });

      await expect(
        storage.runPurge({ purge_job_id: firstJob }),
      ).resolves.toMatchObject({ completed: true });
      const audit = await storage.auditPurgeArtifacts({
        audit_id: "artifact_purge_audit_active_encrypted_owner",
        expected_tombstone_epoch: 2,
        checked_at: NOW,
      });
      expect(audit.completed).toBe(false);
      expect(
        audit.stores.find(
          ({ store_id }) => store_id === "encrypted_content",
        ),
      ).toMatchObject({
        outcome: "blocked",
        debt_count: 1,
        error_code: "ENCRYPTED_CONTENT_OWNERSHIP_ACTIVE",
      });
    } finally {
      await storage.close();
      for (const descriptor of descriptors) {
        closeSync(descriptor);
      }
    }
  });
});

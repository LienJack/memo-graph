import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";
import {
  CanonicalHashSchema,
  canonicalJson,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import { prepareDataRoot } from "../../packages/storage-sqlite/src/data-root.js";
import { recoveryProtectedIdempotencyKey } from "../../packages/storage-sqlite/src/client.js";
import { StorageDatabase } from "../../packages/storage-sqlite/src/database.js";
import { inlineEpisode } from "../helpers/storage-examples.js";
import { testRecoveryHeadProvider } from "../helpers/recovery.js";

const cleanup: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-frontier-${prefix}-`)),
  );
  chmodSync(root, 0o700);
  cleanup.push(root);
  return root;
}

function copyMigrations(target: string, through: number): void {
  const source = join(process.cwd(), "migrations");
  for (const name of readdirSync(source).sort()) {
    const version = /^(?<version>\d{4})-/u.exec(name)?.groups?.version;
    if (version !== undefined && Number(version) <= through) {
      cpSync(join(source, name), join(target, name));
    }
  }
}

function frontierStats(databasePath: string): {
  full_scan_count: number;
  last_change_id: number;
  row_count: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const cache = database
      .prepare(
        `SELECT full_scan_count, last_change_id
         FROM recovery_frontier_cache WHERE singleton = 1`,
      )
      .get() as {
      full_scan_count: number;
      last_change_id: number;
    };
    const rows = database
      .prepare(`SELECT count(*) AS value FROM recovery_frontier_rows`)
      .get() as { value: number };
    return {
      full_scan_count: Number(cache.full_scan_count),
      last_change_id: Number(cache.last_change_id),
      row_count: Number(rows.value),
    };
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("incremental recovery frontier", () => {
  it("derives stable, stage-distinct purge identities from one operator action", () => {
    const payload = {
      purge_job_id: "purge_job:stable_identity",
      operator_action: {
        operation_id: "operator_action:stable_identity",
        expected_prior_receipt_id: null,
      },
    };
    const serialized = JSON.parse(JSON.stringify(payload)) as unknown;
    const runIdentity = recoveryProtectedIdempotencyKey(
      "run_purge",
      payload,
    );
    expect(runIdentity).toBe(
      "run_purge:operator_action:stable_identity",
    );
    expect(
      recoveryProtectedIdempotencyKey("run_purge", serialized),
    ).toBe(runIdentity);
    expect(
      recoveryProtectedIdempotencyKey("complete_purge", {
        ...payload,
        maintenance: {
          purge_job_id: payload.purge_job_id,
          attempt: 1,
          outcomes_hash: canonicalSha256("purge-outcomes"),
        },
      }),
    ).toBe("complete_purge:operator_action:stable_identity");

    const dataRoot = temporaryRoot("purge-identity-conflict");
    const database = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: join(process.cwd(), "migrations"),
      busyTimeoutMs: 5_000,
    });
    const state = database.recoveryState();
    database.close();
    const provider = testRecoveryHeadProvider(
      "recovery_authority:purge_identity_conflict",
    );
    provider.bootstrap(state);
    provider.reserve({
      operation: "purge",
      idempotency_key: runIdentity ?? "unreachable",
      request_hash: CanonicalHashSchema.parse(
        canonicalSha256(payload),
      ),
      prior_minimums: state.minimums,
      prior_state_commitment_hash: state.state_commitment_hash,
    });
    expect(() =>
      provider.reserve({
        operation: "purge",
        idempotency_key: runIdentity ?? "unreachable",
        request_hash: CanonicalHashSchema.parse(
          canonicalSha256({ ...payload, purge_job_id: "purge_job:wrong" }),
        ),
        prior_minimums: state.minimums,
        prior_state_commitment_hash: state.state_commitment_hash,
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("seeds once on 0018 upgrade and keeps protected mutation work independent of corpus size", async () => {
    const dataRoot = temporaryRoot("upgrade-data");
    const migrationRoot = temporaryRoot("upgrade-migrations");
    copyMigrations(migrationRoot, 18);

    const preUpgrade = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    preUpgrade.close();

    const databasePath = join(dataRoot, "ledger", "memory.db");
    const fixture = new DatabaseSync(databasePath);
    try {
      const insertRequest = fixture.prepare(
        `INSERT INTO recall_requests (
           request_id, principal_id, request_hash, request_json, created_at
         ) VALUES (?, 'principal_local_default', ?, '{}', ?)`,
      );
      const insertContext = fixture.prepare(
        `INSERT INTO context_slices (
           context_slice_id, request_id, compiler_version, token_budget,
           token_used, frozen_hash, slice_json, created_at
         ) VALUES (?, ?, 'fixture-v1', 1, 0, ?, '{}', ?)`,
      );
      const insertRelation = fixture.prepare(
        `INSERT INTO relation_objects (
           relation_id, principal_id, scope_kind, scope_id, lifecycle,
           current_relation_revision_id, created_at, updated_at
         ) VALUES (
           ?, 'principal_local_default', 'workspace', 'workspace_fixture',
           'purged', NULL, ?, ?
         )`,
      );
      fixture.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 4_000; index += 1) {
        const suffix = String(index).padStart(6, "0");
        const timestamp = "2026-08-02T00:00:00.000Z";
        insertRequest.run(
          `request_frontier_${suffix}`,
          `sha256:${suffix.padStart(64, "0")}`,
          timestamp,
        );
        insertContext.run(
          `context_frontier_${suffix}`,
          `request_frontier_${suffix}`,
          `sha256:${suffix.padStart(64, "1")}`,
          timestamp,
        );
        insertRelation.run(
          `relation_frontier_${suffix}`,
          timestamp,
          timestamp,
        );
      }
      fixture.exec("COMMIT");
    } finally {
      fixture.close();
    }

    copyMigrations(migrationRoot, 19);
    const provider = testRecoveryHeadProvider(
      "recovery_authority:incremental_upgrade",
    );
    const upgraded = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
      recoveryHeadProvider: provider,
    });
    await upgraded.close();

    const seeded = frontierStats(databasePath);
    expect(seeded).toMatchObject({
      full_scan_count: 1,
      last_change_id: 0,
    });
    expect(seeded.row_count).toBeGreaterThanOrEqual(8_000);

    const writer = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
      recoveryHeadProvider: provider,
    });
    await writer.commitEpisode(
      inlineEpisode({
        episodeId: "episode_incremental_frontier",
        evidenceId: "evidence_incremental_frontier",
        idempotencyKey: "commit:incremental-frontier:0001",
        text: "One protected mutation must not rescan the large frontier.",
      }),
    );
    await writer.close();

    const after = frontierStats(databasePath);
    expect(after.full_scan_count).toBe(seeded.full_scan_count);
    expect(after.last_change_id - seeded.last_change_id).toBeLessThanOrEqual(3);
    expect(after.row_count - seeded.row_count).toBe(1);
  });

  it("fails closed when a sealed cache is tampered behind the write guard", async () => {
    const dataRoot = temporaryRoot("tamper");
    const provider = testRecoveryHeadProvider(
      "recovery_authority:incremental_tamper",
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: provider,
    });
    await storage.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    try {
      database.exec(`
        INSERT INTO recovery_frontier_write_guard (singleton, opened_at)
        VALUES (1, '2026-08-02T00:00:00.000Z');
        UPDATE recovery_frontier_cache
        SET minimums_json = json_set(
          minimums_json,
          '$.ledger_epoch',
          json_extract(minimums_json, '$.ledger_epoch') + 1
        )
        WHERE singleton = 1;
        DELETE FROM recovery_frontier_write_guard WHERE singleton = 1;
      `);
    } finally {
      database.close();
    }

    await expect(
      SqliteStorageClient.open({
        dataRoot,
        recoveryHeadProvider: provider,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_AUTHORITY_INVALID" });
  });

  it("rejects a self-consistent cache forgery by replaying the immutable seed and journal", async () => {
    const dataRoot = temporaryRoot("replay-tamper");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_replay_tamper",
        evidenceId: "evidence_replay_tamper",
        idempotencyKey: "commit:replay-tamper:0001",
        text: "Full verification must not trust a self-consistent cache.",
      }),
    );
    await storage.close();

    const databasePath = join(dataRoot, "ledger", "memory.db");
    const database = new DatabaseSync(databasePath);
    try {
      const identity = database
        .prepare(
          `SELECT root_id, principal_id FROM recovery_root_identity
           WHERE singleton = 1`,
        )
        .get() as { root_id: string; principal_id: string };
      const row = database
        .prepare(
          `SELECT minimums_json, metadata_json, state_commitment_hash,
                  last_change_id, initialized_at, updated_at,
                  full_scan_count
           FROM recovery_frontier_cache WHERE singleton = 1`,
        )
        .get() as {
        minimums_json: string;
        metadata_json: string;
        state_commitment_hash: string;
        last_change_id: number;
        initialized_at: string;
        updated_at: string;
        full_scan_count: number;
      };
      const minimums = JSON.parse(row.minimums_json) as Record<string, unknown>;
      const metadata = JSON.parse(row.metadata_json) as {
        component_hashes: Record<string, unknown>;
      };
      const forged = canonicalSha256("forged-context-frontier");
      minimums.context_frontier_hash = forged;
      metadata.component_hashes.context = forged;
      const stateCommitmentHash = canonicalSha256({
        ...identity,
        minimums,
      });
      const cacheHash = canonicalSha256({
        schema_version: "1.0.0",
        minimums,
        metadata,
        state_commitment_hash: stateCommitmentHash,
        last_change_id: Number(row.last_change_id),
        initialized_at: row.initialized_at,
        updated_at: row.updated_at,
        full_scan_count: Number(row.full_scan_count),
      });
      database.exec(`
        INSERT INTO recovery_frontier_write_guard (singleton, opened_at)
        VALUES (1, '2026-08-02T00:00:00.000Z');
      `);
      database
        .prepare(
          `UPDATE recovery_frontier_cache
           SET minimums_json = ?, metadata_json = ?,
               state_commitment_hash = ?, cache_hash = ?
           WHERE singleton = 1`,
        )
        .run(
          canonicalJson(minimums),
          canonicalJson(metadata),
          stateCommitmentHash,
          cacheHash,
        );
      database.exec(
        `DELETE FROM recovery_frontier_write_guard WHERE singleton = 1`,
      );
    } finally {
      database.close();
    }

    const forged = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: join(process.cwd(), "migrations"),
      busyTimeoutMs: 5_000,
    });
    await expect(forged.createBackup()).rejects.toMatchObject({
      code: "RECOVERY_AUTHORITY_INVALID",
    });
    forged.close();
  });

  it("copies and fully verifies the same sealed frontier through backup and restore", async () => {
    const dataRoot = temporaryRoot("backup-source");
    const provider = testRecoveryHeadProvider(
      "recovery_authority:incremental_backup",
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider: provider,
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_incremental_backup",
        evidenceId: "evidence_incremental_backup",
        idempotencyKey: "commit:incremental-backup:0001",
        text: "The backup copies a verified incremental frontier.",
      }),
    );
    const backup = await storage.createBackup();
    await storage.close();

    const target = join(temporaryRoot("restore-parent"), "restored");
    await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: target,
      operationId: "restore:incremental-frontier:0001",
      recoveryHeadProvider: provider,
    });

    const backupDatabase = new DatabaseSync(backup.path, {
      readOnly: true,
    });
    const backupCache = backupDatabase
      .prepare(
        `SELECT minimums_json, metadata_json, state_commitment_hash,
                last_change_id, cache_hash
         FROM recovery_frontier_cache WHERE singleton = 1`,
      )
      .get();
    backupDatabase.close();

    const restored = new DatabaseSync(
      join(target, "ledger", "memory.db"),
      { readOnly: true },
    );
    try {
      expect(
        restored
          .prepare(
            `SELECT minimums_json, metadata_json, state_commitment_hash,
                    last_change_id, cache_hash
             FROM recovery_frontier_cache WHERE singleton = 1`,
          )
          .get(),
      ).toMatchObject({
        minimums_json: (backupCache as { minimums_json: string })
          .minimums_json,
        metadata_json: (backupCache as { metadata_json: string })
          .metadata_json,
        state_commitment_hash: (backupCache as {
          state_commitment_hash: string;
        }).state_commitment_hash,
        last_change_id: (backupCache as { last_change_id: number })
          .last_change_id,
        cache_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
    } finally {
      restored.close();
    }
  });

  it("rolls back the whole protected effect when one transaction exceeds the journal bound", () => {
    const dataRoot = temporaryRoot("change-bound");
    const databasePath = join(dataRoot, "ledger", "memory.db");
    const database = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: join(process.cwd(), "migrations"),
      busyTimeoutMs: 5_000,
      testOperations: true,
    });
    const provider = testRecoveryHeadProvider(
      "recovery_authority:change_bound",
    );
    const state = database.recoveryState();
    const head = provider.bootstrap(state);
    database.installRecoveryCheckpoint(head);
    const authorization = provider.reserve({
      operation: "projection",
      idempotency_key: "projection:frontier-change-bound:0001",
      request_hash: CanonicalHashSchema.parse(
        canonicalSha256("frontier-change-bound"),
      ),
      prior_minimums: state.minimums,
      prior_state_commitment_hash: state.state_commitment_hash,
    });

    expect(() =>
      database.runRecoveryProtectedEffect(authorization, () => {
        database.generateRecoveryFrontierChangesForTest(20_001);
        return { completed: true };
      }),
    ).toThrowError(expect.objectContaining({
      code: "RECOVERY_AUTHORITY_INVALID",
    }));
    expect(
      database.recoveryEffect(authorization.reservation.pending_id),
    ).toBeNull();
    expect(database.recoveryState()).toEqual(state);
    database.close();

    const durable = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        durable
          .prepare(
            `SELECT count(*) AS value FROM recovery_frontier_changes`,
          )
          .get(),
      ).toEqual({ value: 0 });
      expect(
        durable
          .prepare(
            `SELECT count(*) AS value
             FROM recovery_frontier_write_guard`,
          )
          .get(),
      ).toEqual({ value: 0 });
      expect(
        durable
          .prepare(
            `SELECT count(*) AS value FROM recovery_anchored_effects`,
          )
          .get(),
      ).toEqual({ value: 0 });
    } finally {
      durable.close();
    }
    expect(provider.readCurrent()?.anchor_hash).toBe(head.anchor_hash);
    provider.abort({
      pending_id: authorization.reservation.pending_id,
      effect_provably_absent: true,
    });
    expect(provider.unresolvedPending()).toEqual([]);
  });

  it("compacts processed recovery-frontier history into a verified seed", async () => {
    const dataRoot = temporaryRoot("history-compaction");
    const databasePath = join(dataRoot, "ledger", "memory.db");
    const database = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: join(process.cwd(), "migrations"),
      busyTimeoutMs: 5_000,
      testOperations: true,
    });
    const provider = testRecoveryHeadProvider(
      "recovery_authority:history_compaction",
    );
    const state = database.recoveryState();
    const head = provider.bootstrap(state);
    database.installRecoveryCheckpoint(head);
    const authorization = provider.reserve({
      operation: "projection",
      idempotency_key: "projection:frontier-history-compaction:0001",
      request_hash: CanonicalHashSchema.parse(
        canonicalSha256("frontier-history-compaction"),
      ),
      prior_minimums: state.minimums,
      prior_state_commitment_hash: state.state_commitment_hash,
    });

    const protectedEffect = database.runRecoveryProtectedEffect(
      authorization,
      () => {
        database.generateRecoveryFrontierChangesForTest(5_000);
        return { completed: true };
      },
    );
    expect(protectedEffect.result).toEqual({ completed: true });
    const committedHead = provider.commit({
      pending_id: authorization.reservation.pending_id,
      backup_manifest_hash: null,
      state_commitment_hash:
        protectedEffect.recovery_effect.committed_state_commitment_hash,
      root_id: protectedEffect.recovery_effect.root_id,
      principal_id: protectedEffect.recovery_effect.principal_id,
      committed_minimums:
        protectedEffect.recovery_effect.committed_minimums,
    });
    database.reconcileRecoveryEffect(
      authorization.reservation.pending_id,
      committedHead,
    );
    provider.reconcile(authorization.reservation.pending_id);
    expect(database.recoveryState().minimums.projection_frontier_hash).not.toBe(
      state.minimums.projection_frontier_hash,
    );
    await expect(database.createBackup()).resolves.toMatchObject({
      integrity_check: "ok",
    });
    database.close();

    const reopened = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: join(process.cwd(), "migrations"),
      busyTimeoutMs: 5_000,
      testOperations: true,
    });
    reopened.installRecoveryCheckpoint(
      provider.readCurrent() ?? (() => {
        throw new Error("missing compacted recovery head");
      })(),
    );
    await expect(reopened.createBackup()).resolves.toMatchObject({
      integrity_check: "ok",
    });
    reopened.close();

    const durable = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        durable
          .prepare(
            `SELECT count(*) AS value FROM recovery_frontier_changes`,
          )
          .get(),
      ).toEqual({ value: 0 });
      const seed = durable
        .prepare(
          `SELECT last_change_id, seed_hash FROM recovery_frontier_seed
           WHERE singleton = 1`,
        )
        .get() as { last_change_id: number; seed_hash: string };
      expect(seed.last_change_id).toBeGreaterThanOrEqual(5_000);
      expect(seed.seed_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    } finally {
      durable.close();
    }
  });
});

import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { HASH_A, HASH_B, NOW } from "../helpers/examples.js";
import {
  blobEpisode,
  inlineEpisode,
} from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function databasePath(dataRoot: string): string {
  return join(dataRoot, "ledger", "memory.db");
}

function openDatabase(dataRoot: string): DatabaseSync {
  const database = new DatabaseSync(databasePath(dataRoot));
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("versioned L1 governance schema", () => {
  it("applies the governance and purge migrations with observable health", async () => {
    const dataRoot = temporaryRoot("governance-schema");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const health = await storage.health();
    const governance = await storage.governanceStatus();
    await storage.close();

    expect(health.schema_version).toBe("0019");
    expect(health.migrations).toHaveLength(19);
    expect(health.tombstone_epoch).toBe(0);
    expect(health.secure_delete).toBe(true);
    expect(health.counts).toMatchObject({
      memory_candidates: 0,
      memory_objects: 0,
      memory_revisions: 0,
      admission_decisions: 0,
      conflict_groups: 0,
      purge_jobs: 0,
      purge_receipts: 0,
      approval_consumptions: 0,
    });
    expect(governance).toEqual({
      tombstone_epoch: 0,
      governance: {
        memory_candidates: 0,
        memory_objects: 0,
        memory_revisions: 0,
        admission_decisions: 0,
        conflict_groups: 0,
        status_events: 0,
        pin_events: 0,
        usage_rules: 0,
      },
      purge: {
        memory_tombstones: 0,
        purge_jobs: 0,
        purge_store_outcomes: 0,
        purge_receipts: 0,
        approval_consumptions: 0,
      },
    });

    const restarted = await SqliteStorageClient.open({ dataRoot });
    expect(await restarted.governanceStatus()).toEqual(governance);
    await restarted.close();

    const database = openDatabase(dataRoot);
    const tables = (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type IN ('table', 'view') ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    database.close();

    expect(tables).toEqual(
      expect.arrayContaining([
        "memory_candidates",
        "memory_objects",
        "memory_revisions",
        "admission_decisions",
        "memory_conflict_groups",
        "memory_status_events",
        "memory_pin_events",
        "memory_usage_rules",
        "tombstone_state",
        "memory_tombstones",
        "purge_jobs",
        "purge_store_outcomes",
        "purge_receipts",
        "purge_blob_deletion_intents",
        "purge_physical_maintenance",
        "secret_purge_physical_maintenance",
        "approval_consumptions",
        "governance_mutation_results",
      ]),
    );
  });

  it("keeps revisions, decisions, and events append-only", async () => {
    const dataRoot = temporaryRoot("governance-append-only");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    await storage.close();

    const database = openDatabase(dataRoot);
    insertCandidate(database);
    insertCandidateMemory(database);

    expect(() =>
      database.exec(
        "UPDATE memory_candidates SET logical_key = 'changed' WHERE candidate_id = 'candidate_pref_1'",
      ),
    ).toThrow(/APPEND_ONLY/);
    expect(() =>
      database.exec(
        "UPDATE memory_revisions SET authority = 'derived' WHERE revision_id = 'revision_pref_1'",
      ),
    ).toThrow(/APPEND_ONLY/);
    expect(() =>
      database.exec(
        "DELETE FROM admission_decisions WHERE decision_id = 'decision_pref_1'",
      ),
    ).toThrow(/APPEND_ONLY/);
    expect(() =>
      database.exec(
        `UPDATE memory_objects
         SET current_revision_id = 'revision_pref_1'
         WHERE memory_id = 'memory_pref'`,
      ),
    ).toThrow(/GOVERNANCE_TRANSACTION_REQUIRED/);
    database.close();

    const restarted = await SqliteStorageClient.open({ dataRoot });
    expect(await restarted.contentReferenceCounts({
      content_hash: HASH_A,
    })).toEqual({
      content_hash: HASH_A,
      evidence_events: 0,
      memory_candidates: 1,
      memory_revisions: 1,
      live_revision_links: 0,
      artifacts: 0,
      total: 2,
    });
    expect((await restarted.governanceStatus()).governance).toMatchObject({
      memory_candidates: 1,
      memory_objects: 1,
      memory_revisions: 1,
      admission_decisions: 1,
    });
    await restarted.close();
  });

  it("allows the tombstone epoch to advance exactly one step", async () => {
    const dataRoot = temporaryRoot("tombstone-epoch");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.close();

    const database = openDatabase(dataRoot);
    expect(() =>
      database.exec(
        `UPDATE tombstone_state
         SET tombstone_epoch = 2, updated_at = '${NOW}'
         WHERE singleton = 1`,
      ),
    ).toThrow(/TOMBSTONE_EPOCH/);
    database.exec(
      `UPDATE tombstone_state
       SET tombstone_epoch = 1, updated_at = '${NOW}'
       WHERE singleton = 1`,
    );
    expect(
      (
        database
          .prepare(
            "SELECT tombstone_epoch FROM tombstone_state WHERE singleton = 1",
          )
          .get() as { tombstone_epoch: number }
      ).tombstone_epoch,
    ).toBe(1);
    expect(() =>
      database.exec(
        `UPDATE tombstone_state
         SET tombstone_epoch = 0, updated_at = '${NOW}'
         WHERE singleton = 1`,
      ),
    ).toThrow(/TOMBSTONE_EPOCH/);
    database.close();
  });

  it("counts shared evidence and blobs from canonical live references", async () => {
    const dataRoot = temporaryRoot("governance-references");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const command = blobEpisode({
      bytes: new TextEncoder().encode("shared governed artifact"),
    });
    await storage.commitEpisode(command);
    await storage.close();
    const evidence = command.evidence[0];
    if (evidence === undefined) {
      throw new Error("fixture requires evidence");
    }

    const database = openDatabase(dataRoot);
    insertActiveBlobMemory(
      database,
      "memory_shared_1",
      "revision_shared_1",
      HASH_A,
      evidence.evidence_id,
      evidence.content_hash,
    );
    insertActiveBlobMemory(
      database,
      "memory_shared_2",
      "revision_shared_2",
      HASH_B,
      evidence.evidence_id,
      evidence.content_hash,
    );
    database.close();

    const restarted = await SqliteStorageClient.open({ dataRoot });
    expect(await restarted.contentReferenceCounts({
      content_hash: evidence.content_hash,
    })).toEqual({
      content_hash: evidence.content_hash,
      evidence_events: 1,
      memory_candidates: 0,
      memory_revisions: 2,
      live_revision_links: 2,
      artifacts: 1,
      total: 4,
    });
    await restarted.close();

    const revoked = openDatabase(dataRoot);
    revoked.exec(
      `BEGIN IMMEDIATE;
       INSERT INTO governance_write_guard (singleton, operation, opened_at)
       VALUES (1, 'test-revoke', '${NOW}');
       UPDATE memory_objects
       SET lifecycle = 'revoked', context_eligible = 0, updated_at = '${NOW}'
       WHERE memory_id = 'memory_shared_1';
       DELETE FROM governance_write_guard WHERE singleton = 1;
       COMMIT;`,
    );
    revoked.close();

    const afterRevoke = await SqliteStorageClient.open({ dataRoot });
    expect((await afterRevoke.contentReferenceCounts({
      content_hash: evidence.content_hash,
    })).live_revision_links).toBe(1);
    await afterRevoke.close();
  });

  it("permits only purge-guarded content redaction", async () => {
    const dataRoot = temporaryRoot("purge-redaction");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const command = inlineEpisode({});
    await storage.commitEpisode(command);
    await storage.close();
    const evidence = command.evidence[0];
    if (evidence === undefined) {
      throw new Error("fixture requires evidence");
    }

    const database = openDatabase(dataRoot);
    insertPurgedMemory(database);

    expect(() =>
      database.exec(
        `UPDATE evidence_events
         SET payload_inline = '[PURGED]'
         WHERE evidence_id = 'evidence_storage_1'`,
      ),
    ).toThrow(/APPEND_ONLY/);

    database.exec(
      `UPDATE tombstone_state
       SET tombstone_epoch = 1, updated_at = '${NOW}'
       WHERE singleton = 1;
       INSERT INTO purge_jobs (
         purge_job_id, memory_id, tombstone_epoch, status, attempts,
         created_at, updated_at, last_error_code
       ) VALUES (
         'purge_job_1', 'memory_purged', 1, 'running', 1,
         '${NOW}', '${NOW}', NULL
       );
       INSERT INTO memory_tombstones (
         memory_id, revision_id, tombstone_epoch, purge_job_id,
         principal_id, scope_kind, scope_id, reason, created_at
       ) VALUES (
         'memory_purged', 'revision_purged_1', 1, 'purge_job_1',
         'user_local', 'workspace', 'workspace_local',
         'User requested deletion', '${NOW}'
       );
       INSERT INTO purge_redaction_guard (
         singleton, purge_job_id, memory_id, opened_at
       ) VALUES (1, 'purge_job_1', 'memory_purged', '${NOW}');
       UPDATE evidence_events
       SET payload_storage = 'inline',
           payload_inline = '[PURGED]',
           payload_blob_hash = NULL,
           media_type = 'application/x.memo-graph-redacted',
           purged_at = '${NOW}'
       WHERE evidence_id = 'evidence_storage_1';
       DELETE FROM purge_redaction_guard WHERE singleton = 1;`,
    );

    const row = database
      .prepare(
        `SELECT payload_inline, content_hash, source, purged_at
         FROM evidence_events WHERE evidence_id = 'evidence_storage_1'`,
      )
      .get() as {
      payload_inline: string;
      content_hash: string;
      source: string;
      purged_at: string;
    };
    expect(row).toEqual({
      payload_inline: "[PURGED]",
      content_hash: evidence.content_hash,
      source: "conversation_turn",
      purged_at: NOW,
    });
    expect(() =>
      database.exec(
        "UPDATE evidence_events SET source = 'import' WHERE evidence_id = 'evidence_storage_1'",
      ),
    ).toThrow(/APPEND_ONLY/);
    database.close();
  });
});

function insertCandidate(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO memory_candidates (
         candidate_id, logical_key, logical_key_hash, principal_id,
         scope_kind, scope_id, kind, sensitivity, inferred,
         content_storage, content_inline, content_blob_hash, media_type,
         content_hash, valid_from, valid_to, recorded_at, injection_risk,
         requires_user_confirmation, transform_name, transform_version,
         created_at, purged_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      "candidate_pref_1",
      "user.preference.explanation_style",
      HASH_A,
      "user_local",
      "workspace",
      "workspace_local",
      "semantic",
      "internal",
      0,
      "inline",
      "Prefer concise explanations.",
      null,
      "text/plain",
      HASH_A,
      NOW,
      null,
      NOW,
      "none",
      0,
      "memory-proposal",
      "1.0.0",
      NOW,
      null,
    );
  database.exec(
    `INSERT INTO memory_candidate_evidence (candidate_id, evidence_id)
     VALUES ('candidate_pref_1', 'evidence_storage_1')`,
  );
}

function insertCandidateMemory(database: DatabaseSync): void {
  database.exec(
    `INSERT INTO memory_objects (
       memory_id, logical_key_hash, principal_id, scope_kind, scope_id, kind,
       lifecycle, current_revision_id, pinned, context_eligible,
       created_at, updated_at
     ) VALUES (
       'memory_pref', '${HASH_A}', 'user_local', 'workspace',
       'workspace_local', 'semantic', 'candidate', NULL, 0, 0,
       '${NOW}', '${NOW}'
     );
     INSERT INTO memory_revisions (
       revision_id, memory_id, revision, abstraction, lifecycle, kind,
       scope_kind, scope_id, authority, sensitivity, valid_from, valid_to,
       recorded_at, inferred, content_storage, content_inline,
       content_blob_hash, media_type, content_hash, supersedes_revision_id,
       transform_name, transform_version, created_at, purged_at
     ) VALUES (
       'revision_pref_1', 'memory_pref', 1, 'l1_memory', 'candidate',
       'semantic', 'workspace', 'workspace_local', 'user_stated', 'internal',
       '${NOW}', NULL, '${NOW}', 0, 'inline', 'Prefer concise explanations.',
       NULL, 'text/plain', '${HASH_A}', NULL, 'memory-proposal', '1.0.0',
       '${NOW}', NULL
     );
     INSERT INTO memory_revision_evidence (revision_id, evidence_id)
     VALUES ('revision_pref_1', 'evidence_storage_1');
     INSERT INTO admission_decisions (
       decision_id, memory_id, revision_id, decision, principal_id,
       actor_authority, decided_at, reason, conflict_group_id,
       requires_user_confirmation, decision_json
     ) VALUES (
       'decision_pref_1', 'memory_pref', 'revision_pref_1', 'candidate_only',
       'user_local', 'user_stated', '${NOW}', 'Candidate pending activation',
       NULL, 0, '{}'
     );`,
  );
}

function insertPurgedMemory(database: DatabaseSync): void {
  database.exec(
    `INSERT INTO memory_objects (
       memory_id, logical_key_hash, principal_id, scope_kind, scope_id, kind,
       lifecycle, current_revision_id, pinned, context_eligible,
       created_at, updated_at
     ) VALUES (
       'memory_purged', '${HASH_A}', 'user_local', 'workspace',
       'workspace_local', 'semantic', 'purged', NULL, 0, 0,
       '${NOW}', '${NOW}'
     );
     INSERT INTO memory_revisions (
       revision_id, memory_id, revision, abstraction, lifecycle, kind,
       scope_kind, scope_id, authority, sensitivity, valid_from, valid_to,
       recorded_at, inferred, content_storage, content_inline,
       content_blob_hash, media_type, content_hash, supersedes_revision_id,
       transform_name, transform_version, created_at, purged_at
     ) VALUES (
       'revision_purged_1', 'memory_purged', 1, 'l1_memory', 'purged',
       'semantic', 'workspace', 'workspace_local', 'user_stated', 'internal',
       '${NOW}', NULL, '${NOW}', 0, 'redacted', NULL, NULL,
       'application/x.memo-graph-redacted', '${HASH_A}', NULL,
       'memory-proposal', '1.0.0', '${NOW}', '${NOW}'
     );
     INSERT INTO memory_revision_evidence (revision_id, evidence_id)
     VALUES ('revision_purged_1', 'evidence_storage_1');`,
  );
}

function insertActiveBlobMemory(
  database: DatabaseSync,
  memoryId: string,
  revisionId: string,
  logicalKeyHash: string,
  evidenceId: string,
  contentHash: string,
): void {
  database.exec("BEGIN");
  database.exec("PRAGMA defer_foreign_keys = ON");
  try {
    database
      .prepare(
        `INSERT INTO memory_objects (
           memory_id, logical_key_hash, principal_id, scope_kind, scope_id,
           kind, lifecycle, current_revision_id, pinned, context_eligible,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memoryId,
        logicalKeyHash,
        "user_local",
        "workspace",
        "workspace_local",
        "semantic",
        "active",
        revisionId,
        0,
        1,
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO memory_revisions (
           revision_id, memory_id, revision, abstraction, lifecycle, kind,
           scope_kind, scope_id, authority, sensitivity, valid_from, valid_to,
           recorded_at, inferred, content_storage, content_inline,
           content_blob_hash, media_type, content_hash,
           supersedes_revision_id, transform_name, transform_version,
           created_at, purged_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revisionId,
        memoryId,
        1,
        "l1_memory",
        "active",
        "semantic",
        "workspace",
        "workspace_local",
        "user_stated",
        "internal",
        NOW,
        null,
        NOW,
        0,
        "blob",
        null,
        contentHash,
        "application/octet-stream",
        contentHash,
        null,
        "memory-proposal",
        "1.0.0",
        NOW,
        null,
      );
    database
      .prepare(
        `INSERT INTO memory_revision_evidence (revision_id, evidence_id)
         VALUES (?, ?)`,
      )
      .run(revisionId, evidenceId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

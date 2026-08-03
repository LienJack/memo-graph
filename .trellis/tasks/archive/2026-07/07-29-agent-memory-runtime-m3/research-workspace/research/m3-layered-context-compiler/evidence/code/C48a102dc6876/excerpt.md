# packages/storage-sqlite/src/purge-repository.ts:714

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `purgeProjections`
- Why: The purge projection stage currently covers FTS work and projection frontier only; M3 must register and verify new descendants without weakening nine-store purge completeness.

````typescript
   714    #purgeProjections(job: PurgeJobRow): Array<`sha256:${string}`> {
   715      const checkedAt = new Date().toISOString();
   716      const epoch = Number(
   717        (
   718          this.#database
   719            .prepare(
   720              "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
   721            )
   722            .get() as { ledger_epoch: number }
   723        ).ledger_epoch,
   724      );
   725      this.#database
   726        .transaction(() => {
   727          this.#database
   728            .prepare(
   729              `UPDATE outbox_jobs
   730               SET status = 'processed', attempts = attempts + 1,
   731                   processed_at = ?, last_error_code = NULL
   732               WHERE (
   733                 (
   734                   aggregate_id = ?
   735                   AND kind IN ('fts_memory_delete', 'fts_memory_invalidate')
   736                 )
   737                 OR (
   738                   kind = 'fts_evidence_upsert'
   739                   AND aggregate_id IN (
   740                     SELECT re.evidence_id
   741                     FROM memory_revisions AS r
   742                     JOIN memory_revision_evidence AS re
   743                       ON re.revision_id = r.revision_id
   744                     JOIN evidence_events AS e
   745                       ON e.evidence_id = re.evidence_id
   746                     WHERE r.memory_id = ? AND e.purged_at IS NOT NULL
   747                   )
   748                 )
   749               )
   750                 AND status IN ('pending', 'failed')`,
   751            )
   752            .run(checkedAt, job.memory_id, job.memory_id);
   753          const pending = Number(
   754            (
   755              this.#database
   756                .prepare(
   757                  `SELECT count(*) AS count
   758                   FROM outbox_jobs
   759                   WHERE kind IN (
   760                     'fts_evidence_upsert',
   761                     'fts_memory_upsert',
   762                     'fts_memory_delete',
   763                     'fts_memory_invalidate'
   764                   )
   765                     AND status IN ('pending', 'failed')`,
   766                )
   767                .get() as { count: number }
   768            ).count,
   769          );
   770          if (pending === 0) {
   771            this.#database
   772              .prepare(
   773                `UPDATE projection_state
   774                 SET status = 'ready', last_epoch = ?, updated_at = ?,
   775                     error_code = NULL
   776                 WHERE projection_name IN ('fts', 'memory_fts')`,
   777              )
   778              .run(epoch, checkedAt);
   779          }
   780        })
   781        .immediate();
   782      this.#database.pragma("wal_checkpoint(TRUNCATE)");
   783      this.#database.exec("VACUUM");
   784      return [];
````

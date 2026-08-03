# packages/storage-sqlite/src/fts-index.ts:390

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `FtsIndex rebuild`
- Why: FTS rebuild is transactionally reconstructed from canonical current eligible rows in stable order and advances projection state, establishing a reusable rebuild convention.

````typescript
   390
   391      try {
   392        const indexed = this.#database
   393          .transaction(() => {
   394            this.#database.exec("DROP TABLE IF EXISTS evidence_fts");
   395            this.#database.exec(CREATE_FTS_SQL);
   396            this.#database.exec("DROP TABLE IF EXISTS memory_fts");
   397            this.#database.exec(`
   398              CREATE VIRTUAL TABLE memory_fts USING fts5(
   399                memory_id UNINDEXED,
   400                revision_id UNINDEXED,
   401                principal_id UNINDEXED,
   402                scope_kind UNINDEXED,
   403                scope_id UNINDEXED,
   404                kind UNINDEXED,
   405                valid_from UNINDEXED,
   406                searchable_text,
   407                tokenize = 'unicode61 remove_diacritics 2'
   408              )
   409            `);
   410            this.#database.exec(
   411              "INSERT INTO evidence_fts(evidence_fts, rank) VALUES('secure-delete', 1)",
   412            );
   413            this.#database.exec(
   414              "INSERT INTO memory_fts(memory_fts, rank) VALUES('secure-delete', 1)",
   415            );
   416            this.#database.exec(`
   417              INSERT INTO evidence_fts (
   418                evidence_id, scope_kind, scope_id, source, occurred_at,
   419                searchable_text
   420              )
   421              SELECT evidence_id, scope_kind, scope_id, source, occurred_at,
   422                     payload_inline
   423              FROM evidence_events
   424              WHERE payload_storage = 'inline'
   425                AND purged_at IS NULL
   426              ORDER BY evidence_id
   427            `);
   428            this.#database.exec(`
   429              INSERT INTO memory_fts (
   430                memory_id, revision_id, principal_id, scope_kind, scope_id,
   431                kind, valid_from, searchable_text
   432              )
   433              SELECT o.memory_id, r.revision_id, o.principal_id, r.scope_kind,
   434                     r.scope_id, r.kind, r.valid_from, r.content_inline
   435              FROM memory_objects AS o
   436              JOIN memory_revisions AS r
   437                ON r.revision_id = o.current_revision_id
   438              WHERE o.lifecycle = 'active'
   439                AND o.context_eligible = 1
   440                AND r.lifecycle = 'active'
   441                AND r.content_storage = 'inline'
   442                AND EXISTS (
   443                  SELECT 1 FROM admission_decisions AS d
   444                  WHERE d.revision_id = r.revision_id
   445                    AND d.decision = 'activate'
   446                )
   447                AND EXISTS (
   448                  SELECT 1 FROM memory_revision_evidence AS l
   449                  WHERE l.revision_id = r.revision_id
   450                )
   451                AND NOT EXISTS (
   452                  SELECT 1
   453                  FROM memory_revision_evidence AS l
   454                  JOIN evidence_events AS e ON e.evidence_id = l.evidence_id
   455                  WHERE l.revision_id = r.revision_id
   456                    AND (
   457                      e.purged_at IS NOT NULL
   458                      OR e.principal_id <> o.principal_id
   459                      OR e.scope_kind <> r.scope_kind
   460                      OR e.scope_id <> r.scope_id
   461                    )
   462                )
   463                AND NOT EXISTS (
   464                  SELECT 1 FROM memory_conflict_groups AS c
   465                  WHERE c.logical_key_hash = o.logical_key_hash
   466                    AND c.principal_id = o.principal_id
   467                    AND c.scope_kind = o.scope_kind
   468                    AND c.scope_id = o.scope_id
   469                    AND c.status = 'open'
   470                )
   471              ORDER BY r.revision_id
   472            `);
   473            this.#database
   474              .prepare(
   475                `UPDATE outbox_jobs
   476                 SET status = 'processed', attempts = attempts + 1,
   477                     processed_at = ?, last_error_code = NULL
   478                 WHERE kind IN (
   479                   'fts_evidence_upsert',
   480                   'fts_memory_upsert',
   481                   'fts_memory_delete',
   482                   'fts_memory_invalidate'
   483                 )
   484                   AND status IN ('pending', 'failed')`,
   485              )
   486              .run(now());
   487            this.#database
   488              .prepare(
   489                `UPDATE projection_state
   490                 SET status = 'ready', last_epoch = ?, updated_at = ?,
````

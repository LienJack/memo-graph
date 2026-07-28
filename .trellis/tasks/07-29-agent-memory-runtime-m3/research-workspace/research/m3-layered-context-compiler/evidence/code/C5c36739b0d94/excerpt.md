# packages/storage-sqlite/src/fts-index.ts:110

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `FtsIndex drain outbox`
- Why: M2 already provides durable outbox claim/process/fail mechanics and source revalidation before projection insertion, which can anchor M3 projectors.

````typescript
   110          | "fts_evidence_upsert"
   111          | "fts_memory_upsert"
   112          | "fts_memory_delete"
   113          | "fts_memory_invalidate";
   114        aggregate_id: string;
   115      }>;
   116
   117      let processed = 0;
   118      let failed = 0;
   119      const insertFts = this.#database.prepare(
   120        `INSERT INTO evidence_fts (
   121           evidence_id, scope_kind, scope_id, source, occurred_at, searchable_text
   122         ) VALUES (?, ?, ?, ?, ?, ?)`,
   123      );
   124      const deleteFts = this.#database.prepare(
   125        "DELETE FROM evidence_fts WHERE evidence_id = ?",
   126      );
   127      const readEvidence = this.#database.prepare(
   128        `SELECT evidence_id, scope_kind, scope_id, source, occurred_at, payload_inline
   129         FROM evidence_events
   130         WHERE evidence_id = ?
   131           AND payload_storage = 'inline'
   132           AND purged_at IS NULL`,
   133      );
   134      const insertMemoryFts = this.#database.prepare(
   135        `INSERT INTO memory_fts (
   136           memory_id, revision_id, principal_id, scope_kind, scope_id, kind,
   137           valid_from, searchable_text
   138         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
   139      );
   140      const deleteMemoryRevision = this.#database.prepare(
   141        "DELETE FROM memory_fts WHERE revision_id = ?",
   142      );
   143      const deleteMemory = this.#database.prepare(
   144        "DELETE FROM memory_fts WHERE memory_id = ?",
   145      );
   146      const readMemory = this.#database.prepare(
   147        `SELECT o.memory_id, r.revision_id, o.principal_id, r.scope_kind,
   148                r.scope_id, r.kind, r.valid_from, r.content_inline
   149         FROM memory_revisions AS r
   150         JOIN memory_objects AS o
   151           ON o.memory_id = r.memory_id
   152          AND o.current_revision_id = r.revision_id
   153         WHERE r.revision_id = ?
   154           AND o.lifecycle = 'active'
   155           AND o.context_eligible = 1
   156           AND r.lifecycle = 'active'
   157           AND r.content_storage = 'inline'
   158           AND EXISTS (
   159             SELECT 1 FROM admission_decisions AS d
   160             WHERE d.revision_id = r.revision_id AND d.decision = 'activate'
   161           )
   162           AND EXISTS (
   163             SELECT 1 FROM memory_revision_evidence AS l
   164             WHERE l.revision_id = r.revision_id
   165           )
   166           AND NOT EXISTS (
   167             SELECT 1
   168             FROM memory_revision_evidence AS l
   169             JOIN evidence_events AS e ON e.evidence_id = l.evidence_id
   170             WHERE l.revision_id = r.revision_id
   171               AND (
   172                 e.purged_at IS NOT NULL
   173                 OR e.principal_id <> o.principal_id
   174                 OR e.scope_kind <> r.scope_kind
   175                 OR e.scope_id <> r.scope_id
   176               )
   177           )
   178           AND NOT EXISTS (
   179             SELECT 1 FROM memory_conflict_groups AS c
   180             WHERE c.logical_key_hash = o.logical_key_hash
   181               AND c.principal_id = o.principal_id
   182               AND c.scope_kind = o.scope_kind
   183               AND c.scope_id = o.scope_id
   184               AND c.status = 'open'
   185           )`,
   186      );
   187      const markProcessed = this.#database.prepare(
   188        `UPDATE outbox_jobs
   189         SET status = 'processed', attempts = attempts + 1,
   190             processed_at = ?, last_error_code = NULL
   191         WHERE job_id = ?`,
   192      );
   193      const markFailed = this.#database.prepare(
   194        `UPDATE outbox_jobs
   195         SET status = 'failed', attempts = attempts + 1,
   196             last_error_code = 'FTS_UNAVAILABLE'
   197         WHERE job_id = ?`,
   198      );
   199
   200      for (const job of jobs) {
   201        try {
   202          this.#database
   203            .transaction(() => {
   204              if (job.kind === "fts_evidence_upsert") {
   205                const evidence = readEvidence.get(
   206                  job.aggregate_id,
   207                ) as EvidenceFtsRow | undefined;
   208                deleteFts.run(job.aggregate_id);
   209                if (evidence !== undefined) {
   210                  insertFts.run(
````

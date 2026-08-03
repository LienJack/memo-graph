# packages/storage-sqlite/src/fts-index.ts:80

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `FtsIndex.drain_search_rebuild`
- Why: FTS 由 outbox 投影且可重建，但 rebuild 目前会从全部 inline evidence 重建，必须增加 tombstone hard filter

````typescript
    80    drain(limit = 1_000): DrainFtsResult {
    81      const jobs = this.#database
    82        .prepare(
    83          `SELECT job_id, aggregate_id
    84           FROM outbox_jobs
    85           WHERE kind = 'fts_evidence_upsert'
    86             AND status IN ('pending', 'failed')
    87             AND available_at <= ?
    88           ORDER BY available_at, job_id
    89           LIMIT ?`,
    90        )
    91        .all(now(), limit) as Array<{ job_id: string; aggregate_id: string }>;
    92  
    93      let processed = 0;
    94      let failed = 0;
    95      const insertFts = this.#database.prepare(
    96        `INSERT INTO evidence_fts (
    97           evidence_id, scope_kind, scope_id, source, occurred_at, searchable_text
    98         ) VALUES (?, ?, ?, ?, ?, ?)`,
    99      );
   100      const deleteFts = this.#database.prepare(
   101        "DELETE FROM evidence_fts WHERE evidence_id = ?",
   102      );
   103      const readEvidence = this.#database.prepare(
   104        `SELECT evidence_id, scope_kind, scope_id, source, occurred_at, payload_inline
   105         FROM evidence_events
   106         WHERE evidence_id = ? AND payload_storage = 'inline'`,
   107      );
   108      const markProcessed = this.#database.prepare(
   109        `UPDATE outbox_jobs
   110         SET status = 'processed', attempts = attempts + 1,
   111             processed_at = ?, last_error_code = NULL
   112         WHERE job_id = ?`,
   113      );
   114      const markFailed = this.#database.prepare(
   115        `UPDATE outbox_jobs
   116         SET status = 'failed', attempts = attempts + 1,
   117             last_error_code = 'FTS_UNAVAILABLE'
   118         WHERE job_id = ?`,
   119      );
   120  
   121      for (const job of jobs) {
   122        try {
   123          this.#database
   124            .transaction(() => {
   125              const evidence = readEvidence.get(
   126                job.aggregate_id,
   127              ) as EvidenceFtsRow | undefined;
   128              deleteFts.run(job.aggregate_id);
   129              if (evidence !== undefined) {
   130                insertFts.run(
   131                  evidence.evidence_id,
   132                  evidence.scope_kind,
   133                  evidence.scope_id,
   134                  evidence.source,
   135                  evidence.occurred_at,
   136                  evidence.payload_inline,
   137                );
   138              }
   139              markProcessed.run(now(), job.job_id);
   140            })
   141            .immediate();
   142          processed += 1;
   143        } catch {
   144          markFailed.run(job.job_id);
   145          failed += 1;
   146        }
   147      }
   148  
   149      const remaining = Number(
   150        (
   151          this.#database
   152            .prepare(
   153              `SELECT count(*) AS count FROM outbox_jobs
   154               WHERE kind = 'fts_evidence_upsert'
   155                 AND status IN ('pending', 'failed')`,
   156            )
   157            .get() as { count: number }
   158        ).count,
   159      );
   160      const epoch = this.#ledgerEpoch();
   161      const projectionState =
   162        failed > 0 ? "unavailable" : remaining > 0 ? "pending" : "ready";
   163      this.#database
   164        .prepare(
   165          `UPDATE projection_state
   166           SET status = ?, last_epoch = ?, updated_at = ?, error_code = ?
   167           WHERE projection_name = 'fts'`,
   168        )
   169        .run(
   170          projectionState,
   171          epoch,
   172          now(),
   173          failed > 0 ? "FTS_UNAVAILABLE" : null,
   174        );
   175  
   176      return {
   177        processed,
   178        failed,
   179        remaining,
   180        projection_state: projectionState,
   181      };
   182    }
   183  
   184    search(input: ParsedSearchEvidenceQuery): SearchEvidenceResult {
   185      const state = this.state().status;
   186      if (state !== "ready") {
   187        const reasonCode = {
   188          pending: "FTS_PENDING",
   189          rebuilding: "FTS_REBUILDING",
   190          unavailable: "FTS_UNAVAILABLE",
   191        }[state] as
   192          | "FTS_PENDING"
   193          | "FTS_REBUILDING"
   194          | "FTS_UNAVAILABLE";
   195        return { status: "DEGRADED", reason_code: reasonCode, items: [] };
   196      }
   197  
   198      try {
   199        const rows = this.#database
   200          .prepare(
   201            `SELECT f.evidence_id, f.scope_kind, f.scope_id, f.source,
   202                    f.occurred_at, f.searchable_text AS text,
   203                    bm25(evidence_fts) AS rank
   204             FROM evidence_fts AS f
   205             JOIN evidence_events AS e ON e.evidence_id = f.evidence_id
   206             WHERE evidence_fts MATCH ?
   207               AND e.principal_id = ?
   208               AND f.scope_kind = ?
   209               AND f.scope_id = ?
   210             ORDER BY rank, f.occurred_at DESC, f.evidence_id
   211             LIMIT ?`,
   212          )
   213          .all(
   214            compileQuery(input.query),
   215            input.principal_id,
   216            input.scope.kind,
   217            input.scope.id,
   218            input.limit,
   219          ) as SearchEvidenceResult["items"];
   220        if (rows.length === 0) {
   221          return { status: "NO_MATCH", items: [] };
   222        }
   223        return { status: "OK", items: rows };
   224      } catch {
   225        this.#database
   226          .prepare(
   227            `UPDATE projection_state
   228             SET status = 'unavailable', updated_at = ?,
   229                 error_code = 'FTS_UNAVAILABLE'
   230             WHERE projection_name = 'fts'`,
   231          )
   232          .run(now());
   233        return {
   234          status: "DEGRADED",
   235          reason_code: "FTS_UNAVAILABLE",
   236          items: [],
   237        };
   238      }
   239    }
   240  
   241    rebuild(): RebuildFtsResult {
   242      const epoch = this.#ledgerEpoch();
   243      this.#database
   244        .prepare(
   245          `UPDATE projection_state
   246           SET status = 'rebuilding', updated_at = ?, error_code = NULL
   247           WHERE projection_name = 'fts'`,
   248        )
   249        .run(now());
   250  
   251      try {
   252        const indexed = this.#database
   253          .transaction(() => {
   254            this.#database.exec("DROP TABLE IF EXISTS evidence_fts");
   255            this.#database.exec(CREATE_FTS_SQL);
   256            this.#database.exec(`
   257              INSERT INTO evidence_fts (
   258                evidence_id, scope_kind, scope_id, source, occurred_at,
   259                searchable_text
   260              )
   261              SELECT evidence_id, scope_kind, scope_id, source, occurred_at,
   262                     payload_inline
   263              FROM evidence_events
   264              WHERE payload_storage = 'inline'
   265              ORDER BY evidence_id
   266            `);
   267            this.#database
   268              .prepare(
   269                `UPDATE outbox_jobs
   270                 SET status = 'processed', attempts = attempts + 1,
   271                     processed_at = ?, last_error_code = NULL
   272                 WHERE kind = 'fts_evidence_upsert'
   273                   AND status IN ('pending', 'failed')`,
   274              )
   275              .run(now());
   276            this.#database
   277              .prepare(
   278                `UPDATE projection_state
   279                 SET status = 'ready', last_epoch = ?, updated_at = ?,
   280                     error_code = NULL
   281                 WHERE projection_name = 'fts'`,
   282              )
   283              .run(epoch, now());
   284            return Number(
   285              (
   286                this.#database
   287                  .prepare("SELECT count(*) AS count FROM evidence_fts")
   288                  .get() as { count: number }
   289              ).count,
   290            );
   291          })
   292          .immediate();
   293        return { indexed, ledger_epoch: epoch };
   294      } catch {
   295        this.#database
   296          .prepare(
   297            `UPDATE projection_state
   298             SET status = 'unavailable', updated_at = ?,
   299                 error_code = 'FTS_UNAVAILABLE'
   300             WHERE projection_name = 'fts'`,
   301          )
   302          .run(now());
   303        throw new StorageError("FTS_UNAVAILABLE");
   304      }
   305    }
````

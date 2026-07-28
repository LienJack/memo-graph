# packages/storage-sqlite/src/database.ts:265

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `StorageDatabase.commitEpisode`
- Why: 现有 writer 使用 BEGIN IMMEDIATE、双重幂等检查、事务内 ledger/outbox/receipt 提交，可复用为 L1 mutation 原子边界

````typescript
   265    commitEpisode(input: unknown): CommitResult {
   266      const command = CommitEpisodeCommandSchema.parse(input);
   267      this.#validateEpisode(command);
   268      const hash = requestHash(command);
   269      const existing = this.#readIdempotency(command.idempotencyKey);
   270      if (existing !== undefined) {
   271        return {
   272          receipt: this.#parseExistingReceipt(existing, hash),
   273          committed: false,
   274        };
   275      }
   276  
   277      const storedBlobs = this.#prepareBlobs(command);
   278      const searchableEvidence = command.evidence.filter(
   279        (record) => record.payload.storage === "inline",
   280      );
   281      const createdAt = now();
   282      const projectionJobs = searchableEvidence.map((record) =>
   283        stableIdentifier("job", {
   284          kind: "fts_evidence_upsert",
   285          episode_id: command.episode.episode_id,
   286          evidence_id: record.evidence_id,
   287        }),
   288      );
   289  
   290      try {
   291        const receipt = this.#database
   292          .transaction(() => {
   293            const repeated = this.#readIdempotency(command.idempotencyKey);
   294            if (repeated !== undefined) {
   295              return this.#parseExistingReceipt(repeated, hash);
   296            }
   297  
   298            this.#insertArtifacts(storedBlobs);
   299            this.#insertEvidence(command);
   300            this.#insertEpisode(command);
   301            const epoch = this.#advanceEpoch(createdAt);
   302            this.#insertOutbox(
   303              searchableEvidence.map((record, index) => ({
   304                jobId: projectionJobs[index] as string,
   305                evidenceId: record.evidence_id,
   306              })),
   307              createdAt,
   308            );
   309  
   310            const receipt = MutationReceiptSchema.parse(
   311              sealReceipt({
   312                schema_version: "1.0.0",
   313                receipt_id: stableIdentifier("receipt", {
   314                  idempotency_key: command.idempotencyKey,
   315                  request_hash: hash,
   316                }),
   317                created_at: createdAt,
   318                state:
   319                  projectionJobs.length > 0 ? "projection_pending" : "durable",
   320                request_hash: hash,
   321                receipt_hash: `sha256:${"0".repeat(64)}`,
   322                kind: "mutation",
   323                idempotency_key: command.idempotencyKey,
   324                affected_memory_ids: [],
   325                affected_revision_ids: [],
   326                resulting_epoch: epoch,
   327                projection_jobs: projectionJobs,
   328                warnings: [],
   329              }),
   330            );
   331            this.#insertReceipt(receipt, command);
   332            if (projectionJobs.length > 0) {
   333              this.#fts.markPending(epoch);
   334            }
   335            return receipt;
   336          })
   337          .immediate();
   338  
   339        return { receipt, committed: true };
   340      } catch (error) {
   341        if (error instanceof StorageError) {
   342          throw error;
   343        }
   344        if (
   345          typeof error === "object" &&
   346          error !== null &&
   347          "code" in error &&
   348          typeof error.code === "string" &&
   349          error.code.startsWith("SQLITE_CONSTRAINT")
   350        ) {
   351          throw new StorageError("CONFLICT");
   352        }
   353        throw error;
   354      }
   355    }
````

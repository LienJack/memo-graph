# packages/storage-sqlite/src/database.ts:635

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `StorageDatabase.recordRecall_insertRecall`
- Why: Context slice 与 receipt 作为不可变派生物持久化，删除需要通过 suppression/invalidation 阻止继续使用并记录清理结果

````typescript
   635    recordRecall(input: unknown): RecordRecallResult {
   636      const command = RecordRecallCommandSchema.parse(input);
   637      this.#validateRecall(command);
   638      const hash = canonicalSha256(command.request);
   639      const existing = this.#readRecall(command.request.request_id);
   640      if (existing !== undefined) {
   641        return this.#parseExistingRecall(
   642          existing,
   643          hash,
   644          command.principal_id,
   645        );
   646      }
   647  
   648      try {
   649        return this.#database
   650          .transaction(() => {
   651            const repeated = this.#readRecall(command.request.request_id);
   652            if (repeated !== undefined) {
   653              return this.#parseExistingRecall(
   654                repeated,
   655                hash,
   656                command.principal_id,
   657              );
   658            }
   659            this.#insertRecall(command);
   660            return {
   661              receipt: command.receipt,
   662              context_slice: command.context_slice ?? null,
   663              replayed: false,
   664            };
   665          })
   666          .immediate();
   667      } catch (error) {
   668        if (error instanceof StorageError) {
   669          throw error;
   670        }
   671        if (
   672          typeof error === "object" &&
   673          error !== null &&
   674          "code" in error &&
   675          typeof error.code === "string" &&
   676          error.code.startsWith("SQLITE_CONSTRAINT")
   677        ) {
   678          throw new StorageError("CONFLICT");
   679        }
   680        throw error;
   681      }
   682    }
   683  
   684    blockForTest(milliseconds: number): void {
   685      Atomics.wait(
   686        new Int32Array(new SharedArrayBuffer(4)),
   687        0,
   688        0,
   689        milliseconds,
   690      );
   691    }
   692  
   693    holdWriteLockForTest(milliseconds: number): void {
   694      this.#database.exec("BEGIN IMMEDIATE");
   695      try {
   696        this.blockForTest(milliseconds);
   697      } finally {
   698        this.#database.exec("ROLLBACK");
   699      }
   700    }
   701  
   702    close(): void {
   703      if (this.#database.open) {
   704        this.checkpoint();
   705        this.#database.close();
   706      }
   707    }
   708  
   709    #validateEpisode(command: ParsedCommitEpisodeCommand): void {
   710      const episode = EpisodeSchema.parse(command.episode);
   711      const evidence = command.evidence.map((record) =>
   712        EvidenceRecordSchema.parse(record),
   713      );
   714      const evidenceById = new Map(
   715        evidence.map((record) => [record.evidence_id, record]),
   716      );
   717      if (
   718        evidenceById.size !== evidence.length ||
   719        episode.event_ids.length !== evidence.length
   720      ) {
   721        throw new StorageError("INVALID_INPUT");
   722      }
   723  
   724      const ordered = [...evidence].sort(
   725        (left, right) => left.sequence - right.sequence,
   726      );
   727      ordered.forEach((record, index) => {
   728        if (record.sensitivity === "secret") {
   729          throw new StorageError("ENCRYPTION_REQUIRED");
   730        }
   731        if (
   732          record.sequence !== index ||
   733          episode.event_ids[index] !== record.evidence_id ||
   734          !sameScope(record.scope, episode.scope)
   735        ) {
   736          throw new StorageError("INVALID_INPUT");
   737        }
   738        if (
   739          record.payload.storage === "inline" &&
   740          canonicalSha256(record.payload) !== record.content_hash
   741        ) {
   742          throw new StorageError("INVALID_INPUT");
   743        }
   744        if (
   745          record.payload.storage === "blob" &&
   746          record.payload.content_hash !== record.content_hash
   747        ) {
   748          throw new StorageError("INVALID_INPUT");
   749        }
   750      });
   751  
   752      if (
   753        canonicalSha256Omitting(episode, ["sealed_hash"]) !== episode.sealed_hash
   754      ) {
   755        throw new StorageError("INVALID_INPUT");
   756      }
   757  
   758      const blobReferences = evidence
   759        .filter((record) => record.payload.storage === "blob")
   760        .map((record) => record.content_hash);
   761      assertSetEqual(blobReferences, episode.artifact_hashes);
   762      const suppliedBlobHashes: string[] = command.blobs.map(
   763        (blob) => blob.content_hash,
   764      );
   765      for (const blob of command.blobs) {
   766        const actual = createHash("sha256").update(blob.bytes).digest("hex");
   767        if (`sha256:${actual}` !== blob.content_hash) {
   768          throw new StorageError("INVALID_INPUT");
   769        }
   770      }
   771      const referencedHashes = new Set<string>(blobReferences);
   772      if (
   773        new Set(suppliedBlobHashes).size !== suppliedBlobHashes.length ||
   774        suppliedBlobHashes.some((hash) => !referencedHashes.has(hash))
   775      ) {
   776        throw new StorageError("INVALID_INPUT");
   777      }
   778    }
   779  
   780    #validateRecall(command: ParsedRecordRecallCommand): void {
   781      const request = RecallRequestSchema.parse(command.request);
   782      const receipt = RetrievalReceiptSchema.parse(command.receipt);
   783      const expectedRequestHash = canonicalSha256(request);
   784      if (
   785        receipt.request_hash !== expectedRequestHash ||
   786        !receiptHashIsValid(receipt)
   787      ) {
   788        throw new StorageError("INVALID_INPUT");
   789      }
   790  
   791      const contextSlice =
   792        command.context_slice === undefined
   793          ? null
   794          : ContextSliceSchema.parse(command.context_slice);
   795      if (contextSlice === null) {
   796        if (receipt.context_slice_id !== null) {
   797          throw new StorageError("INVALID_INPUT");
   798        }
   799        return;
   800      }
   801      if (
   802        contextSlice.request_id !== request.request_id ||
   803        receipt.context_slice_id !== contextSlice.context_slice_id ||
   804        contextSlice.compiler_version !== receipt.compiler_version ||
   805        contextSlice.token_budget !== request.token_budget ||
   806        canonicalSha256Omitting(contextSlice, ["frozen_hash"]) !==
   807          contextSlice.frozen_hash
   808      ) {
   809        throw new StorageError("INVALID_INPUT");
   810      }
   811  
   812      const allowedScopes = new Set(
   813        request.scopes.map((scope) => `${scope.kind}:${scope.id}`),
   814      );
   815      const includedMemoryIds = new Set(
   816        receipt.items
   817          .filter((item) => item.decision === "included")
   818          .map((item) => `${item.memory_id}:${item.revision_id}`),
   819      );
   820      for (const item of contextSlice.items) {
   821        if (
   822          !allowedScopes.has(`${item.scope.kind}:${item.scope.id}`) ||
   823          !includedMemoryIds.has(`${item.memory_id}:${item.revision_id}`)
   824        ) {
   825          throw new StorageError("INVALID_INPUT");
   826        }
   827        for (const evidenceId of item.evidence_ids) {
   828          const found = this.#database
   829            .prepare(
   830              `SELECT 1 FROM evidence_events
   831               WHERE evidence_id = ? AND scope_kind = ? AND scope_id = ?
   832                 AND principal_id = ?`,
   833            )
   834            .get(
   835              evidenceId,
   836              item.scope.kind,
   837              item.scope.id,
   838              command.principal_id,
   839            );
   840          if (found === undefined) {
   841            throw new StorageError("INVALID_INPUT");
   842          }
   843        }
   844      }
   845    }
   846  
   847    #readRecall(requestId: string): ExistingRecall | undefined {
   848      return this.#database
   849        .prepare(
   850          `SELECT q.request_id, q.principal_id, q.request_hash,
   851                  r.receipt_json, s.slice_json
   852           FROM recall_requests AS q
   853           JOIN retrieval_receipts AS r ON r.request_id = q.request_id
   854           LEFT JOIN context_slices AS s ON s.request_id = q.request_id
   855           WHERE q.request_id = ?`,
   856        )
   857        .get(requestId) as ExistingRecall | undefined;
   858    }
   859  
   860    #parseExistingRecall(
   861      existing: ExistingRecall,
   862      expectedRequestHash: string,
   863      expectedPrincipalId?: string,
   864    ): RecordRecallResult {
   865      if (
   866        existing.request_hash !== expectedRequestHash ||
   867        (expectedPrincipalId !== undefined &&
   868          existing.principal_id !== expectedPrincipalId)
   869      ) {
   870        throw new StorageError("CONFLICT");
   871      }
   872      const receipt = RetrievalReceiptSchema.parse(
   873        JSON.parse(existing.receipt_json) as unknown,
   874      );
   875      const contextSlice =
   876        existing.slice_json === null
   877          ? null
   878          : ContextSliceSchema.parse(
   879              JSON.parse(existing.slice_json) as unknown,
   880            );
   881      if (
   882        !receiptHashIsValid(receipt) ||
   883        receipt.request_hash !== existing.request_hash ||
   884        (contextSlice === null && receipt.context_slice_id !== null) ||
   885        (contextSlice !== null &&
   886          (contextSlice.request_id !== existing.request_id ||
   887            receipt.context_slice_id !== contextSlice.context_slice_id ||
   888            canonicalSha256Omitting(contextSlice, ["frozen_hash"]) !==
   889              contextSlice.frozen_hash))
   890      ) {
   891        throw new StorageError("CORRUPTION");
   892      }
   893      return { receipt, context_slice: contextSlice, replayed: true };
   894    }
   895  
   896    #insertRecall(command: ParsedRecordRecallCommand): void {
   897      const hash = canonicalSha256(command.request);
   898      this.#database
   899        .prepare(
   900          `INSERT INTO recall_requests (
   901             request_id, principal_id, request_hash, request_json, created_at
   902           ) VALUES (?, ?, ?, ?, ?)`,
   903        )
   904        .run(
   905          command.request.request_id,
   906          command.principal_id,
   907          hash,
   908          canonicalJson(command.request),
   909          command.receipt.created_at,
   910        );
   911  
   912      if (command.context_slice !== undefined) {
   913        const slice = command.context_slice;
   914        this.#database
   915          .prepare(
   916            `INSERT INTO context_slices (
   917               context_slice_id, request_id, compiler_version, token_budget,
   918               token_used, frozen_hash, slice_json, created_at
   919             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
   920          )
   921          .run(
   922            slice.context_slice_id,
   923            slice.request_id,
   924            slice.compiler_version,
   925            slice.token_budget,
   926            slice.token_used,
   927            slice.frozen_hash,
   928            canonicalJson(slice),
   929            slice.created_at,
   930          );
   931        const insertItem = this.#database.prepare(
   932          `INSERT INTO context_slice_items (
   933             context_slice_id, ordinal, memory_id, revision_id, item_json
   934           ) VALUES (?, ?, ?, ?, ?)`,
   935        );
   936        const insertEvidence = this.#database.prepare(
   937          `INSERT INTO context_slice_item_evidence (
   938             context_slice_id, ordinal, evidence_id
   939           ) VALUES (?, ?, ?)`,
   940        );
   941        slice.items.forEach((item, ordinal) => {
   942          insertItem.run(
   943            slice.context_slice_id,
   944            ordinal,
   945            item.memory_id,
   946            item.revision_id,
   947            canonicalJson(item),
   948          );
   949          for (const evidenceId of item.evidence_ids) {
   950            insertEvidence.run(slice.context_slice_id, ordinal, evidenceId);
   951          }
   952        });
   953      }
   954  
   955      this.#database
   956        .prepare(
   957          `INSERT INTO retrieval_receipts (
   958             receipt_id, request_id, context_slice_id, request_hash,
   959             receipt_hash, state, receipt_json, created_at
   960           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
   961        )
   962        .run(
   963          command.receipt.receipt_id,
   964          command.request.request_id,
   965          command.receipt.context_slice_id,
   966          command.receipt.request_hash,
   967          command.receipt.receipt_hash,
   968          command.receipt.state,
   969          canonicalJson(command.receipt),
   970          command.receipt.created_at,
   971        );
   972      const insertAccess = this.#database.prepare(
   973        `INSERT INTO receipt_access_scopes (
   974           receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
   975           created_at
   976         ) VALUES (?, 'retrieval', ?, ?, ?, ?)`,
   977      );
   978      for (const scope of command.request.scopes) {
   979        insertAccess.run(
   980          command.receipt.receipt_id,
   981          command.principal_id,
   982          scope.kind,
   983          scope.id,
   984          command.receipt.created_at,
   985        );
   986      }
   987    }
````

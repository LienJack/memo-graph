# packages/storage-sqlite/src/database.ts:385

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `StorageDatabase.createBackup`
- Why: 当前 backup 只冻结 ledger epoch、receipt、migration 和 blob inventory，尚未携带 tombstone frontier

````typescript
   385    async createBackup(): Promise<BackupResult> {
   386      const epoch = this.#ledgerEpoch();
   387      const backupId = `backup:${randomUUID()}`;
   388      const directory = join(
   389        this.#layout.backups,
   390        `snapshot-${epoch}-${backupId.slice("backup:".length)}`,
   391      );
   392      const backupBlobs = join(directory, "blobs");
   393      mkdirSync(backupBlobs, { recursive: true, mode: 0o700 });
   394      chmodSync(directory, 0o700);
   395      chmodSync(backupBlobs, 0o700);
   396      const path = join(directory, "memory.db");
   397      const latestReceipt = this.#latestReceipt();
   398      await this.#database.backup(path);
   399      chmodSync(path, 0o600);
   400  
   401      const artifacts = this.#database
   402        .prepare(
   403          `SELECT content_hash, size_bytes, media_type
   404           FROM artifacts ORDER BY content_hash`,
   405        )
   406        .all() as Array<{
   407          content_hash: string;
   408          size_bytes: number;
   409          media_type: string;
   410        }>;
   411      for (const artifact of artifacts) {
   412        this.#blobStore.verifyExisting(
   413          artifact.content_hash,
   414          Number(artifact.size_bytes),
   415        );
   416        const filename = artifact.content_hash.slice("sha256:".length);
   417        const destination = join(backupBlobs, filename);
   418        copyFileSync(
   419          this.#blobStore.pathFor(artifact.content_hash),
   420          destination,
   421          constants.COPYFILE_EXCL,
   422        );
   423        chmodSync(destination, 0o600);
   424        const copiedDigest = createHash("sha256")
   425          .update(readFileSync(destination))
   426          .digest("hex");
   427        if (`sha256:${copiedDigest}` !== artifact.content_hash) {
   428          throw new StorageError("CORRUPTION");
   429        }
   430        fsyncPath(destination);
   431      }
   432      fsyncPath(backupBlobs);
   433      fsyncPath(directory);
   434  
   435      const backup = new Database(path, {
   436        readonly: true,
   437        fileMustExist: true,
   438      });
   439      let integrityCheck: string;
   440      try {
   441        integrityCheck = String(
   442          backup.pragma("integrity_check", { simple: true }),
   443        ).toLowerCase();
   444        const backupEpoch = Number(
   445          (
   446            backup
   447              .prepare(
   448                "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
   449              )
   450              .get() as { ledger_epoch: number }
   451          ).ledger_epoch,
   452        );
   453        const backupReceipt = backup
   454          .prepare(
   455            `SELECT receipt_hash FROM mutation_receipts
   456             ORDER BY resulting_epoch DESC, receipt_id DESC LIMIT 1`,
   457          )
   458          .get() as LatestReceipt;
   459        const backupMigrations = backup
   460          .prepare(
   461            "SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version",
   462          )
   463          .all() as MigrationEvidence[];
   464  
   465        if (
   466          integrityCheck !== "ok" ||
   467          backupEpoch !== epoch ||
   468          backupReceipt?.receipt_hash !== latestReceipt?.receipt_hash ||
   469          canonicalJson(backupMigrations) !== canonicalJson(this.#migrations)
   470        ) {
   471          throw new StorageError("CORRUPTION");
   472        }
   473      } finally {
   474        backup.close();
   475      }
   476  
   477      const sizeBytes = statSync(path).size;
   478      this.#database
   479        .prepare(
   480          `INSERT INTO backup_manifests (
   481             backup_id, relative_path, created_at, ledger_epoch,
   482             latest_receipt_hash, migration_hashes_json, blob_hashes_json,
   483             size_bytes, integrity_check
   484           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
   485        )
   486        .run(
   487          backupId,
   488          `backups/${basename(directory)}/memory.db`,
   489          now(),
   490          epoch,
   491          latestReceipt?.receipt_hash ?? null,
   492          canonicalJson(this.#migrations),
   493          canonicalJson(artifacts.map((artifact) => artifact.content_hash)),
   494          sizeBytes,
   495          integrityCheck,
   496        );
   497  
   498      return {
   499        backup_id: backupId,
   500        directory,
   501        path,
   502        ledger_epoch: epoch,
   503        latest_receipt_hash: latestReceipt?.receipt_hash ?? null,
   504        blob_hashes: artifacts.map((artifact) => artifact.content_hash),
   505        integrity_check: "ok",
   506        size_bytes: sizeBytes,
   507      };
   508    }
````

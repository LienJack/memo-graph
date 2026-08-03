# packages/storage-sqlite/src/database.ts:171

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `StorageDatabase.constructor_health`
- Why: M2 继承单 writer、WAL、FULL synchronous、migration evidence 和 projection health 基线

````typescript
   171  export class StorageDatabase {
   172    readonly #database: Database.Database;
   173    readonly #layout: DataRootLayout;
   174    readonly #migrations: MigrationEvidence[];
   175    readonly #blobStore: BlobStore;
   176    readonly #fts: FtsIndex;
   177    readonly #journalMode: string;
   178  
   179    constructor(options: {
   180      layout: DataRootLayout;
   181      migrationsDir: string;
   182      busyTimeoutMs: number;
   183    }) {
   184      this.#layout = options.layout;
   185      this.#database = new Database(options.layout.database);
   186      chmodSync(options.layout.database, 0o600);
   187      this.#database.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
   188      this.#database.pragma("foreign_keys = ON");
   189      this.#database.pragma("synchronous = FULL");
   190      this.#database.pragma("temp_store = MEMORY");
   191      this.#database.pragma("trusted_schema = OFF");
   192      this.#database.pragma("recursive_triggers = ON");
   193      this.#database.pragma("journal_size_limit = 67108864");
   194      this.#database.pragma("wal_autocheckpoint = 1000");
   195      this.#journalMode = String(
   196        this.#database.pragma("journal_mode = WAL", { simple: true }),
   197      ).toLowerCase();
   198      if (this.#journalMode !== "wal") {
   199        this.#database.close();
   200        throw new StorageError("STORAGE_UNAVAILABLE");
   201      }
   202      this.#migrations = applyMigrations(this.#database, options.migrationsDir);
   203      this.#blobStore = new BlobStore(options.layout.blobs);
   204      this.#fts = new FtsIndex(this.#database);
   205    }
   206  
   207    health(): StorageHealth {
   208      const projection = this.#fts.state();
   209      const count = (table: string, where = ""): number =>
   210        Number(
   211          (
   212            this.#database
   213              .prepare(`SELECT count(*) AS count FROM ${table} ${where}`)
   214              .get() as { count: number }
   215          ).count,
   216        );
   217      const ftsRows = this.#tableExists("evidence_fts")
   218        ? count("evidence_fts")
   219        : 0;
   220      const schemaVersion = this.#migrations.at(-1)?.version;
   221      if (schemaVersion === undefined) {
   222        throw new StorageError("MIGRATION_DRIFT");
   223      }
   224      if (
   225        Number(this.#database.pragma("foreign_keys", { simple: true })) !== 1
   226      ) {
   227        throw new StorageError("STORAGE_UNAVAILABLE");
   228      }
   229  
   230      return {
   231        schema_version: schemaVersion,
   232        ledger_epoch: this.#ledgerEpoch(),
   233        latest_receipt_hash: this.#latestReceipt()?.receipt_hash ?? null,
   234        sqlite_version: String(
   235          (
   236            this.#database
   237              .prepare("SELECT sqlite_version() AS version")
   238              .get() as { version: string }
   239          ).version,
   240        ),
   241        journal_mode: "wal",
   242        foreign_keys: true,
   243        projection_state: projection.status,
   244        filesystem_type: this.#layout.filesystem_type,
   245        migrations: this.#migrations,
   246        counts: {
   247          evidence_events: count("evidence_events"),
   248          episodes: count("episodes"),
   249          mutation_receipts: count("mutation_receipts"),
   250          idempotency_keys: count("idempotency_keys"),
   251          outbox_pending: count(
   252            "outbox_jobs",
   253            "WHERE status IN ('pending', 'failed')",
   254          ),
   255          fts_rows: ftsRows,
   256          backup_manifests: count("backup_manifests"),
   257          recall_requests: count("recall_requests"),
   258          retrieval_receipts: count("retrieval_receipts"),
   259          context_slices: count("context_slices"),
   260          receipt_access_scopes: count("receipt_access_scopes"),
   261        },
   262      };
   263    }
````

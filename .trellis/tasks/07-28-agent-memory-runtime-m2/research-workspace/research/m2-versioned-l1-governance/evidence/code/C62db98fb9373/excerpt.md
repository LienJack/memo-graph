# packages/storage-sqlite/src/restore.ts:48

- Commit: `14248470946f937e3ce97ddadb506227e01b4650`
- Symbol: `restoreBackupToEmptyDataRoot`
- Why: 当前 restore 只校验 snapshot 内 epoch、receipt 和 blob 数，不能与 live tombstone frontier 比较

````typescript
    48  export async function restoreBackupToEmptyDataRoot(
    49    options: RestoreBackupOptions,
    50  ): Promise<RestoreBackupResult> {
    51    const backup = BackupResultSchema.parse(options.backup);
    52    const target = resolve(options.dataRoot);
    53    if (
    54      !isAbsolute(options.dataRoot) ||
    55      target === parse(target).root ||
    56      existsSync(target)
    57    ) {
    58      throw new StorageError("INVALID_DATA_ROOT");
    59    }
    60  
    61    const backupDirectory = realpathSync(backup.directory);
    62    const backupDatabase = realpathSync(backup.path);
    63    if (
    64      lstatSync(backupDirectory).isSymbolicLink() ||
    65      lstatSync(backupDatabase).isSymbolicLink() ||
    66      dirname(backupDatabase) !== backupDirectory
    67    ) {
    68      throw new StorageError("CORRUPTION");
    69    }
    70  
    71    mkdirSync(dirname(target), { recursive: true });
    72    const staging = `${target}.restore-${randomUUID()}`;
    73    let client: SqliteStorageClient | undefined;
    74    try {
    75      const layout = prepareDataRoot(staging);
    76      copyFileSync(
    77        backupDatabase,
    78        layout.database,
    79        constants.COPYFILE_EXCL,
    80      );
    81      chmodSync(layout.database, 0o600);
    82      fsyncPath(layout.database);
    83  
    84      for (const contentHash of backup.blob_hashes) {
    85        const filename = contentHash.slice("sha256:".length);
    86        const source = join(backupDirectory, "blobs", filename);
    87        if (
    88          !existsSync(source) ||
    89          lstatSync(source).isSymbolicLink() ||
    90          realpathSync(dirname(source)) !==
    91            realpathSync(join(backupDirectory, "blobs"))
    92        ) {
    93          throw new StorageError("CORRUPTION");
    94        }
    95        const destination = join(layout.blobs, filename);
    96        copyFileSync(source, destination, constants.COPYFILE_EXCL);
    97        chmodSync(destination, 0o600);
    98        fsyncPath(destination);
    99      }
   100      fsyncPath(layout.blobs);
   101      fsyncPath(layout.ledger);
   102      fsyncPath(layout.root);
   103  
   104      client = await SqliteStorageClient.open({
   105        dataRoot: layout.root,
   106        ...(options.migrationsDir === undefined
   107          ? {}
   108          : { migrationsDir: options.migrationsDir }),
   109      });
   110      const health = await client.health();
   111      const artifacts = await client.verifyArtifacts();
   112      if (
   113        health.ledger_epoch !== backup.ledger_epoch ||
   114        health.latest_receipt_hash !== backup.latest_receipt_hash ||
   115        artifacts.verified !== backup.blob_hashes.length
   116      ) {
   117        throw new StorageError("CORRUPTION");
   118      }
   119      await client.close();
   120      client = undefined;
   121      renameSync(staging, target);
   122  
   123      return {
   124        data_root: target,
   125        health,
   126        verified_blobs: artifacts.verified,
   127      };
   128    } catch (error) {
   129      if (client !== undefined) {
   130        await client.close().catch(() => undefined);
   131      }
   132      if (existsSync(staging)) {
   133        rmSync(staging, { recursive: true, force: true });
   134      }
   135      throw error;
   136    }
````

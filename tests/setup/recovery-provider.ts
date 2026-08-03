import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";

import {
  MemoryRecoveryHeadProvider,
  SqliteStorageClient,
  type SqliteStorageClientOptions,
} from "@memo-graph/storage-sqlite";
import { afterAll, vi } from "vitest";

const providers = new Map<string, MemoryRecoveryHeadProvider>();

export const openWithoutTestRecoveryProvider =
  SqliteStorageClient.open.bind(SqliteStorageClient);

export function testProviderForDataRoot(
  dataRoot: string,
): MemoryRecoveryHeadProvider {
  const key = resolve(dataRoot);
  const existing = providers.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const keys = generateKeyPairSync("ed25519");
  const provider = new MemoryRecoveryHeadProvider({
    authorityKeyId: `test_recovery_authority_${providers.size + 1}`,
    trustRootVersion: 1,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  providers.set(key, provider);
  return provider;
}

vi.spyOn(SqliteStorageClient, "open").mockImplementation(
  (options: SqliteStorageClientOptions) =>
    openWithoutTestRecoveryProvider({
      ...options,
      ...(Object.hasOwn(options, "recoveryHeadProvider")
        ? options.recoveryHeadProvider === undefined
          ? {}
          : { recoveryHeadProvider: options.recoveryHeadProvider }
        : {
            recoveryHeadProvider:
              testProviderForDataRoot(options.dataRoot),
          }),
    }),
);

afterAll(() => {
  providers.clear();
});

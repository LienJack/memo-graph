import { generateKeyPairSync } from "node:crypto";

import { MemoryRecoveryHeadProvider } from "@memo-graph/storage-sqlite";

export function testRecoveryHeadProvider(
  authorityKeyId = "recovery_authority:test",
): MemoryRecoveryHeadProvider {
  const keys = generateKeyPairSync("ed25519");
  return new MemoryRecoveryHeadProvider({
    authorityKeyId,
    trustRootVersion: 1,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
}

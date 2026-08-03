import { generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  FileRecoveryHeadProvider,
} from "@memo-graph/storage-sqlite";

export function mcpRecoveryFixture(dataRootInput: string) {
  mkdirSync(dataRootInput, { recursive: true, mode: 0o700 });
  const dataRoot = realpathSync(dataRootInput);
  const fixtureRoot = join(
    dirname(dataRoot),
    `${basename(dataRoot)}-recovery-fixture`,
  );
  const recoveryDirectory = join(fixtureRoot, "head");
  mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPath = join(fixtureRoot, "private-key.pem");
  const publicKeyPath = join(fixtureRoot, "public-key.pem");
  writeFileSync(
    privateKeyPath,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  writeFileSync(
    publicKeyPath,
    keys.publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o600 },
  );
  const authorityKeyId =
    `recovery_authority:mcp:${basename(dataRoot)}`;
  const provider = new FileRecoveryHeadProvider({
    directory: recoveryDirectory,
    authorityKeyId,
    trustRootVersion: 1,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    create: true,
  });
  return {
    provider,
    config: {
      enabled: true as const,
      directory: recoveryDirectory,
      authority_key_id: authorityKeyId,
      trust_root_version: 1,
      private_key_path: privateKeyPath,
      public_key_path: publicKeyPath,
    },
  };
}

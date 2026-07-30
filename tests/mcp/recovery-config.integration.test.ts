import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openMemoryRuntime,
} from "../../packages/mcp-server/src/index.js";
import {
  readPrivateOperatorFile,
} from "../../packages/mcp-server/src/trusted-file.js";
import {
  FileRecoveryHeadProvider,
} from "@memo-graph/storage-sqlite";

const cleanupPaths: string[] = [];

function temporaryRoot(label: string): string {
  const root = realpathSync(
    mkdtempSync(
      join(realpathSync(tmpdir()), `memo-m6-mcp-${label}-`),
    ),
  );
  cleanupPaths.push(root);
  return root;
}

function recoveryFixture(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "private.pem");
  const publicKeyPath = join(directory, "public.pem");
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
  const providerDirectory = join(directory, "head");
  new FileRecoveryHeadProvider({
    directory: providerDirectory,
    authorityKeyId: `recovery_authority:${directory.length}`,
    trustRootVersion: 1,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    create: true,
  });
  return {
    privateKeyPath,
    publicKeyPath,
    providerDirectory,
    config: {
      enabled: true as const,
      directory: providerDirectory,
      authority_key_id:
        `recovery_authority:${directory.length}`,
      trust_root_version: 1,
      private_key_path: privateKeyPath,
      public_key_path: publicKeyPath,
    },
  };
}

function serverConfig(
  dataRoot: string,
  recoveryHead: ReturnType<typeof recoveryFixture>["config"],
) {
  return {
    data_root: dataRoot,
    principal_id: "user_local",
    allowed_scopes: [
      { kind: "workspace" as const, id: "workspace_local" },
    ],
    allowed_authorities: ["user_stated" as const],
    destructive_tools_enabled: false,
    recovery_head: recoveryHead,
  };
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("MCP recovery authority configuration", () => {
  it("opens a fresh absent data root with a disjoint external provider", async () => {
    const dataRoot = join(temporaryRoot("fresh-parent"), "data");
    const recovery = recoveryFixture(
      temporaryRoot("fresh-authority"),
    );
    expect(existsSync(dataRoot)).toBe(false);
    const opened = await openMemoryRuntime(
      serverConfig(dataRoot, recovery.config),
    );
    try {
      expect(existsSync(dataRoot)).toBe(true);
      expect((await opened.storage.health()).recovery.state).toBe(
        "ready",
      );
    } finally {
      await opened.close();
    }
  });

  it("rejects recovery state and key descriptors inside the data root", async () => {
    const dataRoot = temporaryRoot("contained-data");
    const external = recoveryFixture(
      temporaryRoot("contained-authority"),
    );
    const nestedAuthority = recoveryFixture(
      join(dataRoot, "..authority"),
    );
    await expect(
      openMemoryRuntime(
        serverConfig(dataRoot, nestedAuthority.config),
      ),
    ).rejects.toThrow(
      "recovery authority must be external to the data root",
    );

    const nestedPrivateKey = join(
      dataRoot,
      "backups",
      "snapshot-private.pem",
    );
    mkdirSync(join(dataRoot, "backups"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      nestedPrivateKey,
      readPrivateOperatorFile(external.privateKeyPath),
      { mode: 0o600 },
    );
    await expect(
      openMemoryRuntime(
        serverConfig(dataRoot, {
          ...external.config,
          private_key_path: nestedPrivateKey,
        }),
      ),
    ).rejects.toThrow(
      "recovery authority must be external to the data root",
    );
  });

  it("fails closed on symlink and open-to-read key replacement", () => {
    const root = temporaryRoot("key-race");
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const keyPath = join(root, "key.pem");
    const replacementPath = join(root, "replacement.pem");
    const movedPath = join(root, "opened-key.pem");
    writeFileSync(
      keyPath,
      first.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    writeFileSync(
      replacementPath,
      second.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      { mode: 0o600 },
    );

    expect(() =>
      readPrivateOperatorFile(keyPath, {
        afterOpen: () => {
          renameSync(keyPath, movedPath);
          symlinkSync(replacementPath, keyPath);
        },
      }),
    ).toThrow("trusted recovery key descriptor is invalid");
    expect(() => readPrivateOperatorFile(keyPath)).toThrow(
      "trusted recovery key descriptor is invalid",
    );
  });
});

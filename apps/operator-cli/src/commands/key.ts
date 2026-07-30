import {
  EncryptionKeyInventorySchema,
  canonicalJson,
  type EncryptionKeyInventory,
} from "@memo-graph/contracts";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import type { OperatorOutputFormat } from "../render.js";

export async function inspectKeys(
  dataRoot: string,
  dependencies?: {
    inspectStorage?: typeof SqliteStorageClient.inspect;
  },
): Promise<EncryptionKeyInventory> {
  const inspectStorage =
    dependencies?.inspectStorage ?? SqliteStorageClient.inspect;
  const storage = await inspectStorage({ dataRoot });
  try {
    return EncryptionKeyInventorySchema.parse(
      await storage.inspectEncryptionKeys(),
    );
  } finally {
    await storage.close();
  }
}

export function renderKeyInventory(
  inventoryInput: EncryptionKeyInventory,
  format: OperatorOutputFormat,
): string {
  const inventory = EncryptionKeyInventorySchema.parse(inventoryInput);
  if (format === "json") {
    return `${canonicalJson(inventory)}\n`;
  }
  const lines = [
    `current key: ${inventory.current_key_id ?? "none"}`,
    `rotating to: ${inventory.rotating_to_key_id ?? "none"}`,
    `rotation: ${inventory.rotation_id ?? "none"} state=${inventory.rotation_state ?? "none"}`,
    `encrypted content: ${inventory.encrypted_content_count}`,
  ];
  for (const key of inventory.keys) {
    lines.push(
      `key: ${key.key_id} generation=${key.generation} state=${key.state} authority=${key.authority_key_id} commitment=${key.commitment_key_id}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function keyRotationDryRun(): {
  operation: "key.rotate";
  status: "disabled";
  reason_code: "ENCRYPTION_REQUIRED";
} {
  return {
    operation: "key.rotate",
    status: "disabled",
    reason_code: "ENCRYPTION_REQUIRED",
  };
}

import {
  EncryptionKeyInventorySchema,
  KeyRotationDryRunResultSchema,
  OperationIntentSchema,
  canonicalSha256,
  canonicalJson,
  type EncryptionKeyInventory,
  type OperationIntent,
  type OperatorConfirmation,
  type OperatorConfirmationTrust,
} from "@memo-graph/contracts";
import {
  SqliteStorageClient,
  operatorKeyRotationParameters,
  type BeginKeyRotationInput,
  type ResumeKeyRotationInput,
} from "@memo-graph/storage-sqlite";

import type {
  OperatorActionLedger} from "../operator-action-ledger.js";
import {
  executeConfirmedOperatorAction,
} from "../operator-action-ledger.js";
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

export function keyRotationDryRun() {
  return KeyRotationDryRunResultSchema.parse({
    operation: "key.rotate",
    status: "disabled",
    reason_code: "ENCRYPTION_REQUIRED",
  });
}

export async function keyRotationStateBindings(
  storage: SqliteStorageClient,
) {
  const health = await storage.health();
  const inventory = await storage.inspectEncryptionKeys();
  return {
    inventory,
    bindings: {
      recovery_anchor_hash:
        OperationIntentSchema.shape.recovery_anchor_hash.parse(
          storage.recoveryHeadProvider.readCurrent()?.anchor_hash ?? null,
        ),
      configuration_digest:
        OperationIntentSchema.shape.configuration_digest.parse(
          canonicalSha256({
            schema_version: health.schema_version,
            migrations: health.migrations,
          }),
        ),
      key_state_digest:
        OperationIntentSchema.shape.key_state_digest.parse(
          canonicalSha256(inventory),
        ),
      expected_state_digest:
        OperationIntentSchema.shape.expected_state_digest.parse(
          canonicalSha256({
            ledger_epoch: health.ledger_epoch,
            tombstone_epoch: health.tombstone_epoch,
            learning_frontier: health.learning_frontier,
            projection_frontier: health.projection_frontier,
            encryption: health.encryption,
            recovery: health.recovery,
          }),
        ),
      expected_frontier_digest:
        OperationIntentSchema.shape.expected_frontier_digest.parse(
          canonicalSha256({
            ledger_epoch: health.ledger_epoch,
            tombstone_epoch: health.tombstone_epoch,
            learning_frontier: health.learning_frontier,
            projection_frontier: health.projection_frontier,
          }),
        ),
    } satisfies Pick<
      OperationIntent,
      | "recovery_anchor_hash"
      | "configuration_digest"
      | "key_state_digest"
      | "expected_state_digest"
      | "expected_frontier_digest"
    >,
  };
}

export function runConfirmedKeyRotation(input: {
  storage: SqliteStorageClient;
  begin: BeginKeyRotationInput;
  resume: Omit<ResumeKeyRotationInput, "rotation_id">;
  intent: OperationIntent;
  confirmation: OperatorConfirmation;
  trust: OperatorConfirmationTrust;
  now: string;
  ledger: OperatorActionLedger;
}) {
  const parameters = operatorKeyRotationParameters({
    begin: input.begin,
    resume: input.resume,
  });
  if (
    input.intent.command !== "key_rotate" ||
    input.intent.source_ref !== input.begin.rotation_id ||
    input.intent.target_ref !== input.begin.new_key_id ||
    input.intent.parameters_digest !== canonicalSha256(parameters)
  ) {
    throw new Error("key rotation intent binding is invalid");
  }
  const validateCurrentState = async () => {
    const current = await keyRotationStateBindings(input.storage);
    const exact = ([
      "recovery_anchor_hash",
      "configuration_digest",
      "key_state_digest",
      "expected_state_digest",
      "expected_frontier_digest",
    ] as const).every(
      (key) => current.bindings[key] === input.intent[key],
    );
    const ownedResume =
      current.inventory.rotation_id === input.begin.rotation_id &&
      current.inventory.rotating_to_key_id === input.begin.new_key_id &&
      current.inventory.rotation_state === "in_progress" &&
      current.bindings.configuration_digest ===
        input.intent.configuration_digest &&
      current.bindings.expected_frontier_digest ===
        input.intent.expected_frontier_digest;
    if (!exact && !ownedResume) {
      throw new Error("key rotation state binding changed");
    }
  };
  const completedResult = async () => {
    const inventory = await input.storage.inspectEncryptionKeys();
    if (
      inventory.rotation_id !== input.begin.rotation_id ||
      inventory.rotation_state !== "completed" ||
      inventory.current_key_id !== input.begin.new_key_id
    ) {
      return null;
    }
    return {
      status: "completed",
      rotation_id: input.begin.rotation_id,
      current_key_id: input.begin.new_key_id,
      key_generation: input.begin.new_key_generation,
      remaining_items: 0,
    };
  };
  return executeConfirmedOperatorAction({
    intent: input.intent,
    confirmation: input.confirmation,
    trust: input.trust,
    now: input.now,
    ledger: input.ledger,
    validateCurrentState,
    prepareEffectDigest: () => canonicalSha256(parameters),
    reconcileEffect: completedResult,
    effect: async () => {
      const rotationCapability =
        await input.storage.authorizeOperatorKeyRotation({
          intent: input.intent,
          confirmation: input.confirmation,
          trust: input.trust,
          now: input.now,
          begin: input.begin,
          resume: input.resume,
        });
      const inventory = await input.storage.inspectEncryptionKeys();
      if (inventory.rotation_id === null) {
        await rotationCapability.begin();
      } else if (
        inventory.rotation_id !== input.begin.rotation_id ||
        inventory.rotating_to_key_id !== input.begin.new_key_id
      ) {
        throw new Error("key rotation durable state conflicts");
      }
      let progress = await rotationCapability.resume();
      while (progress.state === "in_progress") {
        progress = await rotationCapability.resume();
      }
      return {
        status: progress.state,
        rotation_id: progress.rotation_id,
        current_key_id: input.begin.new_key_id,
        key_generation: input.begin.new_key_generation,
        remaining_items:
          progress.total_items - progress.rewritten_items,
      };
    },
    recordReceipt: (receipt) =>
      input.storage.appendOperatorActionReceipt(receipt),
  });
}

import {
  LearningStopReceiptSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
  type Scope,
} from "@memo-graph/contracts";

import type { LearningLabStorage } from "./storage-port.js";

export async function persistLearningStop(options: {
  storage: LearningLabStorage;
  idempotencyKey: string;
  idempotencyHash: `sha256:${string}`;
  principalId: string;
  scopes: readonly Scope[];
  controlEpoch: number;
  reasonCode: string;
  createdAt: string;
  requestIdentity: unknown;
}): Promise<{
  receipt: ReturnType<typeof LearningStopReceiptSchema.parse>;
  replayed: boolean;
}> {
  const requestHash = canonicalSha256(options.requestIdentity);
  const receipt = LearningStopReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: `learning-stop:${canonicalSha256({
        idempotency_key: options.idempotencyKey,
        principal_id: options.principalId,
        reason_code: options.reasonCode,
      }).slice("sha256:".length, 48)}`,
      created_at: options.createdAt,
      state: "durable",
      request_hash: requestHash,
      kind: "learning_stop",
      principal_id: options.principalId,
      trace_id: null,
      candidate_id: null,
      control_epoch: options.controlEpoch,
      reason_code: options.reasonCode,
    }),
  );
  const command = {
    kind: "stop" as const,
    idempotency_key: options.idempotencyKey,
    idempotency_hash: options.idempotencyHash,
    principal_id: options.principalId,
    scopes: [...options.scopes],
    receipt,
  };
  const result = await options.storage.writeLearningLedger({
    ...command,
    request_hash: canonicalSha256Omitting(command, ["request_hash"]),
  });
  return {
    receipt: LearningStopReceiptSchema.parse(result.receipt),
    replayed: result.replayed,
  };
}

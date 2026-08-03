import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  ContentFreeOperatorResultSchema,
  OperationIntentSchema,
  OperatorActionReceiptSchema,
  OperatorActionStateSchema,
  OperatorConfirmationSchema,
  canonicalJson,
  canonicalSha256,
  type OperationIntent,
  type OperatorActionReceipt,
  type OperatorActionState,
  type OperatorConfirmation,
  type OperatorConfirmationTrust,
  type ContentFreeOperatorResult,
} from "@memo-graph/contracts";
import { z } from "zod";

import { verifyPinnedOperatorConfirmation } from "./confirmation-authority.js";

const MAX_LEDGER_RECORD_BYTES = 256 * 1024;
const OperatorActionLockSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    operation_id: z.string().trim().min(1),
    process_id: z.number().int().positive(),
    acquired_at: z.string().datetime({ offset: true }),
  })
  .strict();
const ConfirmationConsumptionSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    confirmation_id: z.string().trim().min(1),
    operation_id: z.string().trim().min(1),
    intent_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    confirmation_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    authorized_at: z.string().datetime({ offset: true }),
    record_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.record_hash !==
      canonicalSha256({
        schema_version: value.schema_version,
        confirmation_id: value.confirmation_id,
        operation_id: value.operation_id,
        intent_hash: value.intent_hash,
        confirmation_hash: value.confirmation_hash,
        authorized_at: value.authorized_at,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["record_hash"],
        message: "confirmation consumption hash mismatch",
      });
    }
  });
const OperatorActionLedgerRecordSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    operation_id: z.string().trim().min(1),
    command: z.string().trim().min(1),
    intent_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    confirmation_id: z.string().trim().min(1),
    state: OperatorActionStateSchema,
    sequence: z.number().int().min(1).max(5),
    effect_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    result: ContentFreeOperatorResultSchema.nullable(),
    result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    receipt: OperatorActionReceiptSchema.nullable(),
    updated_at: z.string().datetime({ offset: true }),
    record_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    const states = OperatorActionStateSchema.options;
    if (states[value.sequence - 1] !== value.state) {
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "operator action state sequence mismatch",
      });
    }
    if (value.record_hash !== canonicalSha256(ledgerRecordBody(value))) {
      context.addIssue({
        code: "custom",
        path: ["record_hash"],
        message: "operator action ledger record hash mismatch",
      });
    }
    const hasEffect = value.sequence >= 2;
    const hasResult = value.sequence >= 3;
    const hasReceipt = value.sequence >= 4;
    if (
      (value.effect_digest !== null) !== hasEffect ||
      (value.result !== null) !== hasResult ||
      (value.result_digest !== null) !== hasResult ||
      (value.receipt !== null) !== hasReceipt
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "operator action ledger payload does not match state",
      });
    }
  });

export type OperatorActionLedgerRecord = z.infer<
  typeof OperatorActionLedgerRecordSchema
>;
export type { ContentFreeOperatorResult };

function ledgerRecordBody(
  value: Omit<OperatorActionLedgerRecord, "record_hash">,
) {
  return {
    schema_version: value.schema_version,
    operation_id: value.operation_id,
    command: value.command,
    intent_hash: value.intent_hash,
    confirmation_id: value.confirmation_id,
    state: value.state,
    sequence: value.sequence,
    effect_digest: value.effect_digest,
    result: value.result,
    result_digest: value.result_digest,
    receipt: value.receipt,
    updated_at: value.updated_at,
  };
}

function assertPrivateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  const expectedOwner = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (expectedOwner !== undefined && stat.uid !== expectedOwner)
  ) {
    throw new Error("operator action ledger is invalid");
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readPrivateRegularFile(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    const expectedOwner = process.getuid?.();
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > MAX_LEDGER_RECORD_BYTES ||
      (before.mode & 0o077) !== 0 ||
      (expectedOwner !== undefined && before.uid !== expectedOwner)
    ) {
      throw new Error("operator action ledger is invalid");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) {
        throw new Error("operator action ledger is invalid");
      }
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("operator action ledger is invalid");
    }
    return bytes.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function recordPath(directory: string, operationId: string): string {
  const safe = OperationIntentSchema.shape.operation_id.parse(operationId);
  return join(directory, `${safe}.json`);
}

function confirmationPath(
  directory: string,
  confirmationId: string,
): string {
  const safe =
    OperatorConfirmationSchema.shape.confirmation_id.parse(
      confirmationId,
    );
  return join(directory, `confirmation.${safe}.json`);
}

export class OperatorActionLedger {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
    if (!existsSync(this.#directory)) {
      mkdirSync(this.#directory, { mode: 0o700, recursive: true });
      chmodSync(this.#directory, 0o700);
      fsyncPath(this.#directory);
    }
    assertPrivateDirectory(this.#directory);
  }

  read(operationId: string): OperatorActionLedgerRecord | null {
    const path = recordPath(this.#directory, operationId);
    if (!existsSync(path)) {
      return null;
    }
    return OperatorActionLedgerRecordSchema.parse(
      JSON.parse(readPrivateRegularFile(path)) as unknown,
    );
  }

  readConfirmation(confirmationId: string) {
    const path = confirmationPath(this.#directory, confirmationId);
    if (!existsSync(path)) {
      return null;
    }
    return ConfirmationConsumptionSchema.parse(
      JSON.parse(readPrivateRegularFile(path)) as unknown,
    );
  }

  withConfirmationLock<T>(
    confirmationId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const safe =
      OperatorConfirmationSchema.shape.confirmation_id.parse(
        confirmationId,
      );
    const lockPath = join(
      this.#directory,
      `confirmation.${safe}.lock`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${canonicalJson({
          schema_version: "1.0.0",
          operation_id: `confirmation:${safe}`,
          process_id: process.pid,
          acquired_at: new Date().toISOString(),
        })}\n`,
      );
      fsyncSync(descriptor);
      this.#removeConfirmationTemporaryFile(safe);
    } catch {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
          fsyncPath(this.#directory);
        } catch {
          // A partial lock remains fail-closed for explicit recovery.
        }
      }
      throw new Error("operator confirmation is already in progress");
    }
    const acquiredDescriptor = descriptor;
    return callback().finally(() => {
      closeSync(acquiredDescriptor);
      unlinkSync(lockPath);
      fsyncPath(this.#directory);
    });
  }

  bindConfirmation(input: {
    confirmation: OperatorConfirmation;
    operationId: string;
    intentHash: string;
    authorizedAt: string;
  }) {
    const body = {
      schema_version: "1.0.0" as const,
      confirmation_id: input.confirmation.confirmation_id,
      operation_id:
        OperationIntentSchema.shape.operation_id.parse(
          input.operationId,
        ),
      intent_hash: input.intentHash,
      confirmation_hash: canonicalSha256(input.confirmation),
      authorized_at: input.authorizedAt,
    };
    const record = ConfirmationConsumptionSchema.parse({
      ...body,
      record_hash: canonicalSha256(body),
    });
    const path = confirmationPath(
      this.#directory,
      record.confirmation_id,
    );
    const temporary = join(
      this.#directory,
      `.confirmation.${record.confirmation_id}.tmp`,
    );
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${canonicalJson(record)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    fsyncPath(this.#directory);
    return record;
  }

  withLock<T>(operationId: string, callback: () => Promise<T>): Promise<T> {
    const lockPath = join(
      this.#directory,
      `${OperationIntentSchema.shape.operation_id.parse(operationId)}.lock`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${canonicalJson({
          schema_version: "1.0.0",
          operation_id: operationId,
          process_id: process.pid,
          acquired_at: new Date().toISOString(),
        })}\n`,
      );
      fsyncSync(descriptor);
      this.#removeOperationTemporaryFiles(operationId);
    } catch {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
          fsyncPath(this.#directory);
        } catch {
          // A partially initialized lock remains fail-closed for explicit
          // operator recovery if cleanup itself cannot be completed.
        }
      }
      throw new Error("operator action is already in progress");
    }
    const acquiredDescriptor = descriptor;
    return callback().finally(() => {
      closeSync(acquiredDescriptor);
      unlinkSync(lockPath);
      fsyncPath(this.#directory);
    });
  }

  recoverStaleLock(input: {
    operationId: string;
    expectedProcessId: number;
    ownerNotLive: (processId: number) => boolean;
    now: string;
    minimumAgeMs: number;
  }): void {
    const operationId = OperationIntentSchema.shape.operation_id.parse(
      input.operationId,
    );
    const lockPath = join(this.#directory, `${operationId}.lock`);
    if (!existsSync(lockPath)) {
      return;
    }
    const lock = OperatorActionLockSchema.parse(
      JSON.parse(readPrivateRegularFile(lockPath)) as unknown,
    );
    if (
      lock.operation_id !== operationId ||
      lock.process_id !== input.expectedProcessId ||
      !Number.isFinite(input.minimumAgeMs) ||
      input.minimumAgeMs <= 0 ||
      Date.parse(input.now) - Date.parse(lock.acquired_at) <
        input.minimumAgeMs ||
      !input.ownerNotLive(lock.process_id)
    ) {
      throw new Error("operator action lock recovery is invalid");
    }
    this.#removeOperationTemporaryFiles(operationId);
    unlinkSync(lockPath);
    fsyncPath(this.#directory);
  }

  recoverStaleConfirmationLock(input: {
    confirmationId: string;
    expectedProcessId: number;
    ownerNotLive: (processId: number) => boolean;
    now: string;
    minimumAgeMs: number;
  }): void {
    const confirmationId =
      OperatorConfirmationSchema.shape.confirmation_id.parse(
        input.confirmationId,
      );
    const lockPath = join(
      this.#directory,
      `confirmation.${confirmationId}.lock`,
    );
    if (!existsSync(lockPath)) {
      return;
    }
    const lock = OperatorActionLockSchema.parse(
      JSON.parse(readPrivateRegularFile(lockPath)) as unknown,
    );
    if (
      lock.operation_id !== `confirmation:${confirmationId}` ||
      lock.process_id !== input.expectedProcessId ||
      !Number.isFinite(input.minimumAgeMs) ||
      input.minimumAgeMs <= 0 ||
      Date.parse(input.now) - Date.parse(lock.acquired_at) <
        input.minimumAgeMs ||
      !input.ownerNotLive(lock.process_id)
    ) {
      throw new Error(
        "operator confirmation lock recovery is invalid",
      );
    }
    this.#removeConfirmationTemporaryFile(confirmationId);
    unlinkSync(lockPath);
    fsyncPath(this.#directory);
  }

  write(
    record: Omit<OperatorActionLedgerRecord, "record_hash">,
  ): OperatorActionLedgerRecord {
    const body = ledgerRecordBody(record);
    const sealed = OperatorActionLedgerRecordSchema.parse({
      ...body,
      record_hash: canonicalSha256(body),
    });
    const path = recordPath(this.#directory, sealed.operation_id);
    const temporary = join(
      this.#directory,
      `.${sealed.operation_id}.${sealed.sequence}.tmp`,
    );
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${canonicalJson(sealed)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    fsyncPath(this.#directory);
    return sealed;
  }

  #removePrivateTemporaryFile(path: string): void {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      const expectedOwner = process.getuid?.();
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        (expectedOwner !== undefined && stat.uid !== expectedOwner)
      ) {
        throw new Error("operator action ledger is invalid");
      }
      unlinkSync(path);
    }
    fsyncPath(this.#directory);
  }

  #removeOperationTemporaryFiles(operationId: string): void {
    const safe =
      OperationIntentSchema.shape.operation_id.parse(operationId);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      this.#removePrivateTemporaryFile(
        join(this.#directory, `.${safe}.${sequence}.tmp`),
      );
    }
  }

  #removeConfirmationTemporaryFile(confirmationId: string): void {
    const safe =
      OperatorConfirmationSchema.shape.confirmation_id.parse(
        confirmationId,
      );
    this.#removePrivateTemporaryFile(
      join(this.#directory, `.confirmation.${safe}.tmp`),
    );
  }
}

function nextRecord(input: {
  previous: OperatorActionLedgerRecord;
  state: OperatorActionState;
  now: string;
  effectDigest?: `sha256:${string}`;
  result?: ContentFreeOperatorResult;
  receipt?: OperatorActionReceipt;
}): OperatorActionLedgerRecord {
  const sequence = OperatorActionStateSchema.options.indexOf(input.state) + 1;
  if (sequence !== input.previous.sequence + 1) {
    throw new Error("operator action transition is invalid");
  }
  const result =
    input.result === undefined
      ? input.previous.result
      : ContentFreeOperatorResultSchema.parse(input.result);
  return {
    ...input.previous,
    state: input.state,
    sequence,
    effect_digest:
      input.effectDigest ?? input.previous.effect_digest,
    result,
    result_digest:
      result === null ? null : canonicalSha256(result),
    receipt: input.receipt ?? input.previous.receipt,
    updated_at: input.now,
    record_hash: canonicalSha256(ledgerRecordBody({
      schema_version: input.previous.schema_version,
      operation_id: input.previous.operation_id,
      command: input.previous.command,
      intent_hash: input.previous.intent_hash,
      confirmation_id: input.previous.confirmation_id,
      state: input.state,
      sequence,
      effect_digest:
        input.effectDigest ?? input.previous.effect_digest,
      result,
      result_digest:
        result === null ? null : canonicalSha256(result),
      receipt: input.receipt ?? input.previous.receipt,
      updated_at: input.now,
    })),
  };
}

function injectFault(
  requested: OperatorActionFaultPoint | undefined,
  observed: OperatorActionFaultPoint,
): void {
  if (requested === observed) {
    throw new Error("injected operator action fault");
  }
}

type OperatorActionFaultPoint = OperatorActionState | "external_effect";

export async function executeConfirmedOperatorAction(input: {
  intent: OperationIntent;
  confirmation: OperatorConfirmation;
  trust: OperatorConfirmationTrust;
  now: string;
  ledger: OperatorActionLedger;
  validateCurrentState: () => void | Promise<void>;
  prepareEffectDigest: () => `sha256:${string}`;
  reconcileEffect: () => Promise<ContentFreeOperatorResult | null>;
  effect: () => Promise<ContentFreeOperatorResult>;
  recordReceipt: (
    receipt: OperatorActionReceipt,
  ) => Promise<unknown>;
  testFaultAfter?: OperatorActionFaultPoint;
}): Promise<ContentFreeOperatorResult> {
  const intent = OperationIntentSchema.parse(input.intent);
  const confirmation = OperatorConfirmationSchema.parse(input.confirmation);
  return input.ledger.withConfirmationLock(
    confirmation.confirmation_id,
    () => input.ledger.withLock(intent.operation_id, async () => {
    const consumed = input.ledger.readConfirmation(
      confirmation.confirmation_id,
    );
    const existing = input.ledger.read(intent.operation_id);
    if (
      existing !== null &&
      (existing.intent_hash !== intent.intent_hash ||
        existing.confirmation_id !== confirmation.confirmation_id)
    ) {
      throw new Error("operator action replay is invalid");
    }
    if (
      consumed !== null &&
      (consumed.operation_id !== intent.operation_id ||
        consumed.intent_hash !== intent.intent_hash ||
        consumed.confirmation_hash !== canonicalSha256(confirmation))
    ) {
      throw new Error("operator confirmation replay is invalid");
    }
    if (consumed === null && existing !== null) {
      throw new Error("operator confirmation consumption is absent");
    }
    verifyPinnedOperatorConfirmation({
      intent,
      confirmation,
      trust: input.trust,
      now:
        consumed === null
          ? input.now
          : confirmation.issued_at,
    });
    const verifyUnexpiredConfirmation = () =>
      verifyPinnedOperatorConfirmation({
        intent,
        confirmation,
        trust: input.trust,
        now: input.now,
      });
    if (consumed !== null && existing === null) {
      verifyUnexpiredConfirmation();
    }
    if (consumed === null) {
      input.ledger.bindConfirmation({
        confirmation,
        operationId: intent.operation_id,
        intentHash: intent.intent_hash,
        authorizedAt: input.now,
      });
    }
    let record =
      existing ??
      input.ledger.write({
        schema_version: "1.0.0",
        operation_id: intent.operation_id,
        command: intent.command,
        intent_hash: intent.intent_hash,
        confirmation_id: confirmation.confirmation_id,
        state: "authorized",
        sequence: 1,
        effect_digest: null,
        result: null,
        result_digest: null,
        receipt: null,
        updated_at: input.now,
      });
    if (existing === null) {
      injectFault(input.testFaultAfter, "authorized");
    }
    if (record.state === "authorized") {
      verifyUnexpiredConfirmation();
      await input.validateCurrentState();
      record = input.ledger.write(
        nextRecord({
          previous: record,
          state: "effect_prepared",
          now: input.now,
          effectDigest: input.prepareEffectDigest(),
        }),
      );
      injectFault(input.testFaultAfter, "effect_prepared");
    }
    if (record.state === "effect_prepared") {
      const reconciled = await input.reconcileEffect();
      if (reconciled === null) {
        verifyUnexpiredConfirmation();
        await input.validateCurrentState();
      }
      const result = ContentFreeOperatorResultSchema.parse(
        reconciled ?? (await input.effect()),
      );
      if (reconciled === null) {
        injectFault(input.testFaultAfter, "external_effect");
      }
      record = input.ledger.write(
        nextRecord({
          previous: record,
          state: "effect_committed",
          now: input.now,
          result,
        }),
      );
      injectFault(input.testFaultAfter, "effect_committed");
    }
    if (record.state === "effect_committed") {
      const result = ContentFreeOperatorResultSchema.parse(record.result);
      const receiptBody = {
        schema_version: "1.0.0" as const,
        receipt_id: `operator_receipt_${canonicalSha256({
          operation_id: intent.operation_id,
          intent_hash: intent.intent_hash,
        }).slice("sha256:".length, "sha256:".length + 40)}`,
        operation_id: intent.operation_id,
        command: intent.command,
        intent_hash: intent.intent_hash,
        confirmation_id: confirmation.confirmation_id,
        confirmation_key_id: confirmation.authority_key_id,
        confirmation_key_generation:
          confirmation.authority_key_generation,
        state: "receipt_committed" as const,
        effect_digest:
          record.effect_digest ??
          (() => {
            throw new Error("operator action effect digest is absent");
          })(),
        result_digest: canonicalSha256(result),
        created_at: intent.issued_at,
        completed_at: input.now,
      };
      const receipt = OperatorActionReceiptSchema.parse({
        ...receiptBody,
        receipt_hash: canonicalSha256(receiptBody),
      });
      await input.recordReceipt(receipt);
      record = input.ledger.write(
        nextRecord({
          previous: record,
          state: "receipt_committed",
          now: input.now,
          receipt,
        }),
      );
      injectFault(input.testFaultAfter, "receipt_committed");
    }
    if (record.state === "receipt_committed") {
      record = input.ledger.write(
        nextRecord({
          previous: record,
          state: "responded",
          now: input.now,
        }),
      );
      injectFault(input.testFaultAfter, "responded");
    }
    if (record.result === null) {
      throw new Error("operator action result is absent");
    }
    return record.result;
    }),
  );
}

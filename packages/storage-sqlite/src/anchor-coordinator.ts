import {
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  CanonicalHashSchema,
  IdentifierSchema,
  RecoveryAnchorSchema,
  RecoveryMinimumsSchema,
  RecoveryPendingReservationSchema,
  UtcTimestampSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  verifyRecoveryAnchor,
  type CompleteBackupManifest,
  type CanonicalHash,
  type RecoveryAnchor,
  type RecoveryMinimums,
  type RecoveryPendingAuthorization,
  type RecoveryPendingReservation,
} from "@memo-graph/contracts";
import { z } from "zod";

import { StorageError } from "./errors.js";

const RECOVERY_HEAD_LOCK_DOMAIN = "memo-graph/recovery-head-lock/v1";
const RECOVERY_TERMINAL_RECORD_DOMAIN =
  "memo-graph/recovery-terminal-record/v1";
const RECOVERY_TERMINAL_INDEX_DOMAIN =
  "memo-graph/recovery-terminal-index/v1";
const MAX_RECOVERY_HEAD_LOCK_BYTES = 4_096;
const MAX_RECOVERY_TERMINAL_BYTES = 65_536;
const MAX_ACTIVE_RECOVERY_RESERVATIONS = 64;
const MAX_RECOVERY_PROVIDER_STATE_BYTES = 1_048_576;
const MAX_RECOVERY_PROVIDER_JOURNAL_RECORD_BYTES = 1_310_720;
const MAX_RECOVERY_PROVIDER_JOURNAL_BYTES =
  MAX_RECOVERY_PROVIDER_JOURNAL_RECORD_BYTES * 65;

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function assertPrivateDirectory(path: string): void {
  try {
    const resolved = resolve(path);
    const stat = lstatSync(resolved);
    const expectedOwner = process.getuid?.();
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(resolved) !== resolved ||
      (stat.mode & 0o077) !== 0 ||
      (expectedOwner !== undefined && stat.uid !== expectedOwner)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  } catch {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  }
}

function readPrivateRegularFile(
  path: string,
  maximumBytes?: number,
): string {
  const resolved = resolve(path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    const pathStat = lstatSync(resolved);
    const expectedOwner = process.getuid?.();
    if (
      !stat.isFile() ||
      pathStat.isSymbolicLink() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino ||
      realpathSync(resolved) !== resolved ||
      (maximumBytes !== undefined &&
        (stat.size <= 0 || stat.size > maximumBytes)) ||
      (stat.mode & 0o077) !== 0 ||
      (expectedOwner !== undefined && stat.uid !== expectedOwner)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const raw = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(resolved);
    if (
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return raw;
  } catch {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

const RecoveryHeadLockPayloadSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    lock_id: IdentifierSchema,
    provider_ref: z.string().regex(/^provider:[0-9]+:[0-9]+$/),
    process_id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    acquired_at: UtcTimestampSchema,
  })
  .strict();

const RecoveryHeadLockRecordSchema = z
  .object({
    payload: RecoveryHeadLockPayloadSchema,
    authority_key_id: IdentifierSchema,
    trust_root_version: z.number().int().positive(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    record_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.record_hash !==
      canonicalSha256({
        payload: value.payload,
        authority_key_id: value.authority_key_id,
        trust_root_version: value.trust_root_version,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["record_hash"],
        message: "recovery head lock record hash mismatch",
      });
    }
  });

type RecoveryHeadLockRecord = z.infer<
  typeof RecoveryHeadLockRecordSchema
>;

type ObservedRecoveryHeadLock = {
  record: RecoveryHeadLockRecord;
  raw: string;
  dev: number;
  ino: number;
};

const SignedPendingSchema = z
  .object({
    reservation: RecoveryPendingReservationSchema,
    authority_key_id: z.string().trim().min(1).max(200),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    record_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

type SignedPending = z.infer<typeof SignedPendingSchema>;

const RecoveryTerminalFrontierSchema = z
  .object({
    record_count: z.number().int().nonnegative(),
    head_record_hash: CanonicalHashSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.record_count === 0) !==
      (value.head_record_hash === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["head_record_hash"],
        message: "terminal replay frontier count/head mismatch",
      });
    }
  });

const ZERO_TERMINAL_FRONTIER = RecoveryTerminalFrontierSchema.parse({
  record_count: 0,
  head_record_hash: null,
});

const RecoveryTerminalRecordSchema = z
  .object({
    payload: z
      .object({
        schema_version: z.literal("1.0.0"),
        sequence: z.number().int().positive(),
        previous_record_hash: CanonicalHashSchema.nullable(),
        lookup_hash: CanonicalHashSchema,
        pending: SignedPendingSchema,
      })
      .strict(),
    authority_key_id: IdentifierSchema,
    trust_root_version: z.number().int().positive(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    record_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const unsigned = {
      payload: value.payload,
      authority_key_id: value.authority_key_id,
      trust_root_version: value.trust_root_version,
    };
    if (
      value.payload.pending.reservation.state !== "reconciled" ||
      value.payload.lookup_hash !==
        canonicalSha256({
          domain: RECOVERY_TERMINAL_INDEX_DOMAIN,
          idempotency_key:
            value.payload.pending.reservation.idempotency_key,
        }) ||
      (value.payload.sequence === 1) !==
        (value.payload.previous_record_hash === null) ||
      value.record_hash !== canonicalSha256(unsigned)
    ) {
      context.addIssue({
        code: "custom",
        path: ["record_hash"],
        message: "terminal replay record binding mismatch",
      });
    }
  });

const RecoveryTerminalIndexSchema = z
  .object({
    payload: z
      .object({
        schema_version: z.literal("1.0.0"),
        lookup_hash: CanonicalHashSchema,
        record_hash: CanonicalHashSchema,
        sequence: z.number().int().positive(),
        previous_record_hash: CanonicalHashSchema.nullable(),
      })
      .strict(),
    authority_key_id: IdentifierSchema,
    trust_root_version: z.number().int().positive(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    index_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.payload.sequence === 1) !==
        (value.payload.previous_record_hash === null) ||
      value.index_hash !==
      canonicalSha256({
        payload: value.payload,
        authority_key_id: value.authority_key_id,
        trust_root_version: value.trust_root_version,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["index_hash"],
        message: "terminal replay index binding mismatch",
      });
    }
  });

type RecoveryTerminalFrontier = z.infer<
  typeof RecoveryTerminalFrontierSchema
>;
type RecoveryTerminalRecord = z.infer<
  typeof RecoveryTerminalRecordSchema
>;
type RecoveryTerminalIndex = z.infer<
  typeof RecoveryTerminalIndexSchema
>;
type RecoveryTerminalLookup = {
  record: RecoveryTerminalRecord;
  index: RecoveryTerminalIndex;
};

const ProviderStateSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    authority_key_id: z.string().trim().min(1).max(200),
    trust_root_version: z.number().int().positive(),
    current: RecoveryAnchorSchema.nullable(),
    pending: z.array(SignedPendingSchema),
    terminal_frontier: RecoveryTerminalFrontierSchema.optional(),
    state_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state_hash !== canonicalSha256Omitting(value, ["state_hash"])) {
      context.addIssue({
        code: "custom",
        path: ["state_hash"],
        message: "recovery provider state hash mismatch",
      });
    }
    const pendingIds = value.pending.map(
      ({ reservation }) => reservation.pending_id,
    );
    const idempotencyKeys = value.pending.map(
      ({ reservation }) => reservation.idempotency_key,
    );
    if (new Set(pendingIds).size !== pendingIds.length) {
      context.addIssue({
        code: "custom",
        path: ["pending"],
        message: "recovery pending identities must be unique",
      });
    }
    if (new Set(idempotencyKeys).size !== idempotencyKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["pending"],
        message:
          "recovery reservation idempotency identities must be unique",
      });
    }
  });

type ProviderState = z.infer<typeof ProviderStateSchema>;

export type RecoveryHeadProvider = {
  readonly authorityKeyId: string;
  readonly trustRootVersion: number;
  readonly publicKey: KeyObject;
  readCurrent(): RecoveryAnchor | null;
  unresolvedPending(): readonly RecoveryPendingReservation[];
  bootstrap(input: {
    root_id: string;
    principal_id: string;
    minimums: RecoveryMinimums;
    state_commitment_hash: CanonicalHash;
    issued_at?: string;
  }): RecoveryAnchor;
  issueBackupAnchor(input: {
    manifest: CompleteBackupManifest;
    minimums: RecoveryMinimums;
  }): RecoveryAnchor;
  reserve(input: {
    operation: RecoveryPendingReservation["operation"];
    idempotency_key: string;
    request_hash: CanonicalHash;
    prior_minimums: RecoveryMinimums;
    prior_state_commitment_hash: CanonicalHash;
    reserved_at?: string;
  }): RecoveryPendingAuthorization;
  commit(input: {
    pending_id: string;
    backup_manifest_hash: CanonicalHash | null;
    state_commitment_hash: CanonicalHash;
    root_id: string;
    principal_id: string;
    committed_minimums: RecoveryMinimums;
    committed_at?: string;
  }): RecoveryAnchor;
  reconcile(pendingId: string): void;
  abort(input: {
    pending_id: string;
    effect_provably_absent: true;
  }): void;
};

function signedPending(
  reservation: RecoveryPendingReservation,
  authorityKeyId: string,
  privateKey: KeyObject,
): SignedPending {
  const recordWithoutHash = {
    reservation,
    authority_key_id: authorityKeyId,
  };
  return SignedPendingSchema.parse({
    ...recordWithoutHash,
    signature: sign(
      null,
      Buffer.from(canonicalJson(reservation), "utf8"),
      privateKey,
    ).toString("base64url"),
    record_hash: canonicalSha256(recordWithoutHash),
  });
}

function verifyPending(
  pending: SignedPending,
  authorityKeyId: string,
  publicKey: KeyObject,
): RecoveryPendingReservation {
  const parsed = SignedPendingSchema.parse(pending);
  if (
    parsed.authority_key_id !== authorityKeyId ||
    parsed.record_hash !==
      canonicalSha256({
        reservation: parsed.reservation,
        authority_key_id: parsed.authority_key_id,
      }) ||
    !verify(
      null,
      Buffer.from(canonicalJson(parsed.reservation), "utf8"),
      publicKey,
      Buffer.from(parsed.signature, "base64url"),
    )
  ) {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  }
  return parsed.reservation;
}

function sealState(
  value: Omit<ProviderState, "state_hash"> | ProviderState,
): ProviderState {
  const body = { ...value } as Partial<ProviderState>;
  delete body.state_hash;
  return ProviderStateSchema.parse({
    ...body,
    state_hash: canonicalSha256(body),
  });
}

function terminalFrontier(
  state: ProviderState,
): RecoveryTerminalFrontier {
  return RecoveryTerminalFrontierSchema.parse(
    state.terminal_frontier ?? ZERO_TERMINAL_FRONTIER,
  );
}

function minimumsFromManifest(
  manifest: CompleteBackupManifest,
): RecoveryMinimums {
  return RecoveryMinimumsSchema.parse({
    ledger_epoch: manifest.frontiers.ledger_epoch,
    latest_receipt_hash: manifest.frontiers.latest_receipt_hash,
    tombstone_epoch: manifest.frontiers.tombstone_epoch,
    purge_frontier_hash: manifest.frontiers.purge_frontier_hash,
    projection_frontier_hash: canonicalSha256({
      fts: manifest.frontiers.fts_logical_frontier_hash,
      layered: manifest.frontiers.layered_frontier_hash,
      relation: manifest.frontiers.relation_frontier_hash,
    }),
    context_frontier_hash: manifest.frontiers.context_frontier_hash,
    learning_control_epoch: manifest.frontiers.learning_control_epoch,
    learning_release_revision:
      manifest.frontiers.learning_release_revision,
    learning_frontier_hash: manifest.frontiers.learning_frontier_hash,
    required_keys: manifest.encryption.required_keys,
    encryption_frontier_hash:
      manifest.frontiers.encryption_frontier_hash,
    key_live_ciphertexts:
      manifest.encryption.key_live_ciphertexts,
    g6_release_control_hash: manifest.frontiers.g6_release_control_hash,
  });
}

export function recoveryStateCommitment(input: {
  root_id: string;
  principal_id: string;
  minimums: RecoveryMinimums;
}): CanonicalHash {
  return CanonicalHashSchema.parse(canonicalSha256({
    root_id: input.root_id,
    principal_id: input.principal_id,
    minimums: RecoveryMinimumsSchema.parse(input.minimums),
  }));
}

function assertMonotonicMinimums(
  previous: RecoveryMinimums | null,
  next: RecoveryMinimums,
  operation?: RecoveryPendingReservation["operation"],
): void {
  if (previous === null) {
    return;
  }
  const monotonicPairs = [
    [previous.ledger_epoch, next.ledger_epoch],
    [previous.tombstone_epoch, next.tombstone_epoch],
    [previous.learning_control_epoch, next.learning_control_epoch],
    [
      previous.learning_release_revision,
      next.learning_release_revision,
    ],
  ] as const;
  if (monotonicPairs.some(([before, after]) => after < before)) {
    throw new StorageError("STALE_RECOVERY_HEAD");
  }
  if (
    (next.ledger_epoch === previous.ledger_epoch &&
      next.latest_receipt_hash !== previous.latest_receipt_hash) ||
    (next.tombstone_epoch === previous.tombstone_epoch &&
      operation !== "purge" &&
      next.purge_frontier_hash !== previous.purge_frontier_hash) ||
    (next.learning_control_epoch === previous.learning_control_epoch &&
      next.learning_release_revision ===
        previous.learning_release_revision &&
      operation !== "learning" &&
      next.learning_frontier_hash !== previous.learning_frontier_hash)
  ) {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  }
  const nextKeys = new Map(
    next.required_keys.map((key) => [key.key_id, key]),
  );
  const nextLiveCiphertexts = new Map(
    next.key_live_ciphertexts.map((key) => [
      key.key_id,
      key.live_ciphertext_count,
    ]),
  );
  for (const priorKey of previous.required_keys) {
    const nextKey = nextKeys.get(priorKey.key_id);
    if (nextKey === undefined) {
      if (
        (operation !== "purge" && operation !== "key") ||
        next.encryption_frontier_hash ===
          previous.encryption_frontier_hash ||
        nextLiveCiphertexts.get(priorKey.key_id) !== 0
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      continue;
    }
    if (nextKey.key_generation !== priorKey.key_generation) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }
}

abstract class BaseRecoveryHeadProvider implements RecoveryHeadProvider {
  readonly authorityKeyId: string;
  readonly trustRootVersion: number;
  readonly publicKey: KeyObject;
  readonly #privateKey: KeyObject;

  protected constructor(input: {
    authorityKeyId: string;
    trustRootVersion: number;
    privateKey: KeyObject;
    publicKey?: KeyObject;
  }) {
    let derivedPublicKey: KeyObject;
    try {
      if (
        input.privateKey.type !== "private" ||
        input.privateKey.asymmetricKeyType !== "ed25519"
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      derivedPublicKey = createPublicKey(input.privateKey);
      if (
        input.publicKey !== undefined &&
        (input.publicKey.type !== "public" ||
          input.publicKey.asymmetricKeyType !== "ed25519" ||
          !derivedPublicKey
            .export({ format: "der", type: "spki" })
            .equals(
              input.publicKey.export({
                format: "der",
                type: "spki",
              }),
            ))
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
    } catch {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    this.authorityKeyId = input.authorityKeyId;
    this.trustRootVersion = input.trustRootVersion;
    this.#privateKey = input.privateKey;
    this.publicKey = input.publicKey ?? derivedPublicKey;
  }

  protected abstract load(): ProviderState;
  protected abstract persist(
    state: ProviderState,
    journalRecord: unknown,
    expectedStateHash: string | null,
  ): void;
  protected abstract loadTerminalByLookup(
    idempotencyKey: string,
  ): RecoveryTerminalLookup | null;
  protected abstract loadTerminalByHash(
    recordHash: string,
  ): RecoveryTerminalRecord | null;
  protected abstract persistTerminalTransition(input: {
    record: RecoveryTerminalRecord;
    index: RecoveryTerminalIndex;
    state: ProviderState;
    journalRecord: unknown;
    expectedStateHash: string;
  }): void;

  protected signProviderValue(value: unknown): string {
    return sign(
      null,
      Buffer.from(canonicalJson(value), "utf8"),
      this.#privateKey,
    ).toString("base64url");
  }

  protected terminalArtifacts(input: {
    pending: SignedPending;
    frontier: RecoveryTerminalFrontier;
  }): {
    record: RecoveryTerminalRecord;
    index: RecoveryTerminalIndex;
  } {
    verifyPending(input.pending, this.authorityKeyId, this.publicKey);
    if (input.pending.reservation.state !== "reconciled") {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const lookupHash = canonicalSha256({
      domain: RECOVERY_TERMINAL_INDEX_DOMAIN,
      idempotency_key: input.pending.reservation.idempotency_key,
    });
    const recordUnsigned = {
      payload: {
        schema_version: "1.0.0" as const,
        sequence: input.frontier.record_count + 1,
        previous_record_hash: input.frontier.head_record_hash,
        lookup_hash: lookupHash,
        pending: input.pending,
      },
      authority_key_id: this.authorityKeyId,
      trust_root_version: this.trustRootVersion,
    };
    const record = RecoveryTerminalRecordSchema.parse({
      ...recordUnsigned,
      signature: this.signProviderValue({
        domain: RECOVERY_TERMINAL_RECORD_DOMAIN,
        ...recordUnsigned,
      }),
      record_hash: canonicalSha256(recordUnsigned),
    });
    const indexUnsigned = {
      payload: {
        schema_version: "1.0.0" as const,
        lookup_hash: lookupHash,
        record_hash: record.record_hash,
        sequence: record.payload.sequence,
        previous_record_hash: record.payload.previous_record_hash,
      },
      authority_key_id: this.authorityKeyId,
      trust_root_version: this.trustRootVersion,
    };
    return {
      record,
      index: RecoveryTerminalIndexSchema.parse({
        ...indexUnsigned,
        signature: this.signProviderValue({
          domain: RECOVERY_TERMINAL_INDEX_DOMAIN,
          ...indexUnsigned,
        }),
        index_hash: canonicalSha256(indexUnsigned),
      }),
    };
  }

  protected verifyTerminalRecord(
    record: RecoveryTerminalRecord,
  ): RecoveryTerminalRecord {
    const parsed = RecoveryTerminalRecordSchema.parse(record);
    const unsigned = {
      payload: parsed.payload,
      authority_key_id: parsed.authority_key_id,
      trust_root_version: parsed.trust_root_version,
    };
    if (
      parsed.authority_key_id !== this.authorityKeyId ||
      parsed.trust_root_version !== this.trustRootVersion ||
      !verify(
        null,
        Buffer.from(
          canonicalJson({
            domain: RECOVERY_TERMINAL_RECORD_DOMAIN,
            ...unsigned,
          }),
          "utf8",
        ),
        this.publicKey,
        Buffer.from(parsed.signature, "base64url"),
      )
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    verifyPending(
      parsed.payload.pending,
      this.authorityKeyId,
      this.publicKey,
    );
    return parsed;
  }

  protected verifyTerminalIndex(
    index: RecoveryTerminalIndex,
  ): RecoveryTerminalIndex {
    const parsed = RecoveryTerminalIndexSchema.parse(index);
    const unsigned = {
      payload: parsed.payload,
      authority_key_id: parsed.authority_key_id,
      trust_root_version: parsed.trust_root_version,
    };
    if (
      parsed.authority_key_id !== this.authorityKeyId ||
      parsed.trust_root_version !== this.trustRootVersion ||
      !verify(
        null,
        Buffer.from(
          canonicalJson({
            domain: RECOVERY_TERMINAL_INDEX_DOMAIN,
            ...unsigned,
          }),
          "utf8",
        ),
        this.publicKey,
        Buffer.from(parsed.signature, "base64url"),
      )
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return parsed;
  }

  protected verifyTerminalTransition(
    input: {
      record: RecoveryTerminalRecord;
      index: RecoveryTerminalIndex;
      state: ProviderState;
      expectedStateHash: string;
    },
    current: ProviderState,
  ): {
    record: RecoveryTerminalRecord;
    index: RecoveryTerminalIndex;
  } {
    if (current.state_hash !== input.expectedStateHash) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
    this.assertStateAuthority(current);
    this.assertStateAuthority(input.state);
    const record = this.verifyTerminalRecord(input.record);
    const index = this.verifyTerminalIndex(input.index);
    const artifacts = this.terminalArtifacts({
      pending: record.payload.pending,
      frontier: terminalFrontier(current),
    });
    const pendingIndex = current.pending.findIndex(
      ({ reservation }) =>
        reservation.pending_id ===
        record.payload.pending.reservation.pending_id,
    );
    const active = current.pending[pendingIndex];
    const expectedReservation =
      active === undefined
        ? undefined
        : RecoveryPendingReservationSchema.parse({
            ...active.reservation,
            state: "reconciled",
          });
    const expectedState = sealState({
      ...current,
      pending: current.pending.filter(
        (_pending, itemIndex) => itemIndex !== pendingIndex,
      ),
      terminal_frontier: {
        record_count: record.payload.sequence,
        head_record_hash: record.record_hash,
      },
    });
    if (
      active === undefined ||
      (active.reservation.state !== "committed" &&
        active.reservation.state !== "reconciled") ||
      canonicalJson(expectedReservation) !==
        canonicalJson(record.payload.pending.reservation) ||
      canonicalJson(artifacts.record) !== canonicalJson(record) ||
      canonicalJson(artifacts.index) !== canonicalJson(index) ||
      canonicalJson(expectedState) !== canonicalJson(input.state)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return { record, index };
  }

  protected assertStateAuthority(state: ProviderState): void {
    if (
      state.authority_key_id !== this.authorityKeyId ||
      state.trust_root_version !== this.trustRootVersion
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (state.current !== null) {
      verifyRecoveryAnchor({
        anchor: state.current,
        expectedAuthorityKeyId: this.authorityKeyId,
        publicKey: this.publicKey,
      });
      if (
        state.current.payload.trust_root_version !== this.trustRootVersion
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
    }
    for (const pending of state.pending) {
      verifyPending(pending, this.authorityKeyId, this.publicKey);
    }
  }

  readCurrent(): RecoveryAnchor | null {
    const state = this.#verifiedState();
    return state.current;
  }

  unresolvedPending(): readonly RecoveryPendingReservation[] {
    return this.#verifiedState().pending
      .map(({ reservation }) => reservation)
      .filter(({ state }) => state === "pending" || state === "committed");
  }

  bootstrap(input: {
    root_id: string;
    principal_id: string;
    minimums: RecoveryMinimums;
    state_commitment_hash: CanonicalHash;
    issued_at?: string;
  }): RecoveryAnchor {
    const minimums = RecoveryMinimumsSchema.parse(input.minimums);
    if (
      input.state_commitment_hash !==
      recoveryStateCommitment({
        root_id: input.root_id,
        principal_id: input.principal_id,
        minimums,
      })
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const state = this.#verifiedState();
    if (state.pending.length !== 0) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (state.current !== null) {
      const current = state.current.payload;
      if (
        current.root_id !== input.root_id ||
        current.principal_id !== input.principal_id ||
        current.state_commitment_hash !== input.state_commitment_hash ||
        canonicalJson(current.minimums) !== canonicalJson(minimums)
      ) {
        throw new StorageError("STALE_RECOVERY_HEAD");
      }
      return state.current;
    }
    const anchor = this.#anchor({
      generation: 1,
      previousHeadHash: null,
      rootId: input.root_id,
      principalId: input.principal_id,
      stateCommitmentHash: input.state_commitment_hash,
      backupManifestHash: null,
      minimums,
      issuedAt: input.issued_at ?? new Date().toISOString(),
    });
    this.persist(
      sealState({ ...state, current: anchor }),
      { kind: "bootstrap_anchor_committed", anchor },
      state.state_hash,
    );
    return anchor;
  }

  issueBackupAnchor(input: {
    manifest: CompleteBackupManifest;
    minimums: RecoveryMinimums;
  }): RecoveryAnchor {
    const expected = minimumsFromManifest(input.manifest);
    const minimums = RecoveryMinimumsSchema.parse(input.minimums);
    if (canonicalJson(expected) !== canonicalJson(minimums)) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const state = this.#verifiedState();
    if (this.unresolvedPending().length !== 0) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (
      state.current === null ||
      state.current.payload.root_id !==
        input.manifest.root_identity.root_id ||
      state.current.payload.principal_id !==
        input.manifest.root_identity.principal_id ||
      canonicalJson(state.current.payload.minimums) !==
        canonicalJson(minimums)
    ) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
    const stateCommitmentHash = recoveryStateCommitment({
      root_id: input.manifest.root_identity.root_id,
      principal_id: input.manifest.root_identity.principal_id,
      minimums,
    });
    const anchor = this.#anchor({
      generation: (state.current?.payload.generation ?? 0) + 1,
      previousHeadHash:
        state.current?.anchor_hash ?? null,
      rootId: input.manifest.root_identity.root_id,
      principalId: input.manifest.root_identity.principal_id,
      stateCommitmentHash,
      backupManifestHash: input.manifest.manifest_hash,
      minimums,
      issuedAt: input.manifest.created_at,
    });
    this.persist(
      sealState({ ...state, current: anchor }),
      { kind: "backup_anchor_committed", anchor },
      state.state_hash,
    );
    return anchor;
  }

  reserve(input: {
    operation: RecoveryPendingReservation["operation"];
    idempotency_key: string;
    request_hash: CanonicalHash;
    prior_minimums: RecoveryMinimums;
    prior_state_commitment_hash: CanonicalHash;
    reserved_at?: string;
  }): RecoveryPendingAuthorization {
    const state = this.#verifiedState();
    const existing = state.pending.find(
      ({ reservation }) =>
        reservation.idempotency_key === input.idempotency_key,
    );
    if (existing !== undefined) {
      if (
        existing.reservation.operation !== input.operation ||
        existing.reservation.request_hash !== input.request_hash
      ) {
        throw new StorageError("CONFLICT");
      }
      if (existing.reservation.state === "committed") {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      if (
        (canonicalJson(existing.reservation.prior_minimums) !==
          canonicalJson(input.prior_minimums) ||
          existing.reservation.prior_state_commitment_hash !==
            input.prior_state_commitment_hash)
      ) {
        throw new StorageError("CONFLICT");
      }
      return {
        reservation: existing.reservation,
        authority_key_id: IdentifierSchema.parse(
          existing.authority_key_id,
        ),
        signature: existing.signature,
      };
    }
    const terminal = this.loadTerminalByLookup(input.idempotency_key);
    if (terminal !== null) {
      const verified = this.verifyTerminalRecord(terminal.record);
      this.#assertTerminalInFrontier(state, terminal);
      const reconciled = verified.payload.pending;
      if (
        reconciled.reservation.operation !== input.operation ||
        reconciled.reservation.request_hash !== input.request_hash
      ) {
        throw new StorageError("CONFLICT");
      }
      return {
        reservation: reconciled.reservation,
        authority_key_id: IdentifierSchema.parse(
          reconciled.authority_key_id,
        ),
        signature: reconciled.signature,
      };
    }
    const current = state.current;
    if (
      current === null ||
      canonicalJson(current.payload.minimums) !==
        canonicalJson(input.prior_minimums) ||
      current.payload.state_commitment_hash !==
        input.prior_state_commitment_hash
    ) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
    if (state.pending.length >= MAX_ACTIVE_RECOVERY_RESERVATIONS) {
      throw new StorageError("STORAGE_UNAVAILABLE", { retryable: true });
    }
    const reservation = RecoveryPendingReservationSchema.parse({
      pending_id: `anchor_pending:${randomUUID()}`,
      operation: input.operation,
      idempotency_key: input.idempotency_key,
      request_hash: input.request_hash,
      prior_minimums: input.prior_minimums,
      prior_state_commitment_hash: input.prior_state_commitment_hash,
      prior_head_hash: state.current?.anchor_hash ?? null,
      state: "pending",
      reserved_at: input.reserved_at ?? new Date().toISOString(),
    });
    const signed = signedPending(
      reservation,
      this.authorityKeyId,
      this.#privateKey,
    );
    this.persist(
      sealState({ ...state, pending: [...state.pending, signed] }),
      { kind: "pending", pending: signed },
      state.state_hash,
    );
    return {
      reservation,
      authority_key_id: IdentifierSchema.parse(signed.authority_key_id),
      signature: signed.signature,
    };
  }

  commit(input: {
    pending_id: string;
    backup_manifest_hash: CanonicalHash | null;
    state_commitment_hash: CanonicalHash;
    root_id: string;
    principal_id: string;
    committed_minimums: RecoveryMinimums;
    committed_at?: string;
  }): RecoveryAnchor {
    const state = this.#verifiedState();
    const index = state.pending.findIndex(
      ({ reservation }) => reservation.pending_id === input.pending_id,
    );
    const pending = state.pending[index];
    if (
      pending === undefined ||
      pending.reservation.state !== "pending" ||
      pending.reservation.prior_head_hash !==
        (state.current?.anchor_hash ?? null) ||
      canonicalJson(pending.reservation.prior_minimums) !==
        canonicalJson(state.current?.payload.minimums) ||
      pending.reservation.prior_state_commitment_hash !==
        state.current?.payload.state_commitment_hash ||
      input.state_commitment_hash !==
        recoveryStateCommitment({
          root_id: input.root_id,
          principal_id: input.principal_id,
          minimums: input.committed_minimums,
        })
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    assertMonotonicMinimums(
      state.current?.payload.minimums ?? null,
      input.committed_minimums,
      pending.reservation.operation,
    );
    const anchor = this.#anchor({
      generation: (state.current?.payload.generation ?? 0) + 1,
      previousHeadHash:
        state.current?.anchor_hash ?? null,
      rootId: input.root_id,
      principalId: input.principal_id,
      stateCommitmentHash: input.state_commitment_hash,
      backupManifestHash: input.backup_manifest_hash,
      minimums: input.committed_minimums,
      issuedAt: input.committed_at ?? new Date().toISOString(),
    });
    const reservation = RecoveryPendingReservationSchema.parse({
      ...pending.reservation,
      state: "committed",
    });
    const nextPending = [...state.pending];
    nextPending[index] = signedPending(
      reservation,
      this.authorityKeyId,
      this.#privateKey,
    );
    this.persist(
      sealState({ ...state, current: anchor, pending: nextPending }),
      { kind: "committed", pending_id: input.pending_id, anchor },
      state.state_hash,
    );
    return anchor;
  }

  reconcile(pendingId: string): void {
    this.#transitionPending(pendingId, "committed", "reconciled");
  }

  abort(input: {
    pending_id: string;
    effect_provably_absent: true;
  }): void {
    if (input.effect_provably_absent !== true) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    this.#transitionPending(input.pending_id, "pending", "aborted");
  }

  #transitionPending(
    pendingId: string,
    expected: "pending" | "committed",
    next: "aborted" | "reconciled",
  ): void {
    const state = this.#verifiedState();
    const index = state.pending.findIndex(
      ({ reservation }) => reservation.pending_id === pendingId,
    );
    const pending = state.pending[index];
    if (pending === undefined) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (pending.reservation.state === next) {
      return;
    }
    if (pending.reservation.state !== expected) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const reservation = RecoveryPendingReservationSchema.parse({
      ...pending.reservation,
      state: next,
    });
    const terminal = signedPending(
      reservation,
      this.authorityKeyId,
      this.#privateKey,
    );
    if (next === "reconciled") {
      const frontier = terminalFrontier(state);
      const artifacts = this.terminalArtifacts({
        pending: terminal,
        frontier,
      });
      const existingTerminal = this.loadTerminalByLookup(
        terminal.reservation.idempotency_key,
      );
      if (
        existingTerminal !== null &&
        canonicalJson(
          this.verifyTerminalRecord(existingTerminal.record),
        ) !==
          canonicalJson(artifacts.record)
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      this.persistTerminalTransition({
        record: artifacts.record,
        index: artifacts.index,
        state: sealState({
          ...state,
          pending: state.pending.filter(
            (_item, itemIndex) => itemIndex !== index,
          ),
          terminal_frontier: {
            record_count: artifacts.record.payload.sequence,
            head_record_hash: artifacts.record.record_hash,
          },
        }),
        journalRecord: {
          kind: next,
          pending: terminal,
          terminal_record_hash: artifacts.record.record_hash,
        },
        expectedStateHash: state.state_hash,
      });
      return;
    }
    this.persist(
      sealState({
        ...state,
        pending: state.pending.filter(
          ({ reservation: item }) => item.pending_id !== pendingId,
        ),
      }),
      { kind: next, pending: terminal },
      state.state_hash,
    );
  }

  #anchor(input: {
    generation: number;
    previousHeadHash: CanonicalHash | null;
    rootId: string;
    principalId: string;
    stateCommitmentHash: CanonicalHash;
    backupManifestHash: CanonicalHash | null;
    minimums: RecoveryMinimums;
    issuedAt: string;
  }): RecoveryAnchor {
    const payloadWithoutHash = {
      schema_version: "1.0.0" as const,
      anchor_id: `recovery_anchor:${randomUUID()}`,
      generation: input.generation,
      previous_head_hash: input.previousHeadHash,
      root_id: input.rootId,
      principal_id: input.principalId,
      trust_root_version: this.trustRootVersion,
      state_commitment_hash: input.stateCommitmentHash,
      backup_manifest_hash: input.backupManifestHash,
      minimums: input.minimums,
      issued_at: input.issuedAt,
    };
    const payload = {
      ...payloadWithoutHash,
      payload_hash: canonicalSha256(payloadWithoutHash),
    };
    return RecoveryAnchorSchema.parse({
      payload,
      authority_key_id: this.authorityKeyId,
      signature: sign(
        null,
        Buffer.from(canonicalJson(payload), "utf8"),
        this.#privateKey,
      ).toString("base64url"),
      anchor_hash: canonicalSha256({
        payload,
        authority_key_id: this.authorityKeyId,
      }),
    });
  }

  #verifiedState(): ProviderState {
    for (;;) {
      const state = this.load();
      this.assertStateAuthority(state);
      this.#assertTerminalHead(state);
      let recoverable:
        | {
            pending: SignedPending;
            reconciled: SignedPending;
            index: number;
          }
        | undefined;
      for (const [index, pending] of state.pending.entries()) {
        const reconciled = signedPending(
          RecoveryPendingReservationSchema.parse({
            ...pending.reservation,
            state: "reconciled",
          }),
          this.authorityKeyId,
          this.#privateKey,
        );
        const artifacts = this.terminalArtifacts({
          pending: reconciled,
          frontier: terminalFrontier(state),
        });
        const terminalByLookup = this.loadTerminalByLookup(
          pending.reservation.idempotency_key,
        );
        const terminalByHash = this.loadTerminalByHash(
          artifacts.record.record_hash,
        );
        for (const terminal of [
          terminalByLookup?.record ?? null,
          terminalByHash,
        ]) {
          if (
            terminal !== null &&
            canonicalJson(this.verifyTerminalRecord(terminal)) !==
              canonicalJson(artifacts.record)
          ) {
            throw new StorageError("RECOVERY_AUTHORITY_INVALID");
          }
        }
        if (pending.reservation.state === "pending") {
          if (terminalByLookup !== null || terminalByHash !== null) {
            throw new StorageError("RECOVERY_AUTHORITY_INVALID");
          }
          continue;
        }
        if (
          pending.reservation.state === "reconciled" ||
          (pending.reservation.state === "committed" &&
            (terminalByLookup !== null || terminalByHash !== null))
        ) {
          recoverable = { pending, reconciled, index };
          break;
        }
        if (pending.reservation.state !== "committed") {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
      }
      if (recoverable === undefined) {
        if (state.pending.length > MAX_ACTIVE_RECOVERY_RESERVATIONS) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        return state;
      }
      const reconciled = recoverable.reconciled;
      const frontier = terminalFrontier(state);
      const artifacts = this.terminalArtifacts({
        pending: reconciled,
        frontier,
      });
      const existing = this.loadTerminalByLookup(
        reconciled.reservation.idempotency_key,
      );
      if (
        existing !== null &&
        canonicalJson(this.verifyTerminalRecord(existing.record)) !==
          canonicalJson(artifacts.record)
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      this.persistTerminalTransition({
        record: artifacts.record,
        index: artifacts.index,
        state: sealState({
          ...state,
          pending: state.pending.filter(
            (_pending, index) => index !== recoverable.index,
          ),
          terminal_frontier: {
            record_count: artifacts.record.payload.sequence,
            head_record_hash: artifacts.record.record_hash,
          },
        }),
        journalRecord: {
          kind: "terminal_recovered",
          pending: reconciled,
          terminal_record_hash: artifacts.record.record_hash,
        },
        expectedStateHash: state.state_hash,
      });
    }
  }

  #assertTerminalHead(state: ProviderState): void {
    const frontier = terminalFrontier(state);
    if (frontier.head_record_hash === null) {
      return;
    }
    const head = this.loadTerminalByHash(frontier.head_record_hash);
    if (
      head === null ||
      this.verifyTerminalRecord(head).record_hash !==
        frontier.head_record_hash ||
      head.payload.sequence !== frontier.record_count
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  #assertTerminalInFrontier(
    state: ProviderState,
    expected: RecoveryTerminalLookup,
  ): void {
    const frontier = terminalFrontier(state);
    const record = this.verifyTerminalRecord(expected.record);
    const index = this.verifyTerminalIndex(expected.index);
    if (
      frontier.record_count === 0 ||
      frontier.head_record_hash === null ||
      index.payload.lookup_hash !== record.payload.lookup_hash ||
      index.payload.record_hash !== record.record_hash ||
      index.payload.sequence !== record.payload.sequence ||
      index.payload.previous_record_hash !==
        record.payload.previous_record_hash ||
      index.payload.sequence > frontier.record_count ||
      (index.payload.sequence === frontier.record_count &&
        index.payload.record_hash !== frontier.head_record_hash)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }
}

export class MemoryRecoveryHeadProvider extends BaseRecoveryHeadProvider {
  #state: ProviderState;
  readonly #terminalByLookup = new Map<
    string,
    RecoveryTerminalRecord
  >();
  readonly #terminalByHash = new Map<
    string,
    RecoveryTerminalRecord
  >();
  readonly #terminalIndexes = new Map<
    string,
    RecoveryTerminalIndex
  >();

  constructor(input: {
    authorityKeyId: string;
    trustRootVersion: number;
    privateKey: KeyObject;
    publicKey?: KeyObject;
  }) {
    super(input);
    this.#state = sealState({
      schema_version: "1.0.0",
      authority_key_id: input.authorityKeyId,
      trust_root_version: input.trustRootVersion,
      current: null,
      pending: [],
      terminal_frontier: ZERO_TERMINAL_FRONTIER,
    });
  }

  protected load(): ProviderState {
    return structuredClone(this.#state);
  }

  protected persist(
    state: ProviderState,
    _journalRecord: unknown,
    expectedStateHash: string | null,
  ): void {
    if (
      expectedStateHash !== null &&
      this.#state.state_hash !== expectedStateHash
    ) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
    this.#state = structuredClone(state);
  }

  protected loadTerminalByLookup(
    idempotencyKey: string,
  ): RecoveryTerminalLookup | null {
    const lookupHash = canonicalSha256({
      domain: RECOVERY_TERMINAL_INDEX_DOMAIN,
      idempotency_key: idempotencyKey,
    });
    const index = this.#terminalIndexes.get(lookupHash);
    if (index === undefined) {
      return null;
    }
    const verifiedIndex = this.verifyTerminalIndex(index);
    const record = this.#terminalByHash.get(
      verifiedIndex.payload.record_hash,
    );
    if (
      record === undefined ||
      verifiedIndex.payload.lookup_hash !== lookupHash ||
      this.#terminalByLookup.get(lookupHash)?.record_hash !==
        record.record_hash ||
      verifiedIndex.payload.sequence !== record.payload.sequence ||
      verifiedIndex.payload.previous_record_hash !==
        record.payload.previous_record_hash
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return {
      record: structuredClone(this.verifyTerminalRecord(record)),
      index: structuredClone(verifiedIndex),
    };
  }

  protected loadTerminalByHash(
    recordHash: string,
  ): RecoveryTerminalRecord | null {
    const record = this.#terminalByHash.get(recordHash);
    return record === undefined
      ? null
      : structuredClone(this.verifyTerminalRecord(record));
  }

  protected persistTerminalTransition(input: {
    record: RecoveryTerminalRecord;
    index: RecoveryTerminalIndex;
    state: ProviderState;
    journalRecord: unknown;
    expectedStateHash: string;
  }): void {
    const { record, index } = this.verifyTerminalTransition(
      input,
      this.#state,
    );
    const existingIndex = this.#terminalIndexes.get(
      index.payload.lookup_hash,
    );
    const existingRecord = this.#terminalByHash.get(record.record_hash);
    if (
      (existingIndex !== undefined &&
        canonicalJson(existingIndex) !== canonicalJson(index)) ||
      (existingRecord !== undefined &&
        canonicalJson(existingRecord) !== canonicalJson(record))
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    this.#terminalByHash.set(record.record_hash, structuredClone(record));
    this.#terminalByLookup.set(
      record.payload.lookup_hash,
      structuredClone(record),
    );
    this.#terminalIndexes.set(
      index.payload.lookup_hash,
      structuredClone(index),
    );
    this.#state = structuredClone(input.state);
  }
}

export class FileRecoveryHeadProvider extends BaseRecoveryHeadProvider {
  static readonly #MAX_JOURNAL_RECORDS = 64;
  readonly #directory: string;
  readonly #headPath: string;
  readonly #journalPath: string;
  readonly #lockPath: string;
  readonly #terminalDirectory: string;
  readonly #terminalRecordsDirectory: string;
  readonly #terminalIndexDirectory: string;
  readonly #terminalSequenceDirectory: string;
  readonly #testHooks:
    | {
        afterLockPublished?: () => void;
        afterJournalFsync?: () => void;
        afterTerminalRecordFsync?: () => void;
        afterTerminalIndexFsync?: () => void;
        onTerminalRead?: (kind: "index" | "record") => void;
      }
    | undefined;
  #ownedLock: ObservedRecoveryHeadLock | null = null;

  constructor(input: {
    directory: string;
    authorityKeyId: string;
    trustRootVersion: number;
    privateKey: KeyObject;
    publicKey?: KeyObject;
    create?: boolean;
    testHooks?: {
      afterLockPublished?: () => void;
      afterJournalFsync?: () => void;
      afterTerminalRecordFsync?: () => void;
      afterTerminalIndexFsync?: () => void;
      onTerminalRead?: (kind: "index" | "record") => void;
    };
  }) {
    super(input);
    this.#directory = resolve(input.directory);
    this.#headPath = join(this.#directory, "head.json");
    this.#journalPath = join(this.#directory, "journal.jsonl");
    this.#lockPath = join(this.#directory, ".head.lock");
    this.#terminalDirectory = join(this.#directory, "terminal");
    this.#terminalRecordsDirectory = join(
      this.#terminalDirectory,
      "records",
    );
    this.#terminalIndexDirectory = join(
      this.#terminalDirectory,
      "index",
    );
    this.#terminalSequenceDirectory = join(
      this.#terminalDirectory,
      "sequence",
    );
    this.#testHooks = input.testHooks;
    if (input.create === true) {
      if (existsSync(this.#directory)) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      mkdirSync(this.#directory, { mode: 0o700 });
      chmodSync(this.#directory, 0o700);
      this.#ensureTerminalDirectories();
      const initial = sealState({
        schema_version: "1.0.0",
        authority_key_id: input.authorityKeyId,
        trust_root_version: input.trustRootVersion,
        current: null,
        pending: [],
        terminal_frontier: ZERO_TERMINAL_FRONTIER,
      });
      this.persist(initial, { kind: "initialized" }, null);
    }
    if (!existsSync(this.#headPath) || !existsSync(this.#journalPath)) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    assertPrivateDirectory(this.#directory);
    this.#ensureTerminalDirectories();
    readPrivateRegularFile(
      this.#headPath,
      MAX_RECOVERY_PROVIDER_STATE_BYTES,
    );
    readPrivateRegularFile(
      this.#journalPath,
      MAX_RECOVERY_PROVIDER_JOURNAL_BYTES,
    );
    this.load();
  }

  protected load(): ProviderState {
    const acquiredHere = this.#ownedLock === null;
    try {
      if (acquiredHere) {
        this.#acquireLock();
      } else {
        this.#assertOwnedLock();
      }
      return this.#loadStateWhileLocked();
    } catch {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    } finally {
      if (acquiredHere && this.#ownedLock !== null) {
        this.#releaseLock();
      }
    }
  }

  protected persist(
    state: ProviderState,
    journalRecord: unknown,
    expectedStateHash: string | null,
  ): void {
    const acquiredHere = this.#ownedLock === null;
    try {
      if (acquiredHere) {
        this.#acquireLock();
      } else {
        this.#assertOwnedLock();
      }
      if (expectedStateHash !== null) {
        const current = this.#loadStateWhileLocked();
        if (current.state_hash !== expectedStateHash) {
          throw new StorageError("STALE_RECOVERY_HEAD");
        }
      }
      this.#appendStateWhileLocked(
        state,
        journalRecord,
        expectedStateHash,
      );
    } finally {
      if (acquiredHere && this.#ownedLock !== null) {
        this.#releaseLock();
      }
    }
  }

  protected loadTerminalByLookup(
    idempotencyKey: string,
  ): RecoveryTerminalLookup | null {
    try {
      const lookupHash = canonicalSha256({
        domain: RECOVERY_TERMINAL_INDEX_DOMAIN,
        idempotency_key: idempotencyKey,
      });
      const indexPath = this.#terminalPath(
        this.#terminalIndexDirectory,
        lookupHash,
      );
      if (!this.#terminalFileExists(indexPath)) {
        return null;
      }
      const indexRaw = readPrivateRegularFile(
        indexPath,
        MAX_RECOVERY_TERMINAL_BYTES,
      );
      this.#testHooks?.onTerminalRead?.("index");
      const index = this.verifyTerminalIndex(
        RecoveryTerminalIndexSchema.parse(
          JSON.parse(indexRaw) as unknown,
        ),
      );
      if (index.payload.lookup_hash !== lookupHash) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      const record = this.loadTerminalByHash(index.payload.record_hash);
      if (
        record === null ||
        record.payload.lookup_hash !== lookupHash ||
        record.record_hash !== index.payload.record_hash ||
        record.payload.sequence !== index.payload.sequence ||
        record.payload.previous_record_hash !==
          index.payload.previous_record_hash
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return { record, index };
    } catch {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  protected loadTerminalByHash(
    recordHash: string,
  ): RecoveryTerminalRecord | null {
    try {
      const recordPath = this.#terminalPath(
        this.#terminalRecordsDirectory,
        recordHash,
      );
      if (!this.#terminalFileExists(recordPath)) {
        return null;
      }
      const recordRaw = readPrivateRegularFile(
        recordPath,
        MAX_RECOVERY_TERMINAL_BYTES,
      );
      this.#testHooks?.onTerminalRead?.("record");
      const record = this.verifyTerminalRecord(
        RecoveryTerminalRecordSchema.parse(
          JSON.parse(recordRaw) as unknown,
        ),
      );
      if (record.record_hash !== recordHash) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return record;
    } catch {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  protected persistTerminalTransition(input: {
    record: RecoveryTerminalRecord;
    index: RecoveryTerminalIndex;
    state: ProviderState;
    journalRecord: unknown;
    expectedStateHash: string;
  }): void {
    const acquiredHere = this.#ownedLock === null;
    try {
      if (acquiredHere) {
        this.#acquireLock();
      } else {
        this.#assertOwnedLock();
      }
      const current = this.#loadStateWhileLocked();
      const { record, index } = this.verifyTerminalTransition(
        input,
        current,
      );
      this.#persistImmutableTerminalFile(
        this.#terminalPath(
          this.#terminalRecordsDirectory,
          record.record_hash,
        ),
        record,
      );
      this.#testHooks?.afterTerminalRecordFsync?.();
      this.#persistImmutableTerminalFile(
        this.#terminalPath(
          this.#terminalIndexDirectory,
          index.payload.lookup_hash,
        ),
        index,
      );
      this.#testHooks?.afterTerminalIndexFsync?.();
      this.#persistImmutableTerminalFile(
        this.#terminalSequencePath(record.payload.sequence),
        record,
      );
      this.#appendStateWhileLocked(
        input.state,
        input.journalRecord,
        input.expectedStateHash,
      );
    } finally {
      if (acquiredHere && this.#ownedLock !== null) {
        this.#releaseLock();
      }
    }
  }

  #loadStateWhileLocked(): ProviderState {
    this.#assertOwnedLock();
    assertPrivateDirectory(this.#directory);
    assertPrivateDirectory(this.#terminalDirectory);
    assertPrivateDirectory(this.#terminalRecordsDirectory);
    assertPrivateDirectory(this.#terminalIndexDirectory);
    const head = ProviderStateSchema.parse(
      JSON.parse(
        readPrivateRegularFile(
          this.#headPath,
          MAX_RECOVERY_PROVIDER_STATE_BYTES,
        ),
      ) as unknown,
    );
    const journalLines = readPrivateRegularFile(
      this.#journalPath,
      MAX_RECOVERY_PROVIDER_JOURNAL_BYTES,
    )
      .split("\n")
      .filter((line) => line.length !== 0);
    if (journalLines.length === 0) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    let priorHash: string | null = null;
    let journalState: ProviderState | undefined;
    const journalHashes = new Set<string>();
    for (const line of journalLines) {
      const journalRecord = JSON.parse(line) as {
        previous_state_hash?: unknown;
        state?: unknown;
        state_hash?: unknown;
      };
      journalState = ProviderStateSchema.parse(journalRecord.state);
      if (
        journalRecord.previous_state_hash !== priorHash ||
        journalRecord.state_hash !== journalState.state_hash ||
        journalHashes.has(journalState.state_hash)
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      priorHash = journalState.state_hash;
      journalHashes.add(journalState.state_hash);
    }
    if (journalState === undefined) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (head.state_hash !== journalState.state_hash) {
      if (!journalHashes.has(head.state_hash)) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      this.assertStateAuthority(journalState);
      this.#repairHead(head.state_hash, journalState);
    }
    this.#assertTerminalSequenceWitness(journalState);
    return journalState;
  }

  #appendStateWhileLocked(
    state: ProviderState,
    journalRecord: unknown,
    expectedStateHash: string | null,
  ): void {
    this.#assertOwnedLock();
    const raw = `${canonicalJson({
      ...journalRecord as object,
      previous_state_hash: expectedStateHash,
      state,
      state_hash: state.state_hash,
    })}\n`;
    if (
      Buffer.byteLength(raw, "utf8") >
      MAX_RECOVERY_PROVIDER_JOURNAL_RECORD_BYTES
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const journalDescriptor = openSync(
      this.#journalPath,
      constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (expectedStateHash === null
          ? constants.O_CREAT | constants.O_EXCL
          : 0),
      0o600,
    );
    try {
      writeFileSync(journalDescriptor, raw);
      fsyncSync(journalDescriptor);
      this.#testHooks?.afterJournalFsync?.();
    } finally {
      closeSync(journalDescriptor);
    }
    chmodSync(this.#journalPath, 0o600);
    this.#writeHead(state);
    this.#compactJournal(state);
  }

  #persistImmutableTerminalFile(path: string, value: unknown): void {
    const raw = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(raw, "utf8") > MAX_RECOVERY_TERMINAL_BYTES) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const directory = path.startsWith(`${this.#terminalRecordsDirectory}/`)
      ? this.#terminalRecordsDirectory
      : path.startsWith(`${this.#terminalIndexDirectory}/`)
        ? this.#terminalIndexDirectory
        : path.startsWith(`${this.#terminalSequenceDirectory}/`)
          ? this.#terminalSequenceDirectory
        : null;
    if (directory === null) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const temporary = join(directory, `.terminal-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, raw);
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
    try {
      try {
        linkSync(temporary, path);
        this.#fsyncDirectoryPath(directory);
      } catch (error) {
        if (!hasErrnoCode(error, "EEXIST")) {
          throw new StorageError("STORAGE_UNAVAILABLE", {
            retryable: true,
          });
        }
        const existing = readPrivateRegularFile(
          path,
          MAX_RECOVERY_TERMINAL_BYTES,
        );
        if (existing !== raw) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
      }
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
        this.#fsyncDirectoryPath(directory);
      }
    }
  }

  #terminalPath(directory: string, hash: string): string {
    const parsed = CanonicalHashSchema.parse(hash);
    return join(directory, `${parsed.slice("sha256:".length)}.json`);
  }

  #terminalSequencePath(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return join(
      this.#terminalSequenceDirectory,
      `${String(sequence).padStart(20, "0")}.json`,
    );
  }

  #loadTerminalBySequence(
    sequence: number,
  ): RecoveryTerminalRecord | null {
    const path = this.#terminalSequencePath(sequence);
    if (!this.#terminalFileExists(path)) {
      return null;
    }
    const record = this.verifyTerminalRecord(
      RecoveryTerminalRecordSchema.parse(
        JSON.parse(
          readPrivateRegularFile(path, MAX_RECOVERY_TERMINAL_BYTES),
        ) as unknown,
      ),
    );
    if (record.payload.sequence !== sequence) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return record;
  }

  #assertTerminalSequenceWitness(state: ProviderState): void {
    const frontier = terminalFrontier(state);
    if (frontier.record_count > 0) {
      const witness = this.#loadTerminalBySequence(
        frontier.record_count,
      );
      if (witness === null) {
        const current = this.loadTerminalByHash(
          frontier.head_record_hash ?? "",
        );
        if (current === null) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        this.#persistImmutableTerminalFile(
          this.#terminalSequencePath(frontier.record_count),
          current,
        );
      } else if (witness.record_hash !== frontier.head_record_hash) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
    }

    const nextSequence = frontier.record_count + 1;
    const maximumSequence = this.#maximumTerminalSequence();
    if (
      maximumSequence < frontier.record_count ||
      maximumSequence > nextSequence
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const next = this.#loadTerminalBySequence(nextSequence);
    if ((next === null) !== (maximumSequence < nextSequence)) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (next === null) {
      return;
    }
    const candidates = state.pending.filter((pending) => {
      if (
        pending.reservation.state !== "committed" &&
        pending.reservation.state !== "reconciled"
      ) {
        return false;
      }
      return (
        canonicalSha256Omitting(
          next.payload.pending.reservation,
          ["state"],
        ) === canonicalSha256Omitting(pending.reservation, ["state"])
      );
    });
    if (
      candidates.length !== 1 ||
      next.payload.previous_record_hash !== frontier.head_record_hash
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  #maximumTerminalSequence(): number {
    let maximum = 0;
    try {
      for (const entry of readdirSync(this.#terminalSequenceDirectory, {
        withFileTypes: true,
      })) {
        if (/^\.terminal-[0-9a-f-]+\.tmp$/u.test(entry.name)) {
          continue;
        }
        const match = /^(?<sequence>[0-9]{20})\.json$/u.exec(entry.name);
        const sequence = Number(match?.groups?.sequence);
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !Number.isSafeInteger(sequence) ||
          sequence <= 0
        ) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        maximum = Math.max(maximum, sequence);
      }
      return maximum;
    } catch {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  #terminalFileExists(path: string): boolean {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return true;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  #ensureTerminalDirectories(): void {
    for (const directory of [
      this.#terminalDirectory,
      this.#terminalRecordsDirectory,
      this.#terminalIndexDirectory,
      this.#terminalSequenceDirectory,
    ]) {
      try {
        mkdirSync(directory, { mode: 0o700 });
        chmodSync(directory, 0o700);
        const parent =
          directory === this.#terminalDirectory
            ? this.#directory
            : this.#terminalDirectory;
        this.#fsyncDirectoryPath(parent);
      } catch (error) {
        if (!hasErrnoCode(error, "EEXIST")) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
      }
      assertPrivateDirectory(directory);
    }
  }

  #acquireLock(): void {
    if (this.#ownedLock !== null) {
      this.#assertOwnedLock();
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const published = this.#tryPublishLock();
      if (published !== null) {
        this.#ownedLock = published;
        this.#testHooks?.afterLockPublished?.();
        return;
      }
      this.#recoverDeadLock();
    }
    throw new StorageError("STORAGE_UNAVAILABLE", { retryable: true });
  }

  #tryPublishLock(): ObservedRecoveryHeadLock | null {
    const unsignedRecord = {
      payload: RecoveryHeadLockPayloadSchema.parse({
        schema_version: "1.0.0",
        lock_id: `recovery_head_lock:${randomUUID()}`,
        provider_ref: this.#providerRef(),
        process_id: process.pid,
        acquired_at: new Date().toISOString(),
      }),
      authority_key_id: this.authorityKeyId,
      trust_root_version: this.trustRootVersion,
    };
    const record = RecoveryHeadLockRecordSchema.parse({
      ...unsignedRecord,
      signature: this.signProviderValue({
        domain: RECOVERY_HEAD_LOCK_DOMAIN,
        ...unsignedRecord,
      }),
      record_hash: canonicalSha256(unsignedRecord),
    });
    const raw = `${canonicalJson(record)}\n`;
    const temporary = join(
      this.#directory,
      `.head-lock-${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, raw);
      fsyncSync(descriptor);
    } catch {
      throw new StorageError("STORAGE_UNAVAILABLE", { retryable: true });
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }

    try {
      try {
        linkSync(temporary, this.#lockPath);
        this.#fsyncDirectory();
      } catch (error) {
        if (hasErrnoCode(error, "EEXIST")) {
          return null;
        }
        throw new StorageError("STORAGE_UNAVAILABLE", {
          retryable: true,
        });
      }
      const observed = this.#readVerifiedLock(this.#lockPath);
      if (
        observed.raw !== raw ||
        observed.record.payload.lock_id !== record.payload.lock_id
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return observed;
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
        this.#fsyncDirectory();
      }
    }
  }

  #recoverDeadLock(): void {
    const observed = this.#readVerifiedLock(this.#lockPath);
    const liveness = this.#processLiveness(
      observed.record.payload.process_id,
    );
    if (liveness !== "dead") {
      throw new StorageError("STORAGE_UNAVAILABLE", { retryable: true });
    }
    const quarantinePath = `${this.#lockPath}.stale.${observed.record.record_hash.slice("sha256:".length)}`;
    try {
      linkSync(this.#lockPath, quarantinePath);
      this.#fsyncDirectory();
    } catch (error) {
      if (!hasErrnoCode(error, "EEXIST")) {
        throw new StorageError("STORAGE_UNAVAILABLE", {
          retryable: true,
        });
      }
      const quarantined = this.#readVerifiedLock(quarantinePath);
      if (!this.#sameLock(observed, quarantined)) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
    }

    let current: ObservedRecoveryHeadLock;
    try {
      current = this.#readVerifiedLock(this.#lockPath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    const quarantined = this.#readVerifiedLock(quarantinePath);
    if (
      !this.#sameLock(observed, current) ||
      !this.#sameLock(observed, quarantined) ||
      this.#processLiveness(current.record.payload.process_id) !== "dead"
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    unlinkSync(this.#lockPath);
    this.#fsyncDirectory();
    if (existsSync(quarantinePath)) {
      unlinkSync(quarantinePath);
      this.#fsyncDirectory();
    }
  }

  #releaseLock(): void {
    const owned = this.#ownedLock;
    if (owned === null) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const current = this.#readVerifiedLock(this.#lockPath);
    if (!this.#sameLock(owned, current)) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    unlinkSync(this.#lockPath);
    this.#fsyncDirectory();
    this.#ownedLock = null;
  }

  #assertOwnedLock(): void {
    if (this.#ownedLock === null) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const current = this.#readVerifiedLock(this.#lockPath);
    if (!this.#sameLock(this.#ownedLock, current)) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  #readVerifiedLock(path: string): ObservedRecoveryHeadLock {
    const resolved = resolve(path);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        resolved,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const before = fstatSync(descriptor);
      const pathBefore = lstatSync(resolved);
      const expectedOwner = process.getuid?.();
      if (
        !before.isFile() ||
        pathBefore.isSymbolicLink() ||
        before.dev !== pathBefore.dev ||
        before.ino !== pathBefore.ino ||
        realpathSync(resolved) !== resolved ||
        before.size <= 0 ||
        before.size > MAX_RECOVERY_HEAD_LOCK_BYTES ||
        (before.mode & 0o077) !== 0 ||
        (expectedOwner !== undefined && before.uid !== expectedOwner)
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      const raw = readFileSync(descriptor, "utf8");
      const after = fstatSync(descriptor);
      const pathAfter = lstatSync(resolved);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.dev !== pathAfter.dev ||
        after.ino !== pathAfter.ino
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      const record = RecoveryHeadLockRecordSchema.parse(
        JSON.parse(raw) as unknown,
      );
      const unsignedRecord = {
        payload: record.payload,
        authority_key_id: record.authority_key_id,
        trust_root_version: record.trust_root_version,
      };
      if (
        record.authority_key_id !== this.authorityKeyId ||
        record.trust_root_version !== this.trustRootVersion ||
        record.payload.provider_ref !== this.#providerRef() ||
        !verify(
          null,
          Buffer.from(
            canonicalJson({
              domain: RECOVERY_HEAD_LOCK_DOMAIN,
              ...unsignedRecord,
            }),
            "utf8",
          ),
          this.publicKey,
          Buffer.from(record.signature, "base64url"),
        )
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return {
        record,
        raw,
        dev: after.dev,
        ino: after.ino,
      };
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
  }

  #sameLock(
    left: ObservedRecoveryHeadLock,
    right: ObservedRecoveryHeadLock,
  ): boolean {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.raw === right.raw &&
      left.record.record_hash === right.record.record_hash
    );
  }

  #processLiveness(processId: number): "live" | "dead" | "ambiguous" {
    try {
      process.kill(processId, 0);
      return "live";
    } catch (error) {
      return hasErrnoCode(error, "ESRCH") ? "dead" : "ambiguous";
    }
  }

  #providerRef(): string {
    const stat = lstatSync(this.#directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return `provider:${stat.dev}:${stat.ino}`;
  }

  #repairHead(
    expectedHeadHash: string,
    journalState: ProviderState,
  ): void {
    this.#assertOwnedLock();
    const currentHead = ProviderStateSchema.parse(
      JSON.parse(
        readPrivateRegularFile(
          this.#headPath,
          MAX_RECOVERY_PROVIDER_STATE_BYTES,
        ),
      ) as unknown,
    );
    if (currentHead.state_hash === journalState.state_hash) {
      return;
    }
    if (currentHead.state_hash !== expectedHeadHash) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
    this.#writeHead(journalState);
  }

  #writeHead(state: ProviderState): void {
    const raw = `${canonicalJson(state)}\n`;
    if (
      Buffer.byteLength(raw, "utf8") >
      MAX_RECOVERY_PROVIDER_STATE_BYTES
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const temporary = join(this.#directory, `.head-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, raw);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, this.#headPath);
      chmodSync(this.#headPath, 0o600);
      this.#fsyncDirectory();
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    }
  }

  #compactJournal(state: ProviderState): void {
    const recordCount = readPrivateRegularFile(
      this.#journalPath,
      MAX_RECOVERY_PROVIDER_JOURNAL_BYTES,
    )
      .split("\n")
      .filter((line) => line.length !== 0).length;
    if (recordCount <= FileRecoveryHeadProvider.#MAX_JOURNAL_RECORDS) {
      return;
    }
    const temporary = join(
      this.#directory,
      `.journal-${randomUUID()}.tmp`,
    );
    const raw = `${canonicalJson({
      kind: "snapshot",
      previous_state_hash: null,
      state,
      state_hash: state.state_hash,
    })}\n`;
    if (
      Buffer.byteLength(raw, "utf8") >
      MAX_RECOVERY_PROVIDER_JOURNAL_RECORD_BYTES
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, raw);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, this.#journalPath);
      chmodSync(this.#journalPath, 0o600);
      this.#fsyncDirectory();
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    }
  }

  #fsyncDirectory(): void {
    this.#fsyncDirectoryPath(this.#directory);
  }

  #fsyncDirectoryPath(path: string): void {
    const directoryDescriptor = openSync(path, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

export { minimumsFromManifest };

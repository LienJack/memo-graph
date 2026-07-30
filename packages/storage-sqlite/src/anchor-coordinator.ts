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
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  CanonicalHashSchema,
  IdentifierSchema,
  RecoveryAnchorSchema,
  RecoveryMinimumsSchema,
  RecoveryPendingReservationSchema,
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

function readPrivateRegularFile(path: string): string {
  const resolved = resolve(path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    const expectedOwner = process.getuid?.();
    if (
      !stat.isFile() ||
      realpathSync(resolved) !== resolved ||
      (stat.mode & 0o077) !== 0 ||
      (expectedOwner !== undefined && stat.uid !== expectedOwner)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return readFileSync(descriptor, "utf8");
  } catch {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

const SignedPendingSchema = z
  .object({
    reservation: RecoveryPendingReservationSchema,
    authority_key_id: z.string().trim().min(1).max(200),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    record_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

const ProviderStateSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    authority_key_id: z.string().trim().min(1).max(200),
    trust_root_version: z.number().int().positive(),
    current: RecoveryAnchorSchema.nullable(),
    pending: z.array(SignedPendingSchema),
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

type SignedPending = z.infer<typeof SignedPendingSchema>;
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
      if (existing.reservation.state === "reconciled") {
        return {
          reservation: existing.reservation,
          authority_key_id: IdentifierSchema.parse(
            existing.authority_key_id,
          ),
          signature: existing.signature,
        };
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
    this.persist(
      sealState({
        ...state,
        pending:
          next === "reconciled"
            ? state.pending.map((item, itemIndex) =>
                itemIndex === index ? terminal : item,
              )
            : state.pending.filter(
                ({ reservation: item }) =>
                  item.pending_id !== pendingId,
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
    const state = this.load();
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
    return state;
  }
}

export class MemoryRecoveryHeadProvider extends BaseRecoveryHeadProvider {
  #state: ProviderState;

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
}

export class FileRecoveryHeadProvider extends BaseRecoveryHeadProvider {
  readonly #directory: string;
  readonly #headPath: string;
  readonly #journalPath: string;
  readonly #lockPath: string;
  #ownsLock = false;

  constructor(input: {
    directory: string;
    authorityKeyId: string;
    trustRootVersion: number;
    privateKey: KeyObject;
    publicKey?: KeyObject;
    create?: boolean;
  }) {
    super(input);
    this.#directory = resolve(input.directory);
    this.#headPath = join(this.#directory, "head.json");
    this.#journalPath = join(this.#directory, "journal.jsonl");
    this.#lockPath = join(this.#directory, ".head.lock");
    if (input.create === true) {
      if (existsSync(this.#directory)) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      mkdirSync(this.#directory, { mode: 0o700 });
      chmodSync(this.#directory, 0o700);
      const initial = sealState({
        schema_version: "1.0.0",
        authority_key_id: input.authorityKeyId,
        trust_root_version: input.trustRootVersion,
        current: null,
        pending: [],
      });
      this.persist(initial, { kind: "initialized" }, null);
    }
    if (!existsSync(this.#headPath) || !existsSync(this.#journalPath)) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    assertPrivateDirectory(this.#directory);
    readPrivateRegularFile(this.#headPath);
    readPrivateRegularFile(this.#journalPath);
    this.load();
  }

  protected load(): ProviderState {
    try {
      if (existsSync(this.#lockPath) && !this.#ownsLock) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      assertPrivateDirectory(this.#directory);
      const head = ProviderStateSchema.parse(
        JSON.parse(readPrivateRegularFile(this.#headPath)) as unknown,
      );
      const journalLines = readPrivateRegularFile(this.#journalPath)
        .split("\n")
        .filter((line) => line.length !== 0);
      if (journalLines.length === 0) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      let priorHash: string | null = null;
      let journalState: ProviderState | undefined;
      for (const line of journalLines) {
        const record = JSON.parse(line) as {
          previous_state_hash?: unknown;
          state?: unknown;
          state_hash?: unknown;
        };
        journalState = ProviderStateSchema.parse(record.state);
        if (
          record.previous_state_hash !== priorHash ||
          record.state_hash !== journalState.state_hash
        ) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        priorHash = journalState.state_hash;
      }
      if (
        journalState === undefined ||
        head.state_hash !== journalState.state_hash
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return journalState;
    } catch {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  protected persist(
    state: ProviderState,
    journalRecord: unknown,
    expectedStateHash: string | null,
  ): void {
    let lockDescriptor: number;
    try {
      lockDescriptor = openSync(this.#lockPath, "wx", 0o600);
      this.#ownsLock = true;
    } catch {
      throw new StorageError("STORAGE_UNAVAILABLE", { retryable: true });
    }
    try {
      if (expectedStateHash !== null) {
        const current = this.load();
        if (current.state_hash !== expectedStateHash) {
          throw new StorageError("STALE_RECOVERY_HEAD");
        }
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
        writeSync(
          journalDescriptor,
          `${canonicalJson({
            ...journalRecord as object,
            previous_state_hash: expectedStateHash,
            state,
            state_hash: state.state_hash,
          })}\n`,
        );
        fsyncSync(journalDescriptor);
      } finally {
        closeSync(journalDescriptor);
      }
      chmodSync(this.#journalPath, 0o600);

      const temporary = join(this.#directory, `.head-${randomUUID()}.tmp`);
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${canonicalJson(state)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      try {
        renameSync(temporary, this.#headPath);
        chmodSync(this.#headPath, 0o600);
        const directoryDescriptor = openSync(this.#directory, "r");
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      } finally {
        if (existsSync(temporary)) {
          unlinkSync(temporary);
        }
      }
    } finally {
      try {
        closeSync(lockDescriptor);
      } finally {
        try {
          unlinkSync(this.#lockPath);
          const directoryDescriptor = openSync(this.#directory, "r");
          try {
            fsyncSync(directoryDescriptor);
          } finally {
            closeSync(directoryDescriptor);
          }
        } finally {
          this.#ownsLock = false;
        }
      }
    }
  }
}

export { minimumsFromManifest };

# M6 Operational Hardening Claim Map

Source topic:
`/Users/lienli/Documents/work/深度调研/research/memo-graph-m6-operational-hardening`

Run: `RUN20260730-030946-research-m6-operational--94a335`

Research head:
`be839ff9e174a65a9314e5dbff4d32d7828186f3`

## Encryption and key lifecycle

- `CLd7800b773712`: secret admission requires a versioned AEAD envelope,
  unique nonce, authentication tag, `key_id`, and canonical identity/scope AAD
  before the first durable write.
- `CL73fd4683042f`: bounded key states are current, retired,
  revoked/compromised, and unavailable; ambiguous or wrong key state blocks.
- `CLbb8ec011bfa3`: application encryption does not protect a compromised OS
  owner/admin or process memory and does not replace scope, purge, redaction,
  or the supported filesystem policy.

## Backup and restore

- `CL3f0ce0051cf8`: a complete manifest binds database, blobs/ciphertext,
  migrations, every authority frontier, key identity/format, config, and
  environment.
- `CL6807705032ee`: restore uses an empty root, staging, full verification,
  fsync, derived degradation, and one atomic publish.
- `CLf12d8c04b9a2`: restore cannot activate graph, vector, or candidate-only
  learning.

## Capacity and backpressure

- `CL8e0c9b00ab9a`: readiness aggregates disk, database/WAL/backup bytes,
  checkpoint, writer queue, maintenance, frontiers, and key state.
- `CL7312bb54c06e`: admission rejects before a transaction when frozen
  queue/age/headroom/maintenance policy is exceeded; thresholds come from
  Small/Expected evidence rather than universal claims.
- `CL857d548dbc31`: checkpoint busy/log/checkpointed, long-reader WAL growth,
  and post-fault convergence are separate observations.

## Operator contract

- `CL99e3bbf8b243`: health/log/metric/receipt schemas are content-free and
  carry only typed operational metadata and hash/frontier identity.
- `CL71459b758fc5`: human/JSON CLI semantics and exit classes are stable;
  destructive/offline actions require dry-run and explicit confirmation.
- `CL03a110497bbc`: OpenTelemetry is a field-model reference, not a required
  runtime dependency.

## Fault and recovery

- `CLf2852e91988a`: deterministic fault hooks cover migration, canonical
  commit, encryption, rotation, backup, restore, checkpoint, purge, and
  learning rollback.
- `CLf3ff5ffca0e1`: every fault proves old-or-new canonical state,
  receipt/frontier agreement, restart idempotency, and no resurrection.
- `CL7a58147281f4`: SQLite recovery is quarantined salvage and cannot satisfy
  an automatic recovery Oracle or G6.

## G6

- `CL8553ec3a59c2`: manifest binds exact source/tree, lock/native builds,
  platform, schema/config/threshold/fixtures, prior gates, and all reports.
- `CL01da65f3b861`: G6 is a hard-rule conjunction; the first false critical
  rule forces `NO-GO`.
- `CL916f4f0e9b68`: pnpm 10 G6 checks include frozen lock, JSON audit policy,
  lock hash, and approved native scripts; registry failure is blocked.
- `CL01792c174e1f`: M6 is seven independent work units under SQLite authority.
- `CLb8778b7cd39e`: claims remain exact-platform/local-only; graph/vector stay
  `NO-GO` and automatic learning publication stays disabled.
- `CL79a333477d0b`: only one immutable candidate passing encryption, recovery,
  deletion, learning rollback, resource, observability, supply-chain, and
  runbook rules may receive G6 `GO`; supported `NO-GO` closes the gate too.

Full evidence metadata and excerpts remain in the source topic.

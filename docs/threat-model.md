# Local Agent Memory Runtime Threat Model

## Scope

The first release is a single-user, single-machine, local stdio MCP service.
The user is the final authority. Cloud sync, multi-user isolation, and
organizational sharing are outside this model.

## Assets

- raw evidence and content-addressed artifacts;
- memory revisions, scope grants, tombstones, and conflict state;
- derived summaries, relations, indexes, Context slices, and exports;
- idempotency keys, receipts, release pointers, evaluation inputs, and backups;
- local configuration defining the principal and allowed scopes.

## Trust boundaries

```text
User/Codex host
  -> explicit MCP request (untrusted actor/scope claims)
  -> request validation and local-principal binding
  -> canonical SQLite control plane
  -> derived FTS/graph/vector/export/backup consumers
  -> frozen Context returned to the model
```

The operating-system account and host administrator remain outside the
application's protection boundary. A fully compromised user account can read
process memory and local files.

## Threats and required controls

| Threat | Failure | Required control |
| --- | --- | --- |
| Local file disclosure | Another local account reads the ledger/blob/export | Data root `0700`, files `0600`, safe path validation, no permissive fallback |
| Scope leakage | Request self-asserts a different actor/workspace | Bind to configured principal; validate every claimed scope |
| Persisted prompt injection | Imported text becomes a reusable instruction | Preserve imported authority, quarantine procedural/core promotion, require review |
| Projection resurrection | Revoked/deleted value returns from FTS/graph/cache | SQLite lifecycle/tombstone hard filter, projection epochs, rebuild and residual tests |
| Tool replay | Retried mutation creates duplicate effects | Idempotency key plus request hash and durable receipt in one transaction |
| Stale concurrent mutation | Old correction overwrites newer revision | Expected revision and compare-and-swap conflict |
| Purge audit leakage | Audit retains deleted plaintext | Keep identifiers, hashes, decision metadata, and tombstone; remove content/body references |
| Backup rollback | Restore predates tombstone or release frontier | Manifest frontiers; reject or replay forward before serving |
| Log leakage | Diagnostics expose memory content or secrets | Structured metadata only; redact request bodies, content, paths, and tokens |
| Learning overfit | Candidate improves calibration and harms transfer | Three arms, holdout, transfer, quarantine, canary, exact rollback |
| Dependency compromise | SDK/native addon changes behavior | Exact versions, lockfile, approved native scripts, contract/recovery rerun |
| Resource exhaustion | Huge payload/query blocks MCP | Size limits, token budgets, worker isolation, queue/timeout/SQLite limits |

## Data-at-rest posture

For `public`, `internal`, and `personal` local data, the baseline is:

- data root owned by the configured OS user with mode `0700`;
- database, blobs, backups, exports, and quarantine files mode `0600`;
- local filesystem only;
- operating-system full-disk encryption recommended and verified in release
  operations when available.

Application-level encryption is mandatory before admitting `secret` content or
placing any data root/backup on a shared, removable, cloud-synchronized, or
otherwise untrusted volume. Until M6 implements and verifies that mode, secret
content admission must fail closed rather than silently storing plaintext.

Encryption does not replace purge, scope, or log controls. Key storage and
rotation are a separate M6 design decision.

## Residual risk

- The process owner and host administrator can inspect memory and files.
- Codex may receive governed content explicitly placed in a Context slice; the
  runtime cannot retract data already sent to a model provider.
- File deletion on copy-on-write media may not prove physical block erasure.
  The product guarantees logical purge and enumerated residual checks, with
  cryptographic erasure only when application-level encryption exists.
- M0 contracts do not prove M1+ implementation correctness.

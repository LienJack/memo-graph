# M0 Contracts and Replay Corpus — Technical Design

## Boundary

M0 owns compile-time and runtime contracts plus frozen evaluation inputs. It
does not own persistence, MCP server handlers, projection engines, retrieval
ranking, or learning publication.

## Repository shape

```text
packages/contracts/src/
  canonical-json.ts
  common.ts
  memory.ts
  mcp.ts
  receipts.ts
  learning.ts
  index.ts
tests/contract/
fixtures/replay/
docs/{adr,contracts,evaluations}/
docs/threat-model.md
```

The `contracts` package is the single owner of externally persisted and
cross-package payload definitions. Consumers must parse `unknown` once through
its schemas instead of casting payload fields locally.

## Contract model

- Zod schemas provide boundary validation; TypeScript types are inferred from
  those schemas.
- Orthogonal enum dimensions remain separate: abstraction, lifecycle, kind,
  scope, authority, sensitivity, validity, and transform version.
- Cross-field invariants use schema refinements. Examples include live
  projections requiring lineage, purged records carrying no plaintext body,
  and successful mutation results carrying a durable receipt.
- Identifiers, timestamps, hashes, and versions use branded schemas where
  mixing them would create a governance defect.
- MCP responses use a discriminated status union so `NO_MATCH`,
  `POLICY_EXCLUDED`, `DEGRADED`, and `FAILED` cannot collapse into an empty
  result.

## Canonical serialization and hashing

Canonical JSON recursively sorts object keys, preserves array order, rejects
non-JSON values and unsafe integers, and normalizes no semantic values
implicitly. Receipt and fixture hashes are SHA-256 over UTF-8 canonical JSON.
The hash input omits only the record's own hash field and is versioned.

## Replay corpus

The committed manifest exposes case metadata and immutable hashes. Case bodies
live in separate calibration, holdout, and transfer directories. Test and
candidate APIs accept an explicit partition; calibration code is structurally
unable to enumerate holdout or transfer bodies.

Every case declares:

- stable case and scenario identifiers;
- partition and risk family;
- product requirement / acceptance-example anchors;
- input artifact references and expected governed outcome;
- prohibited outcomes such as cross-scope leakage or deleted-value revival;
- content hash and fixture schema version.

## Decision evidence

M0 probes runtime and dependency capabilities and records exact versions in
ADRs. G0 is `GO` only when contracts and fixture gates pass and no open issue
changes SQLite authority, explicit MCP lifecycle, graph projection boundaries,
or candidate-only learning.

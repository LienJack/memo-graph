# ADR 0003: Local Graph Selection Gate

- Status: Accepted gate; no backend selected
- Date: 2026-07-28
- Gate: G0, with implementation decision deferred to G4A

## Decision

Do not add a graph dependency in M0-M3. SQLite relations are the required
baseline. G4A may adopt a maintained local graph backend only when a frozen,
paired replay proves structural value without weakening authority or deletion.

## Required scorecard

Every candidate must be scored on:

- active maintenance and a license compatible with local distribution;
- local-only operation and supported Node/platform bindings;
- temporal property and multi-hop query support;
- transaction, crash, backup, restore, export, and corruption behavior;
- deterministic rebuild from the SQLite ledger;
- versioned nodes/edges with evidence lineage and projection epochs;
- correction, revocation, purge, and tombstone propagation;
- p50/p95 latency, disk growth, memory, install cost, and operational burden.

## Hard invariants

- SQLite remains authoritative for identity, versions, scope, lifecycle,
  evidence, approval, tombstones, release pointers, and receipts.
- Scope and tombstone filters run against SQLite before traversal, and results
  are revalidated after traversal.
- Every returned node or edge drills down to a live SQLite revision and
  evidence root.
- The graph can be deleted and rebuilt without loss of authoritative state.
- `NO-GO` is a complete, releasable outcome.

## Exclusions

Kùzu is not a default candidate for this new project because the upstream
repository is archived. A future scorecard must evaluate products maintained
at G4A execution time instead of freezing a vendor choice in this ADR.

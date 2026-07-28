# Memory Artifact Contract

## Authority layers

| Artifact | Role | Authority rule |
| --- | --- | --- |
| `EvidenceRecord` | Immutable L0 turn, tool result, artifact, feedback, evaluation, or import | Primary record; corrections append evidence |
| `Episode` | Sealed task/session evidence group | References immutable event and artifact hashes |
| `MemoryObject` | Stable logical identity and current lifecycle pointer | Never contains revision history inline |
| `MemoryRevision` | Immutable L1-L3 governed content revision | Later revisions name the predecessor |
| `AdmissionDecision` | Activation, candidate, quarantine, or rejection decision | User confirmation is explicit |
| `RelationRevision` | Versioned derived relation | Requires live evidence and lower-level lineage |

Schemas live in `packages/contracts/src/memory.ts`. Types are inferred from the
schemas; consumers must not maintain parallel interfaces.

## Independent dimensions

- abstraction: L0 evidence, L1 memory, L2 topic/scenario/relation, L3 core;
- lifecycle: working, candidate, active, superseded, revoked, quarantined,
  purged;
- kind: episodic, semantic, procedural;
- scope: thread, topic, scenario, user, workspace, agent;
- authority: user-stated, observed, tool-result, inferred, derived, imported;
- sensitivity: public, internal, personal, sensitive, secret;
- validity: valid-time plus recorded system time;
- transform: named semantic version.

No dimension implies another. A semantic memory is not automatically active;
an L3 projection is not automatically authoritative.

## Enforced invariants

- L0 uses `EvidenceRecord`; `MemoryRevision` begins at L1.
- Non-purged revisions carry content. Purged revisions carry no plaintext or
  blob reference.
- Revision 1 has no predecessor; every later revision names the predecessor.
- L2/L3 projections name lower-level revision lineage.
- Derived claims name evidence roots.
- Revoked, quarantined, and purged objects are ineligible for Context.
- Episode end time cannot precede start time.

## Content storage

Content is either:

- bounded inline text with a media type; or
- a content-addressed blob reference with SHA-256, byte size, and media type.

The contract does not authorize a filesystem write. M1 owns blob persistence
and purge behavior.

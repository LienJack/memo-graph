# MemOS-inspired memo-graph optimization

## Goal

Adopt the useful ingestion boundary from MemOS without weakening memo-graph's
canonical SQLite ledger, L0-L3 semantics, immutable revisions, governance
filters, provenance, or controlled publication. The delivery is intentionally
ordered: first repair the G6 direct-evidence and Runbook gaps, then add one
minimal deterministic EvidenceAdapter vertical slice, and finally qualify the
exact combined candidate with a fresh versioned evidence bundle.

The user value is a simpler, safer way to turn explicit chat turns, tool
results, and text-file bodies into durable L0 evidence. The adapter must not
silently extract or publish long-term memory.

## Confirmed facts

- The former Agent Memory Runtime roadmap and M6/G6 task are archived.
- The recorded G6 result is a supported `NO-GO`, with `integrity` as the first
  non-pass rule. Forty of 43 fault points are blocked because aggregate test
  commands are not direct per-obligation evidence. All eight acceptance
  examples also aggregate their success and failure Oracles. Every frozen
  Runbook step lacks direct CLI observation and typed-result verification.
- The U7 G6 reports and U8 decision are immutable historical artifacts. A
  revisit requires a new candidate and a new evidence bundle; it must not
  rewrite the prior reports or decision.
- SQLite remains the only truth authority. FTS, relations, graph, vector,
  Context, caches, metrics, and exported reports are derived.
- G4A graph and G4B vector remain `NO-GO` and disabled.
- MemOS source/graph evidence is bound to
  `92653cd86e389b844869c1f84fa119ca4328e7c5`. Its reader abstraction is useful,
  but its memory-type taxonomy, direct Dream persistence, general mutation
  hooks, and optional in-place version semantics are not compatible with
  memo-graph authority.
- The user confirmed on 2026-08-02 that G6 remediation must precede the
  EvidenceAdapter vertical slice.

## Requirements

### G6 remediation

- R1. Preserve every legacy U7 evidence and U8 decision artifact byte-for-byte.
- R2. Introduce a versioned rerun layout that binds one explicit candidate,
  fixture set, source set, environment, and exact evidence path set without
  mixing legacy artifacts into the new bundle.
- R3. Represent each of the 43 fault points as one independently executed proof
  obligation. A proof selector may not establish multiple fault claims.
- R4. Represent each M6 acceptance-example success and failure Oracle as its own
  independently executed proof obligation.
- R5. Exercise all ten frozen Runbook automation paths through the built
  operator CLI with concrete private fixtures. Each result must be parsed by an
  owning strict runtime schema, and expected non-zero operator exit classes
  must not be confused with execution failure.
- R6. Evidence reports remain content-free: no memory text, tool bodies,
  secrets, private paths, raw configuration, keys, or captured stdout enters a
  committed report.
- R7. A fresh verifier may claim `pass` only when every hard rule passes for the
  exact final candidate. Otherwise it records the first false or blocked rule
  honestly.
- R8. This task does not sign, install, or enable a production G6 release
  control. Secret admission remains disabled even if the fresh candidate is
  evidence-eligible.

### EvidenceAdapter vertical slice

- R9. Add one explicit proposal-class MCP operation for deterministic
  `conversation_turn`, `tool_result`, and caller-supplied `text_file` bodies.
  The adapter does not read arbitrary filesystem paths.
- R10. The adapter validates `unknown` once through strict shared schemas,
  derives deterministic evidence and episode identities, hashes content,
  seals the episode, and delegates the canonical effect to the existing
  episode-commit path.
- R11. The first slice is `fast_l0` only. It writes immutable L0
  `EvidenceRecord` plus one `Episode`; it creates zero `MemoryCandidate`,
  `MemoryObject`, `MemoryRevision`, admission, learning release, or Core Memory
  records.
- R12. Provenance and authority are never inflated: user turns map to
  `user_stated`, assistant turns to `observed`, tool results to `tool_result`,
  and text-file imports to `imported`. Every mapped authority and exact scope
  must be allowed by the configured local principal.
- R13. Secret plaintext is rejected before persistence. The first slice is
  inline text only, bounded in item count and total content size, with no LLM,
  multimodal parser, binary blob, remote service, Redis, or RabbitMQ
  dependency.
- R14. Same idempotency key plus identical canonical input returns the durable
  original receipt. Reusing the key with changed input returns `CONFLICT`.
- R15. Public output is typed and content-free apart from the existing
  caller-supplied evidence identities; diagnostics never repeat input bodies.
- R16. Existing `memory_episode_commit` remains supported and unchanged for
  callers that already construct canonical artifacts directly.

## Acceptance criteria

- [x] The MemOS capability matrix records adopt/adapt/reject/defer decisions
      with source evidence and memo-graph authority boundaries.
- [x] Legacy G6 U7/U8 artifacts are unchanged, and the new run is isolated in a
      versioned bundle bound to the final candidate commit.
- [x] The fault report contains 43 single-obligation direct proof results and
      all 43 fault points pass.
- [x] All 16 M6 acceptance success/failure proof obligations are independently
      observed and pass.
- [x] All ten Runbook steps report grammar verified, direct automation
      observed, proof passed, and typed result verified from actual CLI runs.
- [x] The new G6 verifier rejects aggregate proofs, reused/ambiguous proof
      selectors, untyped Runbook output, path drift, candidate drift, and
      content-bearing evidence.
- [x] EvidenceAdapter ingests all three supported source variants and returns a
      replayable durable receipt.
- [x] Adapter ingestion creates L0 evidence and an episode only; database tests
      prove there is no candidate, governed revision, or release-pointer side
      effect.
- [x] Exact-scope, authority, secret, size, malformed-input, changed-replay,
      restart, and content-redaction failure cases are covered.
- [x] Existing SQLite-only, explicit MCP, Context Compiler, governance, purge,
      and Learning Lab behavior remains compatible.
- [x] `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, the focused G6
      commands, and the final versioned evidence verifier pass or record an
      honest environment-specific non-pass without weakening any rule.
- [x] No signed/enabling G6 control is produced or installed; secret admission
      remains off.

## Out of scope

- Porting MemOS or replacing memo-graph's memory kernel.
- Fine/LLM extraction, automatic candidate generation, multimodal parsing,
  binary-file ingestion, Dream reflection, or automatic long-term publication.
- Projection-worker poison quarantine, bounded re-drive, CorrectionPlanner,
  MemoryProfile/MemCube, skill extraction, multi-user sharing, or remote sync.
- Graph/vector re-adoption or a new G4 evaluation.
- Redis, RabbitMQ, a graph/vector database, or any cloud memory service.
- Signing or installing a G6 `GO` release control and enabling secret
  admission.

## Open questions

None.

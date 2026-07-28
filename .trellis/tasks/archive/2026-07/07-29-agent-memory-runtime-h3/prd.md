# Agent Memory Runtime H3 bounded recall remediation

## Goal

Close the four G3 `HOLD` blockers in bounded projection search, exact lineage
revalidation, multi-scope frontier composition, and relation truncation
telemetry. Freeze and evaluate a new executable candidate while the accepted
M2 L0/L1 compiler remains the release boundary.

## Authority

1. Product Contract R10, R11, R13-R15, R19-R20.
2. G3 decision and code review in `docs/evaluations/`.
3. H3 requirements in
   `docs/brainstorms/2026-07-29-g3-bounded-recall-remediation-requirements.md`.
4. The accepted M2 fallback and immutable M3 evidence history.

This child does not add or renumber product requirements.

## Requirements

- Apply projection relevance before the returned-candidate limit, or prove
  bounded exhaustion through cursor/truncation evidence.
- Revalidate exactly the canonical source revisions named by returned
  projection lineage; never derive correctness from an arbitrary prefix of
  the scope.
- Freeze one canonical source/projection frontier per principal plus exact
  scope and validate each candidate against its own scope frontier.
- Make every configured search, batch, and relation cap observable through
  typed degradation/truncation reason codes and receipts.
- Preserve governance, no-resurrection, M2 fallback, deterministic ranking and
  token packing, and immutable historical Context behavior.
- Re-freeze a new executable candidate and rerun the original G3 protocol plus
  focused late-match, >1,000-source, multi-scope, and relation-cap regressions.

## Acceptance criteria

- [ ] The only relevant projection after the first unfiltered storage page is
      returned or explicitly reported as truncated/degraded, never clean
      `NO_MATCH`.
- [ ] Projection lineage crossing 1,000 active L1 rows is revalidated by exact
      revision identity without a scope-enumeration cap.
- [ ] Two exact scopes with different frontiers both contribute eligible
      candidates and produce an order-independent frozen Context identity.
- [ ] Relation starts above the configured cap set `truncated` and a stable
      reason code in lane telemetry and the sealed receipt.
- [ ] Incomplete source batches and unavailable search/frontier state fail
      closed with named degradation and safe `recent_l1` fallback.
- [ ] Correction, usage block, revoke, tombstone, purge, replay, and rebuild
      remain correct for every requested scope.
- [ ] Original G3 utility, pollution, governance, budget, rebuild, ablation,
      and accepted-M2 parity assertions remain green.
- [ ] Small and Expected reports cover the corrected end-to-end retrieval
      boundary and do not overclaim production capacity.
- [ ] Full tests, lint, typecheck, build, frozen install, audit, evidence
      hashes, and Trellis validation pass on Node 24.18.0.
- [ ] A new explicit G3 `GO` or `HOLD` names the tested executable commit; no
      downstream child is opened before that decision.

## Out of scope

- Graph, vector, Learning Lab, automatic extraction, remote transport,
  multi-user identity, and M6 operational hardening.
- Ranking or packing retuning unless required by a corrected-candidate
  regression.
- Rewriting historical slices or changing canonical L0/L1 authority.

## Notes

- Research selected deterministic cursor exhaustion for projection relevance
  while retaining storage-native exact-source batch revalidation and
  scope-keyed frontiers. This preserves the current matcher without weakening
  bounded completeness.
- Research, design, implementation checklist, and Trellis context validation
  are complete; task metadata now records
  `implementation_authorized=true`.

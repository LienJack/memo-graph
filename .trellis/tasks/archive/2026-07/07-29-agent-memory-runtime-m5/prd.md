# Agent Memory Runtime M5 Learning Lab

## Goal

Deliver a governed, local Learning Lab that turns replayable task outcomes,
feedback, errors, and capability gaps into the smallest inactive candidate,
then releases it only after protected three-arm evaluation, explicit authority,
bounded canary, and exact rollback. A supported G5 `NO-GO` is complete.

## Product Authority

The sole product requirement numbering is R1-R20 in
`docs/brainstorms/2026-07-28-agent-memory-runtime-requirements.md`. The scoped
M5 interpretation is captured in
`docs/brainstorms/2026-07-29-m5-learning-lab-requirements.md`.

M5 implements R16-R20 and refines Product Contract F4, AE6, and AE7 without
creating another product requirement namespace.

## Confirmed Baseline

- SQLite remains the canonical authority plane.
- G3R `GO` at `6224f782c86712488d416d8101ef7c9fa477c0ae`
  supplies the accepted governed Context Compiler.
- G4A `NO-GO` at `36421f5cd75007a1421d3e0594e7881dd4b864b2`
  keeps SQLite relations as the structural projection.
- G4B `NO-GO` at `3eec7119b1e441d76523d0a57c328d4d811a4af3`
  keeps FTS5, recency, layered projections, and SQLite relations as the
  accepted vector-free retrieval configuration.
- Learning is candidate-only by default and cannot train model parameters,
  edit product code automatically, or approve its own release.

## Requirements

- Record immutable, minimally retained evidence from task outcomes, explicit
  feedback, typed errors, observed gaps, and offline evaluations.
- Bind each trace to its frozen ContextSlice, trajectory provenance, active
  release, accepted retrieval configuration, relevant versions, latency,
  token cost, side effects, and failure class.
- Preserve positive, negative, and conflicting evidence without collapsing it
  into one inferred conclusion.
- Generate the smallest scoped, immutable, inactive, and exactly reversible
  candidate before considering broader behavior, prompt, projection, or Skill
  changes.
- Bind every candidate to its evidence, base release, expected improvement,
  risk, required authority, evaluation contract, and exact rollback target.
- Compare `no_candidate`, `current`, and `candidate` on identical frozen
  calibration, sealed holdout, and transfer cases.
- Keep holdout and transfer answers unavailable to proposal generation and
  calibration; contamination invalidates the run.
- Measure task success, typed error, negative transfer, Context/token cost,
  latency, side effects, scope/privacy violations, and critical regressions
  separately.
- Require measurable candidate gain over `current`, meaningful value over
  `no_candidate`, and zero critical regression.
- Keep candidates quarantined before canary; require independent or explicit
  authority based on risk.
- Publish only by atomically moving a versioned release pointer after a bounded
  canary passes; preserve evaluation, authority, canary, release, monitoring,
  and rollback receipts.
- Pause and resume at a persisted frontier without breaking ordinary governed
  reads or authorized memory writes.
- Reject or roll back on missing evidence, no gain, overfit, negative transfer,
  threshold breach, authority/scope/privacy regression, stale approval, or
  configuration drift.

## Acceptance Criteria

- [ ] A trace without sufficient provenance creates a typed stop receipt and no
      candidate.
- [ ] Proposal and evaluation never change the active release pointer.
- [ ] A bounded declarative candidate is preferred over a broader prompt,
      projection, Skill, or code change.
- [ ] All three arms use identical cases, inputs, readers, tools, budgets,
      retrieval configuration, scorers, and environment.
- [ ] Calibration, holdout, and transfer partitions are immutable and
      contamination is detected.
- [ ] A critical authority, scope, privacy, lifecycle, conflict, tombstone,
      pollution, or rollback regression blocks release regardless of average
      gain.
- [ ] High-impact, sensitive, low-confidence, and long-term preference
      candidates cannot self-approve.
- [ ] Quarantine, canary, release, monitoring, rejection, and rollback are
      explicit states with replayable receipts.
- [ ] Rollback atomically restores the named prior pointer and proves the
      failed candidate no longer affects behavior.
- [ ] Learning pause blocks proposal/evaluation/canary/publication transitions
      while normal governed reads and authorized writes continue.
- [ ] Every evaluation is hash-bound to the tested executable, lockfile,
      corpus, partitions, scorers, thresholds, G4A/G4B decisions, retrieval
      configuration, and environment.
- [ ] G5 records `GO` or a supported `NO-GO`, its limitations, and the active
      rollback target.

## Out of Scope

- Model training, reinforcement learning, fine-tuning, or remote training.
- Automatic product-code, prompt, or Skill publication.
- Reopening graph/vector adoption decisions.
- Multi-user or fleet learning, remote control planes, or production rollout.
- M6 backup, disk-pressure, operational hardening, and release-readiness.
- Article or HTML generation during research without explicit authorization.

## Research Handoff Questions

- What trace schema is sufficient, replayable, and privacy-minimal?
- Which candidate types have an exact reversible M5 publication boundary?
- How should three-arm deltas and protected partitions expose overfit and
  negative transfer?
- What state machine, authority binding, and release pointer prevent
  self-publication and stale approval?
- How should pause/resume and rollback interact with in-flight evaluation and
  canary work?
- Which thresholds and receipts support an honest G5 decision on a local
  synthetic corpus?

## Planning Gate

This is a complex task. Before `task.py start`, M5 must also have:

- a research-to-article RQ/Claim/Evidence handoff;
- `design.md`;
- a complete `implement.md`;
- curated Trellis implement/check context;
- a reviewed final planning summary.

## Notes

- User authorized continuous roadmap implementation.
- Every completed brainstorm, research, plan, implementation, decision,
  archive, and journal unit is committed separately.
- M5 follows
  `ce-brainstorm → research-to-article → ce-plan → ce-work` under Trellis.

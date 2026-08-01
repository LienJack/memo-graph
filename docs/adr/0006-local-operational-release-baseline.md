# ADR 0006: Local operational release baseline

- Status: Rejected for G6 release; hardening retained as local experimental
- Date: 2026-08-02
- Gate: G6

## Decision

Record G6 `NO-GO` for the frozen M6 candidate. Retain the implemented
operational contracts, bounded admission, encrypted secret persistence,
backup/restore, repair, audit, CLI, evidence harness, and runbooks as
experimental mechanisms, but do not qualify them as a released operational
baseline.

The authoritative receipt is
[`g6-decision.md`](../evaluations/g6-decision.md). The only current signed
release control records `NO-GO` and `secret_admission_allowed=false`.

## Why

G6 is a conjunctive first-false gate. Security, resource, supply-chain,
encryption, privacy, and independent code-review evidence pass, but the frozen
verifier reports `first_non_pass=integrity`:

- 40 fault obligations have aggregate rather than direct per-obligation proof
  and remain blocked;
- all ten Runbook proof tests pass, but direct automation execution and typed
  result verification were not observed.

These gaps also prevent deletion, restore, rollback, and binding rules from
passing. An aggregate score or documentation assertion cannot override them.

## Consequences

- SQLite remains the sole authority and ordinary non-secret local operation
  retains the last verified fallback.
- Graph and vector remain disabled under their independent NO-GO decisions.
- Automatic learning publication remains disabled.
- Secret admission remains disabled and standard Context continues to exclude
  secret content.
- No production, fleet, HA, multi-platform, traffic, or SLO claim is made.
- A future G6 attempt requires a new committed candidate, direct fault and
  Runbook automation evidence, a new immutable bundle, and a new signed
  decision. Existing U7 evidence is not rewritten.

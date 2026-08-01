# G6 Local Operational Release Decision

Status: **NO-GO**

Decision date: 2026-08-02

## Decision

Do not qualify the M6 runtime for G6 local operational release. The immutable
verifier reports `state=fail`, `eligible=false`, and
`first_non_pass=integrity`. The signed release control therefore records
`decision=NO-GO` and `secret_admission_allowed=false`.

This is the supported terminal M6 outcome defined by the roadmap. It closes
the milestone without converting implemented hardening mechanisms into a
release or production-readiness claim.

## Frozen identity

- Tested implementation commit:
  `6e2ca601e435c0fa585341c5bdde2c68a12c9e25`
- Tested tree: `589955e07bcf6b16e92f9c48dd51ce1ee3a91d54`
- Tested implementation digest:
  `sha256:0a456f8dea612f9bf97e5b0fc1eca5fdde0dc3a748bde653d47ebb59326f2363`
- U7 evidence commit: `33549e61c73a801fdaca33be54a51d0754790c0b`
- Evidence bundle:
  `sha256:1d6d025934733687cefec12cd97e0c8e8cc3e0c4c7f1acc42bf6af5078f5cb45`
- Runtime identity:
  `sha256:6af775567441db6c8ef791cbbb4e591fa2e5b6a843afb8cf87bb61ea4fb5be77`
- Tested envelope:
  `sha256:703d5750cad6492e43bad2b2a2c153eac830f32f8862840a0ad6290d4832ff66`
- Dependency lock:
  `sha256:bec39249d689cd4274654cf6b026dbd1122041fe9beae6c6116521032a70a5d0`
- Migration set:
  `sha256:f7f68bd98e954829cf98a97aaeda1314e8be134f4aef39a7844e59a8a895214f`
- Configuration:
  `sha256:29d45f91a5730444ed74876d9ab4ae0194e4775e04b2773d14732830357efc2c`
- Exact environment: Node 24.18.0, Darwin arm64, APFS, SQLite 3.53.1,
  single-user/single-root/single-writer/stdio, `g6-small-expected-v1`.

Any runtime, contract, migration, dependency, native output, platform, schema,
configuration, key-authority, fixture, or threshold drift is outside this
tested envelope.

## First-false evidence

The supply-chain, privacy, and encryption rules pass. The security and resource
reports pass, the dependency audit reports zero known vulnerabilities at every
recorded severity, and the independent nine-lens review has zero unresolved
P0/P1 findings.

G6 nevertheless fails conjunctively:

- 40 of 43 fault points remain `blocked`. Their aggregate proof commands cover
  multiple obligations, so the frozen proof-state reducer does not treat them
  as direct per-fault evidence. Consequently the integrity Oracle is false,
  and deletion, restore, rollback, and evidence binding cannot pass.
- All ten Runbook grammar/proof tests pass, but the report records
  `direct_automation_observed=false` and `typed_result_verified=false` for each
  declared operator path. The Runbook family is therefore `blocked`.

No passing metric compensates for these critical false or blocked rules.

## Signed control and capability boundary

[`g6-release-control.json`](./g6-release-control.json) is the only current
control artifact. It is bound to the exact evidence bundle and runtime identity,
signed by the pinned offline `G6DecisionAuthority`, and is audit-only. It cannot
enable secret admission. Unknown, expired, revoked, wrong-key, mismatched, or
candidate-minted controls remain fail-closed.

## Active fallback

The accepted fallback is the last independently verified local core runtime:

- SQLite remains the sole canonical authority.
- G3R layered Context remains the accepted bounded compiler path.
- G4A graph remains `NO-GO`; SQLite relations remain active.
- G4B vector remains `NO-GO`; FTS5/recency/layered recall remains active.
- G5 retains its exact local synthetic governed-learning release/rollback
  mechanism, while automatic learning publication remains disabled.
- Ordinary non-secret governed recall and authorized mutation remain usable.
- Secret admission remains disabled; secret Context remains `SECRET_EXCLUDED`.

Reopening G6 requires a new committed candidate, direct per-fault and Runbook
automation evidence, a new U7 bundle, and a newly signed decision. The immutable
U7 evidence in this decision must not be rewritten.

## Evidence

- [`g6-verification-report.json`](./g6-verification-report.json)
- [`g6-reproducibility-manifest.json`](./g6-reproducibility-manifest.json)
- [`g6-fault-report.json`](./g6-fault-report.json)
- [`g6-runbook-report.json`](./g6-runbook-report.json)
- [`g6-security-report.json`](./g6-security-report.json)
- [`g6-resource-report.json`](./g6-resource-report.json)
- [`g6-supply-chain-report.json`](./g6-supply-chain-report.json)

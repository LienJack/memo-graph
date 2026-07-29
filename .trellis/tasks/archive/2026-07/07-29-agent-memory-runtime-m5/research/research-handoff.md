# M5 Governed Learning Lab Research Handoff

## Research result

Use a governance-first offline Learning Lab:

```text
sealed evidence
  → immutable inactive candidate
  → no_candidate/current/candidate evaluation
  → sealed holdout and transfer
  → explicit authority
  → bounded canary
  → atomic active release pointer
  → monitor or exact rollback
```

This is governed change control, not autonomous self-modification.

## Required implementation consequences

### Evidence

- Expand `LearningTrace` to bind task spec, frozen ContextSlice, ordered
  trajectory evidence, outcome, feedback, errors/gaps, active release,
  accepted retrieval configuration, versions, token/latency cost, side
  effects, and a canonical seal.
- Persist sensitive payloads only when necessary and authorized; otherwise bind
  redacted content or evidence references.
- Candidate generation requires a complete sealed trace.

### Candidate

- Keep every candidate immutable and inactive.
- Support release for scoped memory revisions, declarative procedures, and
  bounded retrieval-policy changes.
- Require stronger authority for prompt/CoreProjection/ScenarioPattern.
- Do not support automatic code/Skill publication or model training.

### Evaluation

- Replace the existing arm vocabulary with `no_candidate`, `current`, and
  `candidate`.
- Freeze and compare common case, partition, task input, ContextSlice, readers,
  tools, model/runtime, retrieval config, budget, scorer, thresholds, and
  seed/split identity.
- Separate task success, errors, negative transfer, Context/tokens, latency,
  side effects, scope/privacy, and governance.
- Treat any critical regression as a hard fail.

### Partitions

- Freeze partition membership and digests before proposal.
- Use calibration for bounded iteration, sealed holdout for unseen release
  evidence, and transfer for a different scenario/scope family.
- Record expected-result visibility and contamination. Leakage or config drift
  invalidates approval.

### State and authority

- Use guarded persisted states:
  `proposed → quarantined → evaluating → approved_for_canary → canary →
  released`, with `rejected` and `rolled_back` terminals.
- `approved_for_canary` is not `released`.
- Reuse current trusted approval infrastructure, but bind release authority to
  candidate, base release, evaluation, principal/tool/scope, request and
  manifest hashes, issuance, expiry, and single consumption.
- Every transition uses expected state/revision and idempotency and appends a
  receipt.

### Canary, pointer, and rollback

- Canary is limited by scope, cases/exposure, duration, and predeclared
  promote/abort metrics.
- Store immutable release versions separately from one active pointer.
- Move the pointer and write previous/current candidate, evaluation,
  authority, canary, and configuration identity in one SQLite transaction.
- Rollback restores the exact named prior pointer, invalidates candidate
  Context/cache, and proves behavior/dependency identity and no resurrection.

### Pause/resume

- Persist learning control epoch, state, reason, timestamp, and frontier in
  SQLite.
- Pause blocks only learning transitions. Governed reads and authorized writes
  continue.
- In-flight evaluation may finish a receipt but cannot publish. Canary freezes
  or aborts under a frozen policy.
- Resume revalidates runtime/config/corpus identity and authority freshness;
  drift requires reevaluation or explicit abandon.

### G5 identity

Every run and decision must bind:

- tested source commit/tree, lockfile, migrations/schema, Node/pnpm/SQLite and
  platform;
- G3R accepted compiler;
- G4A graph `NO-GO` and G4B vector `NO-GO`;
- FTS5/recency/layered/SQLite-relations retrieval configuration;
- corpus, partitions, scorers, thresholds, seeds, reports, approvals, canary,
  and rollback target.

Synthetic evidence proves only the frozen test distribution and gate
mechanics. It does not prove production benefit or M6 readiness.

## Reusable repository mechanisms

- `packages/contracts/src/learning.ts`: provisional trace/candidate/partition/
  eval/pointer schemas; requires M5-specific expansion.
- `packages/contracts/src/mcp.ts`: learning controls are important mutations
  with idempotency and trusted approval.
- `migrations/0004-l1-governance.sql`: candidate/quarantine cannot enter normal
  Context.
- `migrations/0001-evidence-ledger.sql`: append-only mutation receipts and
  idempotency.
- `migrations/0005-tombstone-purge.sql`: single-use approval consumption.
- `packages/mcp-server/src/mutations.ts`: approval manifest identity and
  time-of-effect revalidation.
- `packages/graph-projection/src/benchmark.ts` and
  `tests/helpers/g4b-replay.ts`: common arm identity and separated scoring
  precedents.

## Gate result

- Research Ready Gate: **PASS**
- Questions: 9/9 answered
- Claims: 27/27 supported
- Core Claims: 25/25 supported
- Open/conflicted Claims: 0
- Active runs: 0
- Article/HTML: not generated

Source topic:
`/Users/lienli/Documents/work/深度调研/research/memo-graph-m5-learning-lab`

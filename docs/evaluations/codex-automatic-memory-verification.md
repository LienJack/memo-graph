# Codex Automatic Memory Verification

Status: **NO-GO for balanced fresh-install default**

Decision date: 2026-08-03

## Decision

The automatic-memory implementation is functionally complete behind the
`disabled`, `observe`, and `balanced` modes, but this working tree is not
qualified to change fresh installs from `observe` to `balanced`.

The reproducible local gates pass: capture and replay are idempotent, the four
allowed memory classes activate only through local policy, exclusions never
activate, repository recall is isolated, automatic Context is bounded, secrets
are rejected or redacted before their relevant boundary, and Workbench Undo is
a preview-confirmed governed demotion. The release gate remains conjunctively
false because supported Codex Desktop startup/resume/compact/archive and
multi-window behavior has not been physically verified against a pinned
Desktop build. A passing synthetic suite cannot substitute for that evidence.

## Tested identity

- Base commit: `f2020f14f3815773bf5bd4ba7a7fbfccd98129f2`
- Base tree: `46db5999aa69c1651212b13f5fc527158b1ddc0f`
- Candidate state: uncommitted working tree; not a release identity
- Replay corpus: `automatic-memory-v1`
- Replay corpus SHA-256:
  `657336c5f1c13b3b8069c2e85f817587215bae0fca610a9649697234c00fa603`
- Node.js: 24.18.0
- pnpm: 10.33.2
- Platform used for this run: Darwin arm64
- Provider adapter: `openai_responses`
- Pinned model: `gpt-5.6-luna`
- Prompt, policy, schema, and redaction versions: `1.0.0`
- Recall limits: 8 items, 600 estimated tokens, 8,000 UTF-8 bytes

Any commit, fixture, model, prompt, policy, schema, redaction, migration,
dependency, Codex hook contract, or platform drift requires a new evaluation.

## Gate results

| Gate | Result | Evidence |
| --- | --- | --- |
| Extractor contract | PASS, synthetic | Structured-output provider has no tools, uses `store=false`, rejects malformed output, and never publishes directly. |
| Local governance | PASS | Four allowed bilingual cases activate; every exclusion/risk case has zero effective activation. |
| Scope and recall | PASS | Exact repository scope precedes global user scope; another clone/root is excluded; candidate, sensitive, revoked, and stale memory are excluded. |
| Context pollution | PASS | Automatic Context is content-addressed, marker-bound, replay-stable, and capped at 8/600/8,000. |
| Privacy | PASS for pinned fixtures | Hook secret signals are rejected before L0 persistence; provider requests redact tokens, configured identifiers, and local paths; orchestration/audit rows remain content-free. |
| Reliability | PASS, synthetic | Duplicate capture, generation supersession, lease retry/quarantine, spool restart, host outage, and mutation replay converge without duplicate admission. |
| Capture latency | PASS | Canonical local capture p95 is at or below 100 ms over the pinned 24-event benchmark; provider work is excluded. |
| Recall latency | PASS | Local automatic recall preparation p95 is at or below 200 ms over the pinned replay benchmark. |
| Workbench control | PASS | Chromium verifies lineage visibility and explicit preview-confirm Undo; integration verifies idempotent demotion and immediate `CANDIDATE_ONLY` recall exclusion. |
| Physical Codex Desktop matrix | **BLOCKED** | No pinned-build evidence for resume, compact, archive, trust review, and simultaneous windows. |
| Live provider qualification | NOT RUN | Required CI uses a deterministic fake provider; no conversation payload or live-provider cost evidence was recorded. |

There is no aggregate score. A privacy, cross-repository, high-risk activation,
audit, hot-path, or physical-integration failure cannot be offset by another
passing metric.

The final focused run passed build, lint, root typecheck, 21 automatic-memory
test files / 81 tests, and 6 browser files / 29 tests. Code review also found
and fixed a stale Workbench presentation state: after Undo, the immutable
historical admission remains `activate`, but the view now reads the current
canonical lifecycle, labels the record `已撤销`, and removes the duplicate Undo
action.

The repository-wide `pnpm test` is not fully green in this uncommitted working
tree. Nine residual failures are outside the focused feature result: six
frozen G5/G6 artifact or implementation-digest checks reject the intentionally
dirty candidate identity, one existing operator secret-admission expectation
conflicts with the signed G6 `NO-GO` safety boundary (`KEY_UNAVAILABLE`, exit
70), and two 30-second cases time out only under full-suite concurrency. Those
two timeout files pass serially with 32/32 tests. These residuals are recorded,
not waived, and reinforce that the current tree is not a release identity.

## Reproducible commands

```bash
pnpm build:runtime
pnpm lint
pnpm exec tsc -p tsconfig.json --noEmit
pnpm vitest run \
  tests/replay/automatic-memory-corpus.test.ts \
  tests/replay/automatic-memory-formation.test.ts \
  tests/replay/automatic-memory-policy.test.ts \
  tests/replay/automatic-memory-recall.test.ts \
  tests/integration/automatic-memory-provider.integration.test.ts \
  tests/integration/automatic-memory-runtime.integration.test.ts \
  tests/integration/automatic-memory-benchmark.integration.test.ts \
  tests/integration/codex-automatic-memory.integration.test.ts \
  tests/recovery/automatic-memory-inbox.recovery.test.ts \
  tests/recovery/codex-hook-spool.recovery.test.ts
pnpm vitest run --config vitest.browser.config.ts \
  tests/browser/automatic-memory.browser.test.tsx
pnpm test:web:browser
```

## Active boundary and next gate

Fresh configurations remain `observe`. Users may explicitly select `balanced`
for local evaluation, but that is not a release-default claim. Existing
installations are never silently rewritten.

To reopen the release decision, pin a supported Codex Desktop build and record
packaged startup, trust approval, user prompt, Stop continuation, resume,
compact, archive, restart, and simultaneous-window behavior. Then rerun this
exact corpus, privacy scan, latency suite, packaged installer/rollback tests,
and an opt-in live-provider qualification under the intended provider data
policy.

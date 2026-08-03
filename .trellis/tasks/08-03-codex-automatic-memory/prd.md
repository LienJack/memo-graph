# Codex Automatic Governed Memory

## Goal

Make Codex memory event-driven and low-burden: normal main-thread conversations are captured automatically, qualified preferences/corrections/repository conventions/confirmed decisions become governed memory, and relevant effective memory is recalled on later prompts without requiring the user to say “remember” or invoke MCP.

## Requirements

- Capture UserPromptSubmit and the stabilized final Stop message for every Codex main conversation without depending on model tool choice.
- Keep the synchronous hook path local, bounded, recoverable, and fail-open for Codex.
- Preserve evidence/session/turn/project/time/authority lineage and stable idempotency.
- Reject or redact obvious secrets before local persistence; apply a stricter sensitive-data and local-path screen before remote provider egress.
- Limit v1 automatic long-term formation to stable user preferences, user corrections/negative constraints, repository conventions, and user-confirmed project decisions.
- Send only a minimal redacted conversation window to the configured structured-output provider; never send active memories, complete transcripts, tool logs, file contents, or credentials.
- Treat model output as untrusted candidate input. Existing MemoryRuntime governance remains the only activation authority.
- Apply balanced admission: low-risk/high-confidence may activate silently; medium confidence remains candidate-only; conflict/high-risk/global procedural change requires review or is rejected.
- Separate global user and host-minted repository scopes; unify local Git worktrees, isolate separate clones, and prevent public MCP self-registration.
- Compile bounded effective-memory context on UserPromptSubmit with authorization/lifecycle/sensitivity filters before ranking.
- Preserve immutable revision, correction, demotion, revocation, receipt, and projection-invalidation semantics.
- Add Workbench recent capture, formation explanation, review, health, and governed one-action undo.
- Do not implicitly backfill historical L0 evidence during migration or upgrade.
- Preserve existing explicit MCP behavior and the in-progress managed-bootstrap/Workbench baseline.

## Acceptance Criteria

- [ ] An implicit stable preference can activate and recur in a later Codex task without a memory tool call.
- [ ] A repository convention is recalled in that repository and absent from an unrelated repository; aliases/worktrees follow the documented project identity.
- [ ] Temporary instructions, assistant-only claims, task progress, secrets, and unconfirmed conclusions produce no effective long-term memory.
- [ ] Conflicts, sensitive/high-risk proposals, and global procedural changes do not silently activate.
- [ ] Provider input contains no pinned secrets, configured sensitive identifiers, absolute local paths, active memories, tool logs, or unrelated history.
- [ ] Runtime/provider failure never blocks the Codex prompt or Stop flow; retry/quarantine is observable.
- [ ] Duplicate and concurrently continued Stop events converge to one stabilized turn generation.
- [ ] Automatic recall respects exact scope, lifecycle, validity, revocation, sensitivity, and token/item budgets.
- [ ] Workbench explains capture-to-memory lineage and Undo immediately removes an automatic memory from ordinary recall without deleting history.
- [ ] Local capture p95 is at most 100 ms and local recall preparation p95 is at most 200 ms, excluding provider/Codex generation.
- [ ] Migration creates empty orchestration state and does not form memory from historical L0 evidence.
- [ ] Packaged install preserves existing user hooks/config representation, requires normal Codex trust review, and supports idempotent rollback.

## Notes

- Source requirements: docs/brainstorms/2026-08-03-codex-automatic-memory-requirements.md.
- Executable plan: docs/plans/2026-08-03-001-feat-codex-automatic-memory-plan.md.
- Product code must not be implemented until this task has design.md, implement.md, validation, and in_progress status.

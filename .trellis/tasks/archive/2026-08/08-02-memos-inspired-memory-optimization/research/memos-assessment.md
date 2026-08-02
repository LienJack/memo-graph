# MemOS capability reassessment

## Evidence identity

- MemOS graph/source commit: `92653cd86e389b844869c1f84fa119ca4328e7c5`.
- `origin/main` is one release-CI-only commit ahead; no relevant memory architecture file differs.
- memo-graph HEAD at reassessment: `92c12d479e1621ffa0f884c15e5b23366eec0f29`.
- memo-graph G6 decision: `NO-GO`, first non-pass `integrity`.

## Capability matrix

| MemOS capability | Decision | Adaptation boundary | Evidence |
| --- | --- | --- | --- |
| `MemReader` provider interface and fast/fine ingestion | Adapt | `fast` may only commit immutable L0 Evidence; `fine` may only emit Candidate proposals | `src/memos/mem_reader/base.py`; `factory.py`; `multi_modal_struct.py:957` |
| `MemScheduler` task grouping, status, timing and failure metrics | Adapt selectively | Keep SQLite outbox/lease/idempotency; add typed status and content-free metrics without Redis/RabbitMQ or user-ID labels | `task_schedule_modules/dispatcher.py:603`; `utils/status_tracker.py:14`; `utils/metrics.py:11` |
| Natural-language `MemFeedback` | Adapt | Generate a dry-run correction plan bound to receipt and expected revision; final effect stays in `memory_correct`/`memory_revoke` | `mem_feedback/feedback.py:1084`; memo-graph `packages/memory-kernel/src/index.ts:829,1436` |
| Tool/Skill trajectory extraction | Defer as candidate generator | May propose Procedure/Skill candidates into Learning Lab; must not write files, upload artifacts, delete prior skills or publish automatically | `mem_reader/read_skill_memory/process_skill_memory.py:985` |
| Dream/offline reflection | Reject direct persistence; consider candidate-only later | MemOS Dream creates, updates, merges and archives graph nodes directly; memo-graph may only reuse the reflection idea before governed evaluation | `dream/pipeline/persistence.py:16,175,201,224,258` |
| General plugin hooks | Reject as public mutation surface | Prefer narrow typed ports at EvidenceAdapter and candidate-planner boundaries; arbitrary before/after hooks could bypass authority and receipts | `plugins/hook_defs.py`; `plugins/hooks.py` |
| MemCube load/dump and backend bundle | Defer | A future `MemoryProfile` may bundle configuration only; it must not bundle or replace canonical truth | `mem_cube/general.py:21` |
| User/Cube sharing | Out of scope | Current product remains local single-user; exact scopes already provide the required isolation model | `mem_user/user_manager.py:37,305` |
| Graph/vector-backed conflict and deduplication | Reject | G4A/G4B remain NO-GO; canonical SQLite governance decides eligibility and conflict | `mem_reader/base.py:16`; memo-graph G4A/G4B decisions |
| In-place/version-optional update semantics | Reject | memo-graph immutable revisions and CAS remain unconditional | `configs/mem_reader.py:88`; `mem_feedback/feedback.py:294` |

## Current memo-graph gaps

1. No `EvidenceAdapter` or equivalent staged input normalization contract exists.
2. `memory_episode_commit` and `memory_propose` are correctly separated, but callers must manually bridge them.
3. Projection outbox supports lease, attempts and retry, but lacks terminal poison-job quarantine and a bounded retry policy.
4. `memory_feedback` records governed learning feedback; it does not produce a user-reviewable correction plan.
5. G6 remains `NO-GO`; adding feature surface before integrity/Runbook remediation increases the unqualified envelope.

## Recommended ordering

1. Repair G6 direct per-fault/acceptance proof and typed Runbook automation without rewriting frozen evidence.
2. Add a deterministic chat/tool/text-file-body EvidenceAdapter vertical slice with no LLM or multimodal dependency.
3. Freeze the combined candidate and generate a fresh versioned G6 evidence bundle. Do not sign or install an enabling release control in this task.
4. Defer projection-worker bounded retry/quarantine and CorrectionPlanner to separate tasks.
5. Defer MemoryProfile, multimodal parsing, Skill candidate generation and reflection until the earlier gates pass.

The first two deliverables remain in one task because EvidenceAdapter changes the runtime identity and the final G6 evidence must qualify their combined candidate. The implementation plan nevertheless enforces explicit Gate A/Gate B completion before Adapter runtime work starts.

---
title: Codex Automatic Governed Memory Implementation Plan
type: feat
status: active
date: 2026-08-03
origin: docs/brainstorms/2026-08-03-codex-automatic-memory-requirements.md
deepened: 2026-08-03
---

# Codex Automatic Governed Memory Implementation Plan

## Summary

Extend the managed Codex bootstrap and Workbench runtime with a user-level hook bridge, a durable local capture inbox, model-assisted memory formation, governed admission, and bounded automatic recall. The design reuses SQLite authority, immutable revisions, MemoryRuntime admission, background lanes, and Workbench correction patterns; the remote model receives only a locally redacted and budgeted turn window and can create candidates but can never publish memory directly.

---

## Problem Frame

The current Runtime exposes explicit MCP tools, but capture and recall still depend on Codex choosing those tools. This plan moves the reliable path to Codex lifecycle events while preserving the distinction between raw evidence, candidate memory, effective memory, derived projections, and per-turn context.

---

## Requirements

### Automatic capture

- R1. Cover every Codex main conversation at user-prompt and final-assistant-message boundaries without requiring a special phrase.
- R2. Keep explicit MCP tools as optional control surfaces, not prerequisites for normal capture or recall.
- R3. Keep hook work fast and recoverable; background analysis and provider latency must never delay normal Codex completion.
- R4. Preserve session, turn, canonical working directory, time, speaker, authority, source lineage, and idempotency for every accepted event.

### Memory formation and scope

- R5. Limit v1 automatic long-term formation to stable user preferences, user corrections or negative constraints, repository conventions, and user-confirmed project decisions.
- R6. Exclude temporary instructions, ordinary progress, full tool logs, assistant speculation, unconfirmed conclusions, secrets, and sensitive content from automatic effective memory; reject or redact obvious secrets before persistent capture.
- R7. Base formation on explicitness, future reuse, authority, stability, repeated evidence, behavioral impact, sensitivity, conflict, and temporariness rather than keyword or similarity alone.
- R8. Separate global user and repository scopes; repository facts and decisions default to the canonical working-directory scope.

### Governance and experience

- R9. Apply three outcomes: silently activate high-confidence low-risk memory, retain medium-confidence candidates outside normal recall, and require impact preview plus confirmation for conflicts, sensitive/high-risk changes, or global procedural behavior changes.
- R10. Correct effective memory by immutable successor revision and supersession, never in-place overwrite.
- R11. Avoid per-turn memory prompts; expose recent automatic captures, lineage, scope, status, review, impact, and undo in Workbench.

### Automatic recall

- R12. Compile memory context automatically on every user prompt without requiring Codex to search.
- R13. Apply scope, authorization, lifecycle, validity, sensitivity, provenance, and revocation filters before ranking.
- R14. Enforce item and token budgets with current task, current repository, current topic or scenario, then global preference priority; preserve inclusion and exclusion explanations.

### Feedback and audit

- R15. Record repeated constraints and corrections as missed-capture, missed-recall, conflict, or wrong-memory signals without allowing those signals to publish high-impact memory directly.
- R16. Produce traceable records for capture, formation, admission, confirmation, recall, correction, demotion, retry, and quarantine.

**Origin actors:** A1 (user), A2 (Codex), A3 (memory runtime), A4 (memory operator)

**Origin flows:** F1 (automatic capture and formation), F2 (silent automatic memory), F3 (conflict or high-risk review), F4 (automatic recall and feedback)

**Origin acceptance examples:** AE1 (implicit preference), AE2 (repository isolation), AE3 (scoped override), AE4 (secret exclusion), AE5 (assistant speculation), AE6 (global behavior review), AE7 (missed-recall feedback), AE8 (runtime failure isolation)

---

## Scope Boundaries

- Do not save ordinary task progress, complete tool logs, chain-of-thought, or unconfirmed failure lessons as effective long-term memory.
- Do not give assistant text user authority merely because it appears in a final answer.
- Do not automatically publish Core Memory, system prompts, skills, or global procedural policy.
- Do not make Graph, vector retrieval, or a distributed queue a prerequisite for this feature.
- Do not treat the Codex transcript file format as the primary event contract.
- Do not replace the explicit MCP path; it remains available for inspection and deliberate control.
- Do not expose the provider credential to Codex hooks, Workbench responses, SQLite content, diagnostics, or receipts.
- Do not repair unrelated frozen test failures or restructure the currently active bootstrap and Workbench work.
- Do not assume Codex Desktop can share its internal login credential with memo-graph. Remote formation uses an explicitly configured provider credential.

### Deferred to Follow-Up Work

- Automatic long-term task progress, complete experience learning, procedural prompt optimization, and skill generation require separate product requirements and release gates.
- PostToolUse capture and full tool-result learning are deferred until the four v1 memory types are qualified without them.
- Native plugin packaging, managed enterprise hooks, Windows/Linux physical qualification, and multi-user remote operation remain separate delivery tracks.
- Graph or vector-assisted formation is deferred until replay evidence shows that bounded SQLite retrieval and structured model extraction are insufficient.

---

## Context & Research

### Relevant Code and Patterns

- packages/contracts/src/evidence-adapter.ts and packages/evidence-adapter/src/index.ts establish deterministic L0 evidence adaptation; the current result deliberately reports zero candidates.
- packages/contracts/src/memory.ts, packages/memory-kernel/src/governance.ts, and packages/memory-kernel/src/index.ts already define candidate risk, confirmation, admission, immutable revision, and memoryPropose boundaries.
- packages/runtime-host/src/background-supervisor.ts and packages/runtime-host/src/runtime-factory.ts provide bounded managed lanes, retry/backoff observation, and single-owner Runtime composition.
- packages/storage-sqlite/migrations/0004-l1-governance.sql and packages/storage-sqlite/src/governance-repository.ts provide canonical candidate, decision, conflict, revision, and audit persistence.
- packages/context-compiler/src/hard-filters.ts and packages/memory-kernel/src/recall-orchestrator.ts establish authorization-first recall and context budgeting.
- apps/codex-bootstrap/src/install-contract.ts and apps/codex-bootstrap/src/install.ts are the installation authority for the content-addressed Runtime, Codex registration, private XDG paths, and self-verification.
- apps/memory-workbench-host/src/http/server.ts and apps/memory-workbench-host/src/http/session-authority.ts establish loopback validation, narrow authenticated routes, bounded bodies, and distinct browser authority.
- packages/contracts/src/workbench.ts, packages/memory-kernel/src/workbench-service.ts, packages/storage-sqlite/src/workbench-reader.ts, and apps/memory-workbench-web/src/features/memories/memory-browser.tsx provide the cross-layer Workbench pattern.
- tests/integration/codex-bootstrap-install.integration.test.ts, tests/integration/codex-explicit-loop.integration.test.ts, tests/governance/admission.integration.test.ts, tests/replay/context-pollution.test.ts, and tests/security/secret-content-residual.test.ts are the main characterization anchors.
- The authoritative source worktree already contains uncommitted managed-bootstrap and Workbench changes. Implementation must characterize and preserve them rather than resetting or recreating them.

### Institutional Learnings

- SQLite remains canonical; Graph, FTS, relations, and compiled context are derived and cannot become alternate write authorities.
- L0 capture alone does not produce cross-chat behavior. A bounded formation step must create candidates, and final activation must still pass the governed memory proposal path.
- Corrections, demotions, and revocations must retain immutable history, receipts, provenance, and CAS/idempotency behavior.
- The existing managed background supervisor is the accepted scheduling seam; a new Redis, RabbitMQ, or second daemon would add authority and recovery complexity without evidence.
- Existing evaluation history separates a green feature test from release qualification. Automatic memory expands the privacy, external-provider, hook, and context-pollution envelope and therefore requires a dedicated release decision.

### External References

- [Codex Hooks](https://developers.openai.com/codex/hooks) documents user-level and project-level hook discovery, trust-by-definition hash, concurrent matching hooks, UserPromptSubmit additional context, Stop final-message input, SessionEnd delay, and the unstable transcript convenience field.
- [LangMem Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) separates semantic, episodic, and procedural memories and supports subconscious background formation.
- [LangMem Memory Manager](https://langchain-ai.github.io/langmem/reference/memory/) demonstrates schema-constrained model extraction and explicit insert/update/delete capabilities; memo-graph adopts structured extraction but retains its own admission authority.
- [Mem0](https://github.com/mem0ai/mem0) demonstrates automatic extraction and multi-signal retrieval; its direct algorithm choices are reference inputs, not replacements for local governance.
- [MemOS](https://github.com/MemTensor/MemOS) demonstrates pre-run recall and post-run message capture in agent plugins; memo-graph preserves its existing local authority instead of adopting the service stack.
- [Graphiti](https://github.com/getzep/graphiti) demonstrates episode provenance and temporal invalidation; v1 reuses those principles without adding a graph database.
- [Letta](https://github.com/letta-ai/letta) demonstrates stateful agent memory across local and hosted backends; memo-graph keeps Codex as the task agent and implements memory as a governed sidecar.
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) is the provider boundary for schema-valid extraction. Provider output remains untrusted input and is parsed locally before candidate creation.

---

## Key Technical Decisions

| Decision | Chosen approach | Why |
|---|---|---|
| Codex integration | User-level lifecycle hooks installed by codex-bootstrap | Captures all trusted projects and removes tool-choice dependence |
| Hot path | Local authenticated hook endpoint plus private fallback spool | Supports bounded recall and recoverable capture without remote analysis latency |
| Formation | Locally redacted, budgeted turn window sent to a configured structured-output provider by default | Delivers implicit-memory quality while keeping the remote disclosure explicit and bounded |
| Write authority | Provider creates a typed formation proposal; MemoryRuntime.memoryPropose remains the only admission path | Prevents model output from bypassing risk, conflict, revision, and scope governance |
| Scope | Global user scope plus host-minted repository scopes derived from canonical working roots | Supports all repositories without letting ordinary MCP callers forge arbitrary scope authority |
| Scheduling | New formation lane in the managed BackgroundSupervisor | Reuses leases, retry, quarantine, observations, and single-writer ownership |
| Recall | UserPromptSubmit synchronously compiles active memory only and returns bounded additionalContext | Memory arrives before the model turn without waiting for the provider |
| Undo | Governed demotion from effective memory to retained candidate/history | One action removes recall eligibility without deletion or history loss |

- **Four event roles:** SessionStart warms or reuses the managed host; UserPromptSubmit validates and captures the user event, resolves scope, and returns recall context; Stop captures the final assistant message without continuing the turn; SessionEnd performs advisory flush/cleanup only. PostToolUse is excluded from v1.
- **Hooks never run remote formation:** The hook command performs schema validation, local secret and sensitive-data screening, a bounded local request, and optional private-spool append. The provider is called only by the managed background lane.
- **Two local credentials:** Browser sessions keep their existing authority. Hooks receive a separate least-privilege credential and descriptor that can only submit lifecycle events and request compiled context.
- **Fail-open Codex behavior:** Hook timeouts, host restart, provider outage, invalid provider output, or queue saturation never block the user prompt or force a Stop continuation. Failures produce content-free local diagnostics and retry/quarantine state.
- **Pre-persistence secret boundary:** Obvious credentials are removed or the event is rejected before canonical SQLite or fallback spool persistence. Redaction metadata may retain rule identifiers and offsets, never original secret bytes.
- **Remote disclosure policy:** A second, stricter egress screen removes configured sensitive identifiers and local path details before provider transmission. The provider request contains only the minimum bounded conversation turns needed to disambiguate references such as “确定”, non-sensitive scope labels, and fixed extraction instructions. Active memories, full transcripts, tool logs, file contents, absolute paths, credentials, and unrelated history are excluded; conflict lookup occurs locally after extraction.
- **No implicit credential reuse:** The default provider is enabled when its configured credential reference resolves. Missing credentials produce a visible formation-degraded state while L0 capture, explicit MCP operations, and local recall continue.
- **Provider output is data:** Structured output is validated against the four allowed categories, evidence lineage, scope recommendation, confidence factors, temporal classification, risk, and proposed action. Unknown categories, unsupported evidence, injected instructions, or invalid schemas are quarantined.
- **Authority-aware candidate rules:** User text may support user_stated authority. Assistant text can supply context or observed results but cannot independently establish a preference, correction, repository convention, or confirmed decision.
- **Global preference versus global procedure:** Low-risk presentation and interaction preferences may silently activate in user scope. Anything that changes system policy, tool permissions, Core Memory, prompts, skills, or broad procedural behavior is not a v1 auto-activation and requires review or is rejected.
- **Dynamic workspace authorization:** Repository scope identifiers are minted by a versioned project-identity resolver. Git worktrees that share the same local common Git directory share repository memory; separate clones remain separate by default; non-Git directories fall back to a canonical-root identity. The managed host may resolve and authorize those scopes, while public MCP input cannot self-register them.
- **Idempotent event identity:** Session, turn, event kind, canonical scope identity, content digest, and event generation prevent duplicate hooks, retries, resume events, or spool replay from creating duplicate evidence or candidates.
- **Stop stabilization:** Stop is a snapshot, not proof that no other concurrently running hook will continue the turn. Formation waits for a bounded quiet period or the next user prompt; a later Stop for the same turn supersedes the earlier generation before candidate admission.
- **Explicit automatic-context marker:** Injected context carries a compact provenance/receipt marker so later explicit MCP use can avoid presenting the same compiled context twice. Existing MCP tools remain compatible.
- **Workbench uses canonical state:** Recent-capture and review pages read capture, formation, admission, and recall records through storage and kernel services. The UI does not infer status from model output or derived projections.
- **Progressive rollout:** Land observe-only capture and candidate formation first, enable silent activation only after replay/security gates, then make balanced automatic memory the fresh-install default. Existing installations migrate through the idempotent installer and Codex hook trust review.

---

## Open Questions

### Resolved During Planning

- **May formation use a remote model by default?** Yes. The user selected default model-assisted extraction after local secret and sensitive-data filtering. The provider receives only a minimal conversation window, not existing memories, and cannot publish memory.
- **Can memo-graph reuse the Codex Desktop login?** No such stable contract is assumed. Use an explicit provider credential reference and report a degraded formation state when absent.
- **Where does the automatic path integrate?** User-level Codex hooks installed and verified by the existing bootstrap, not project prompts or agent tool-selection instructions.
- **Should Stop perform model analysis?** No. It only captures the final assistant message; the managed lane performs remote analysis asynchronously.
- **Should SessionEnd be the primary commit event?** No. It may occur after an idle delay and is advisory, so Stop plus turn identity is primary.
- **Should transcript tailing fill gaps?** Not in the normal path. The transcript format is unstable; bounded recovery may use it only as diagnostic evidence behind an explicit compatibility adapter.
- **How are all repository scopes authorized?** A host-owned project-identity registry uses the local Git common directory to unify worktrees, keeps separate clones isolated, and falls back to canonical roots outside Git. It extends the managed local principal internally; the public MCP principal cannot register arbitrary roots.
- **When is a Stop message final enough to form memory?** Treat each Stop payload as a versioned snapshot, delay formation until a quiet-period or next-prompt stabilization point, and supersede any earlier generation when another Stop arrives for the same turn.
- **Does migration form memories from historical L0 evidence?** No. Migration 0020 creates orchestration state only; historical evidence remains unchanged unless a separately approved, versioned backfill is designed and qualified.
- **How is an automatic mistake undone?** Demote the current effective revision through the existing governed mutation path, retain candidate/history/audit state, and remove it from normal recall immediately.
- **Does v1 need graph or vector retrieval?** No. The current bounded compiler and exact scope filters remain the release baseline.
- **How are provider changes controlled?** Provider, model, extraction prompt, schema, redaction policy, and admission profile all carry versions into formation records and replay reports.

### Deferred to Implementation

- Exact provider model identifier: select and pin it from the replay quality, latency, and cost evidence produced in U7; do not silently follow a moving alias.
- Exact turn-window, provider-token, recall-item, and recall-token defaults: choose conservative finite values and record them in the versioned policy after replay and latency measurement.
- Exact Stop stabilization interval: choose a bounded value from physical Desktop continuation tests; generation CAS must still make a late Stop safe after the interval.
- Exact confidence thresholds for each of the four memory types: calibrate from the pinned replay corpus; no threshold may ship without category-specific false-positive evidence.
- Exact obvious-secret detector corpus and high-entropy heuristic: extend existing secret fixtures and prove residual scans and false-positive handling before activation.
- Whether a failed private-spool append should surface a one-line UI warning: default to silent content-free telemetry unless failure-rate evidence shows the user cannot otherwise diagnose lost capture.
- Exact Codex Desktop hook coverage across startup, resume, compact, archive, and multi-window behavior: verify physically against the supported Desktop release before declaring release readiness.

---

## Output Structure

    apps/
      codex-bootstrap/src/
        hook-config.ts
        hook-command.ts
        hook-contract.ts
        hook-spool.ts
        install-contract.ts
        install.ts
      memory-workbench-host/src/
        automatic-memory/
        http/server.ts
      memory-workbench-web/src/features/
        automatic-memory/
    packages/
      contracts/src/automatic-memory.ts
      memory-formation/
        package.json
        tsconfig.json
        src/
          index.ts
          policy.ts
          provider.ts
          redaction.ts
          service.ts
      storage-sqlite/
        migrations/0020-automatic-memory.sql
        src/automatic-memory-repository.ts
    tests/
      contract/automatic-memory.contract.test.ts
      fixtures/automatic-memory-v1.json
      governance/automatic-memory-admission.integration.test.ts
      integration/codex-automatic-memory.integration.test.ts
      recovery/automatic-memory-inbox.recovery.test.ts
      replay/automatic-memory-formation.test.ts
      security/automatic-memory-secret-residual.test.ts

This tree declares responsibility boundaries. Implementation may consolidate small files but must preserve the dependency direction: hook transport and provider adapters depend on governed contracts; neither may become a storage or admission authority.

---

## High-Level Technical Design

> This diagram is directional guidance. The prose requirements and unit boundaries are authoritative.

~~~mermaid
flowchart TB
    C["Codex main conversation"] --> H["User-level hook command"]
    H --> S["Local secret and sensitive-data screen"]
    S -->|"accepted"| I["Authenticated host ingress"]
    S -->|"host unavailable"| P["Private fallback spool"]
    I --> E["Canonical capture inbox and L0 evidence"]
    P --> E
    E --> B["Managed formation lane"]
    B --> M["Structured-output model provider"]
    M --> V["Local schema and policy validation"]
    V --> G["Existing governed memory proposal"]
    G -->|"low risk"| A["Effective memory"]
    G -->|"medium confidence"| Q["Candidate"]
    G -->|"conflict or high risk"| W["Workbench review"]
    A --> R["Bounded context compiler"]
    R --> H
    H --> C
    W -->|"confirm"| A
    W -->|"undo"| D["Governed demotion"]
~~~

The hook's synchronous path ends after local capture acknowledgement and context compilation. Model formation, conflict analysis, admission, projection work, and Workbench updates remain asynchronous.

---

## Implementation Units

~~~mermaid
flowchart TB
    U1["U1 Contracts and policy"] --> U2["U2 Inbox and scope authority"]
    U1 --> U4["U4 Formation and admission"]
    U2 --> U3["U3 Codex hook bridge"]
    U2 --> U4
    U2 --> U5["U5 Automatic recall"]
    U4 --> U6["U6 Workbench review and undo"]
    U3 --> U7["U7 Qualification"]
    U4 --> U7
    U5 --> U7
    U6 --> U7
    U7 --> U8["U8 Rollout and operations"]
~~~

- U1. **Define automatic-memory contracts, policy, and provider boundary**

**Goal:** Establish versioned, strict contracts for hook events, capture outcomes, redaction, formation proposals, provider requests/results, policy decisions, and audit summaries before persistent or remote behavior is added.

**Requirements:** R4-R9, R14-R16

**Origin trace:** F1-F3; AE3-AE6

**Dependencies:** Existing governed memory and context contracts; no implementation-unit dependency

**Files:**
- Create: packages/contracts/src/automatic-memory.ts
- Create: packages/memory-formation/package.json
- Create: packages/memory-formation/tsconfig.json
- Create: packages/memory-formation/src/index.ts
- Create: packages/memory-formation/src/policy.ts
- Create: packages/memory-formation/src/provider.ts
- Modify: packages/contracts/src/index.ts
- Modify: package.json
- Modify: pnpm-workspace.yaml
- Test: tests/contract/automatic-memory.contract.test.ts
- Test: tests/replay/automatic-memory-policy.test.ts

**Approach:**
- Define a discriminated event envelope for SessionStart, UserPromptSubmit, Stop, and SessionEnd with bounded content and stable event identity.
- Define exactly four v1 candidate categories and require evidence references, authority assessment, scope recommendation, temporal classification, risk features, confidence factors, provider/prompt/schema versions, and proposed admission outcome.
- Keep provider output separate from MemoryCandidate. A local policy mapper must validate and translate provider proposals before the existing MemoryCandidate and memoryPropose path can be invoked.
- Define policy modes for observe-only, balanced, and disabled. Balanced is the target fresh-install mode after qualification; observe-only supports rollout without silent activation.
- Define content-free error and health summaries so diagnostics cannot serialize prompt text, memory text, paths, or credentials.

**Execution note:** Contract-first. Freeze representative valid and invalid examples before implementing the provider or persistence layers.

**Patterns to follow:**
- packages/contracts/src/memory.ts for strict Zod schemas and cross-field refinements
- packages/contracts/src/evidence-adapter.ts for bounded adapter inputs and deterministic reports
- packages/contracts/src/learning.ts for versioned candidate-generation and release boundaries

**Test scenarios:**
- Happy path: A stable user preference proposal with user evidence, repository/global scope recommendation, low risk, and complete version metadata parses and maps to a governed candidate.
- Happy path: A user-confirmed project decision may reference a bounded preceding turn so a short confirmation such as “确定” is not treated without context.
- Edge case: An unknown category, unbounded text field, missing evidence, unsupported authority, or impossible temporal range fails schema validation.
- Edge case: A global presentation preference is distinguishable from an excluded global procedural or system-policy change.
- Error path: Provider output requesting direct activation, deletion, skill creation, prompt mutation, or secret retention is rejected or quarantined.
- Replay: Policy version changes produce different recorded decisions without mutating earlier formation records.

**Verification:**
- All automatic-memory boundary objects have finite size constraints and deterministic canonical serialization.
- No provider-facing type can be passed directly to storage admission without a local policy translation.
- Every R5 category and R6 exclusion has at least one frozen contract fixture.

---

- U2. **Add durable capture inbox, workspace scope registry, and recovery**

**Goal:** Persist accepted hook events exactly once, recover canonical jobs safely from crashes, and mint repository scopes from project identity without broadening public MCP authorization.

**Requirements:** R3, R4, R6, R8, R16

**Origin trace:** F1; AE2, AE4, AE8

**Dependencies:** U1

**Files:**
- Create: packages/storage-sqlite/migrations/0020-automatic-memory.sql
- Create: packages/storage-sqlite/src/automatic-memory-repository.ts
- Modify: packages/storage-sqlite/src/migrations.ts
- Modify: packages/storage-sqlite/src/protocol.ts
- Modify: packages/storage-sqlite/src/storage-worker.ts
- Modify: packages/storage-sqlite/src/database.ts
- Modify: packages/storage-sqlite/src/client.ts
- Modify: packages/runtime-host/src/runtime-factory.ts
- Test: tests/storage/automatic-memory-repository.integration.test.ts
- Test: tests/recovery/automatic-memory-inbox.recovery.test.ts

**Approach:**
- Add canonical records for project identity, hook-event receipt and generation, turn pairing/stabilization, formation job state, provider attempt, policy decision, admission link, recall use, and content-free failure.
- Preserve original user and assistant evidence through the existing evidence ledger after local redaction; new tables carry orchestration and lineage rather than replacing the evidence authority.
- Mint workspace scopes only after project identity validation. Share one identity across Git worktrees with the same local common directory, keep separate clones isolated, and use canonical roots for non-Git directories. Bind resolved scopes to the local principal through a managed-host-only authority seam.
- Create migration state empty and forward-only. Do not enqueue or auto-promote historical L0 evidence; any future backfill requires a separately versioned and approved operation.
- Add lease, claim, retry, terminal quarantine, and idempotent acknowledgement semantics compatible with BackgroundSupervisor.
- Define the canonical spool-import/idempotency contract that U3's hook bridge will use after host recovery.
- Treat duplicate UserPromptSubmit/Stop delivery, process restart, imported spool replay, and resumed sessions as replay of the same event identity.

**Execution note:** Migration- and recovery-first. Use crash-point tests before connecting the provider.

**Patterns to follow:**
- packages/storage-sqlite/migrations/0015-operational-hardening.sql
- packages/storage-sqlite/migrations/0019-incremental-recovery-frontier.sql
- packages/storage-sqlite/src/governance-repository.ts
- packages/storage-sqlite/src/root-lease.ts

**Test scenarios:**
- Happy path: User and final-assistant events for one turn are stored once, linked to L0 evidence, and become one claimable formation job.
- Happy path: Two unrelated canonical working roots mint distinct repository scopes under the same local user; a symlink and Git worktrees sharing one common Git directory resolve to one project identity, while a separate clone stays isolated.
- Edge case: Replaying the same hook event, imported spool record, or formation acknowledgement changes no canonical counts and returns the original receipt.
- Edge case: An event containing a detected access token is rejected or redacted before SQLite import; no original token bytes remain.
- Error path: Crash after claim but before provider result allows lease expiry and retry without duplicate evidence.
- Recovery: Restart reclaims interrupted canonical jobs and preserves ordering within a turn without requiring transcript parsing.
- Migration: Opening an existing data root creates automatic-memory tables without scanning, transforming, or promoting historical evidence.

**Verification:**
- Repository scopes are exact and stable, and public MCP calls cannot self-register a workspace.
- At-rest residual scans find no injected secret fixture in canonical, WAL, backup, spool, diagnostic, or receipt artifacts.
- Interrupted jobs recover with bounded retry and deterministic terminal state.

---

- U3. **Install and operate the Codex lifecycle hook bridge**

**Goal:** Make capture and recall event-driven for all Codex main conversations while preserving existing user hooks, Codex trust behavior, and normal task availability.

**Requirements:** R1-R4, R12, R16

**Origin trace:** F1, F4; AE1, AE8

**Dependencies:** U1, U2, completion/characterization of the current managed-bootstrap work

**Files:**
- Create: apps/codex-bootstrap/src/hook-contract.ts
- Create: apps/codex-bootstrap/src/hook-config.ts
- Create: apps/codex-bootstrap/src/hook-command.ts
- Create: apps/codex-bootstrap/src/hook-spool.ts
- Modify: apps/codex-bootstrap/package.json
- Modify: apps/codex-bootstrap/src/install-contract.ts
- Modify: apps/codex-bootstrap/src/install.ts
- Modify: apps/codex-bootstrap/src/cli.ts
- Modify: apps/memory-workbench-host/src/host.ts
- Modify: apps/memory-workbench-host/src/http/server.ts
- Modify: apps/memory-workbench-host/src/lifecycle/artifacts.ts
- Modify: apps/memory-workbench-host/src/lifecycle/launcher.ts
- Modify: packages/contracts/src/workbench-host.ts
- Modify: scripts/install-codex.mjs
- Test: tests/integration/codex-bootstrap-install.integration.test.ts
- Test: tests/integration/codex-bootstrap-deploy.integration.test.ts
- Test: tests/integration/codex-automatic-memory.integration.test.ts
- Test: tests/recovery/automatic-memory-spool.recovery.test.ts
- Test: tests/security/automatic-memory-spool-permissions.test.ts
- Test: tests/security/workbench-http-boundary.test.ts
- Test: tests/fixtures/fake-codex-cli.mjs

**Approach:**
- Extend the content-addressed release with a stable hook-command entry and absolute installed path.
- Use a syntax-aware hook-config editor for the active user representation. Merge memo-graph handlers into an existing hooks.json without replacing unknown descriptions, matchers, handlers, or events. If the user layer has inline config.toml hooks only, update that representation rather than creating a second source; if both representations already exist, preserve both, modify only the selected existing source, and report the pre-existing warning. Detect exact duplicates, create a private backup, and provide idempotent uninstall/rollback.
- Install SessionStart, UserPromptSubmit, Stop, and SessionEnd handlers with finite timeouts and a positive additional-context limit only where Codex supports it.
- Preserve Codex's trust-by-definition behavior. Installation reports that changed hook definitions require review and verifies discovery with the compatible Codex Desktop CLI rather than bypassing trust.
- Add a dedicated hook credential and descriptor separate from browser tickets and MCP proxy credentials. Restrict endpoints to exact loopback host, bounded JSON, event schema, rate limits, and the permitted operations.
- UserPromptSubmit performs one bounded request that acknowledges capture and may return compiled additionalContext. Stop always returns valid non-continuation JSON and never blocks/continues the turn.
- Persist Stop payloads as versioned turn snapshots. A later Stop for the same turn supersedes the earlier snapshot and pushes the formation eligibility point forward so another concurrently running hook cannot cause interim-answer promotion.
- When the host cannot be reached within budget, append the locally screened event to a user-private XDG-state spool with restrictive permissions and finite byte/count rotation, then return success to Codex. On recovery, import through U2's idempotent canonical contract and delete only acknowledged records.

**Execution note:** Characterization-first because installer, host, and tests are already modified in the working tree. Add merge/rollback tests before changing installation behavior.

**Patterns to follow:**
- apps/codex-bootstrap/src/install-contract.ts for portable private paths
- apps/codex-bootstrap/src/install.ts for staged deploy, rollback, and self-verification
- apps/memory-workbench-host/src/http/control-auth.ts for credential proofs
- tests/integration/codex-bootstrap-install.integration.test.ts for fake-home and fake-Codex coverage

**Test scenarios:**
- Happy path: Fresh install adds all handlers, starts/reuses the host, captures a prompt and final answer, and returns bounded context without an MCP tool call.
- Happy path: Upgrade with unrelated existing user hooks preserves them byte-for-semantic-byte, adds memo-graph once, and creates a recoverable backup.
- Happy path: A user with inline config.toml hooks receives the handlers in the same representation and does not gain a new dual-source warning.
- Edge case: Running install twice, changing the content-addressed release, or uninstalling/reinstalling leaves one current handler per event and no stale executable path.
- Edge case: Multiple matching Codex hooks run concurrently; memo-graph does not assume ordering or mutate another hook's output.
- Edge case: Another Stop hook continues a turn after memo-graph has captured the first assistant snapshot; the later Stop supersedes it and only the stabilized generation becomes formation input.
- Edge case: A full or corrupt spool fails open for Codex, quarantines invalid records, records only content-free diagnostics where possible, and never broadens permissions or overwrites an unacknowledged valid record.
- Error path: Host timeout, invalid descriptor, rate limit, malformed hook JSON, unsupported event, or spool failure never blocks the user prompt or creates Stop continuation.
- Security: Browser bearer, MCP credential, and hook credential cannot substitute for one another; cross-origin or oversized hook requests are rejected.
- Integration: Startup, resume, compact, archive, and multi-window events are observed in the physical Desktop matrix and duplicates remain idempotent.

**Verification:**
- A user can converse without saying “remember” and without Codex invoking a memory tool while both turn sides reach the governed capture lifecycle.
- Existing user hooks remain intact and rollback restores the prior file.
- Trust/review state is visible and never bypassed by the installer.

---

- U4. **Implement redacted model formation and governed admission**

**Goal:** Turn captured turns into useful candidates for the four v1 memory types, use the remote model by default when configured, and route every result through local policy and existing governance.

**Requirements:** R5-R10, R15, R16

**Origin trace:** F1-F3; AE1, AE3-AE6

**Dependencies:** U1, U2

**Files:**
- Create: packages/memory-formation/src/redaction.ts
- Modify: packages/memory-formation/src/provider.ts
- Create: packages/memory-formation/src/service.ts
- Modify: packages/memory-formation/src/index.ts
- Modify: packages/runtime-host/src/runtime-factory.ts
- Modify: apps/memory-workbench-host/src/host.ts
- Modify: apps/codex-bootstrap/src/install-contract.ts
- Modify: packages/memory-kernel/src/index.ts
- Test: tests/replay/automatic-memory-formation.test.ts
- Test: tests/governance/automatic-memory-admission.integration.test.ts
- Test: tests/integration/automatic-memory-provider.integration.test.ts
- Test: tests/security/automatic-memory-secret-residual.test.ts

**Approach:**
- Add deterministic local egress screening before any provider call, covering existing secret fixtures, automatic-memory-specific credential and high-entropy cases, configured sensitive identifiers, and local path details.
- Implement the U1 provider port with a first-party OpenAI structured-output adapter while keeping the port narrow enough for a separately qualified provider later. Provider credentials resolve at process startup from a configured secret reference and are never copied into canonical configuration or diagnostics.
- Assemble a bounded turn window from the current turn and only the minimum preceding turn(s) required for referential confirmation. Do not send active memory; retrieve relevant effective memory locally after extraction for conflict and duplicate classification.
- Treat conversation text as untrusted data inside a fixed, versioned extraction instruction. The provider receives no tools and no authority to mutate storage.
- Parse output locally, verify evidence support and category, calculate deterministic policy features, then create a governed candidate and call the existing memoryPropose path.
- Silently activate only policy-qualified low-risk memories. Keep medium-confidence output candidate-only. Mark conflicts, sensitive/high-impact changes, unsupported scope changes, and global procedural behavior as review-required or rejected.
- Store provider/prompt/schema/policy versions, request content digest, redaction summary, token/latency/cost metadata, decision explanation, and resulting candidate/admission IDs without persisting provider secrets.
- On timeout, rate limit, invalid structured output, unsupported claims, or policy-version mismatch, retry with bounded backoff and then quarantine. Never substitute an unreviewed heuristic activation.

**Execution note:** Replay-first with a deterministic fake provider. Enable the live provider only after policy fixtures and secret residual tests are green.

**Patterns to follow:**
- packages/learning-lab/src/candidate-builder.ts for model-output parsing as candidate input rather than release authority
- packages/memory-kernel/src/governance.ts for admission outcomes
- packages/memory-kernel/src/index.ts memoryPropose for canonical activation
- packages/storage-sqlite/src/secret-ingress.ts for secret-boundary discipline

**Test scenarios:**
- Happy path: Implicit stable preference forms from normal language and silently activates with user evidence and the correct scope.
- Happy path: Repository convention and user-confirmed project decision activate only in their canonical repository.
- Happy path: User correction creates a successor/conflict path rather than a duplicate independent fact.
- Edge case: “确定” with a preceding bounded proposal may form a confirmed decision; “确定” without resolvable context creates no memory.
- Edge case: A one-turn request, speculative wording, ordinary task progress, or assistant-only claim creates L0 evidence but no effective long-term memory.
- Edge case: A low-risk global presentation preference may activate, while global procedural/system changes remain review-required or rejected.
- Error path: Prompt injection asking the extractor to reveal secrets, change policy, create a skill, or return an unsupported category is quarantined.
- Error path: Provider timeout, rate limit, malformed schema, or missing credential leaves capture intact, exposes degraded health, and does not activate fallback memory.
- Security: Known and synthetic secrets, configured sensitive identifiers, and absolute local paths never appear in provider request captures; original secret bytes remain absent from canonical artifacts, logs, spool, and resulting memory.
- Governance: Replaying a provider response and admission after restart returns the original candidate/receipt without duplicate activation.

**Verification:**
- The four allowed types pass category-specific replay thresholds and every R6 exclusion has zero automatic activations.
- Provider output cannot bypass memoryPropose, scope authorization, confirmation, conflict, or immutable revision checks.
- Missing or failing provider affects formation only; Codex response, capture, explicit MCP, and recall of existing memory remain available.

---

- U5. **Inject bounded automatic recall on every user prompt**

**Goal:** Supply relevant effective memory to Codex before each main turn, with exact scope isolation, strict budgets, explanations, and no remote provider dependency.

**Requirements:** R2, R8, R12-R16

**Origin trace:** F4; AE2-AE4, AE7, AE8

**Dependencies:** U1, U2, U3

**Files:**
- Create: packages/memory-kernel/src/automatic-recall.ts
- Modify: packages/memory-kernel/src/index.ts
- Modify: packages/context-compiler/src/index.ts
- Modify: packages/context-compiler/src/hard-filters.ts
- Modify: apps/memory-workbench-host/src/http/server.ts
- Modify: apps/codex-bootstrap/src/hook-command.ts
- Modify: packages/mcp-server/src/index.ts
- Test: tests/integration/codex-automatic-memory.integration.test.ts
- Test: tests/integration/layered-recall.integration.test.ts
- Test: tests/replay/context-pollution.test.ts
- Test: tests/replay/automatic-memory-recall.test.ts

**Approach:**
- Resolve the global user scope and exact canonical repository scope from the host-owned registry, then compile against the current user prompt and active task hints already available to the compiler.
- Reuse hard filters before ranking and reject candidate-only, review-required, demoted, revoked, expired, sensitive, unauthorized, or unprovenanced memory.
- Give current repository memory priority over topic/scenario and global preference, while preserving the existing authority and layer ordering.
- Return a compact developer-context envelope through UserPromptSubmit additionalContext with finite item/token/byte limits, a recall receipt marker, and concise provenance labels.
- Record selected and excluded candidate reasons in the canonical recall receipt, but return only selected, non-sensitive context to Codex.
- Keep the synchronous path local. It must not wait for formation, provider calls, projection convergence, Graph, or vector services.
- Mark the MCP resource as automatic-context capable and include the receipt marker so an explicit memory_context_compile call can detect and avoid duplicate presentation.
- Record repeated user constraints or corrections against prior capture/recall receipts as feedback events for later diagnosis and formation, never as direct high-impact activation.

**Execution note:** Extend the existing context-pollution replay before changing hook output.

**Patterns to follow:**
- packages/context-compiler/src/hard-filters.ts
- packages/memory-kernel/src/recall-orchestrator.ts
- packages/contracts/src/receipts.ts
- tests/replay/context-pollution.test.ts

**Test scenarios:**
- Happy path: A repository convention captured in repository A appears in a new A conversation and is absent in repository B.
- Happy path: A global concise-answer preference and a repository-specific detailed-tutorial preference coexist; the more specific applicable memory is ordered first without overwriting the global revision.
- Edge case: Candidate-only, conflicted, demoted, revoked, expired, and sensitive memory is excluded with a recorded reason.
- Edge case: Automatic context plus a later explicit MCP compile does not duplicate the same memory content in one turn.
- Error path: Host unavailable, compiler timeout, invalid scope, or oversized result returns no additional context and never blocks the prompt.
- Performance: Warm and cold local recall stay within the configured timeout, with p95 local preparation at or below 200 ms excluding Codex generation.
- Replay: Adversarial irrelevant memories do not displace current repository constraints within the token budget.
- Feedback: Repetition of an already effective but omitted constraint links to the missed recall receipt rather than creating an unbounded duplicate.

**Verification:**
- Recall works without any Codex memory-tool decision.
- Exact repository isolation and lifecycle filtering hold under replay and restart.
- Hook output never exceeds its configured context limit and contains no sensitive or excluded memory.

---

- U6. **Add Workbench recent capture, review, and governed undo**

**Goal:** Let the operator understand what was captured, why it became memory, where it applies, what needs review, and remove a mistaken automatic activation without deleting history.

**Requirements:** R9-R11, R15, R16

**Origin trace:** F2-F4; AE6, AE7

**Dependencies:** U2, U4, U5

**Files:**
- Modify: packages/contracts/src/workbench.ts
- Modify: packages/storage-sqlite/src/workbench-reader.ts
- Modify: packages/memory-kernel/src/workbench-service.ts
- Modify: apps/memory-workbench-host/src/http/server.ts
- Modify: apps/memory-workbench-web/src/api/client.ts
- Modify: apps/memory-workbench-web/src/api/fixture-api.ts
- Create: apps/memory-workbench-web/src/features/automatic-memory/recent-captures.tsx
- Create: apps/memory-workbench-web/src/features/automatic-memory/formation-detail.tsx
- Modify: apps/memory-workbench-web/src/app/App.tsx
- Modify: apps/memory-workbench-web/src/main.tsx
- Modify: apps/memory-workbench-web/src/styles/workbench.css
- Test: tests/contract/workbench.contract.test.ts
- Test: tests/storage/workbench-reader.integration.test.ts
- Test: tests/integration/workbench-service.test.ts
- Test: tests/integration/memory-workbench-http.integration.test.ts
- Test: tests/browser/memory-workbench.e2e.test.ts
- Test: tests/browser/workbench-shell.browser.test.tsx

**Approach:**
- Add a recent automatic-memory collection ordered by capture/formation time with filters for repository/global scope, category, formation state, admission state, provider/policy version, and retry/quarantine.
- Detail connects the user/assistant evidence, redaction summary, model proposal, deterministic policy explanation, conflict/impact, admission receipt, current revision, and recall uses without presenting derived output as authority.
- Reuse existing correction impact and confirmation patterns for review-required conflicts and high-risk/global changes.
- Implement Undo as an idempotent governed demotion of the current automatically activated revision. It immediately leaves ordinary recall, retains provenance/history, and exposes the receipt and a deliberate later review path.
- Keep raw evidence read-only and visually distinct. Never render a redacted secret placeholder as remembered content.
- Add formation-lane and provider degradation to Runtime Health using content-free counts and reason codes.
- Provide explicit ready-empty, capture-only, provider-missing, retrying, quarantined, review-required, auto-active, demoted, and failed states.

**Execution note:** Contract and service tests before UI; browser test the built application after the current Workbench baseline is stable.

**Patterns to follow:**
- apps/memory-workbench-web/src/features/corrections/correction-panel.tsx
- apps/memory-workbench-web/src/features/memories/memory-browser.tsx
- packages/memory-kernel/src/workbench-service.ts
- tests/governance/workbench-correction-impact.integration.test.ts

**Test scenarios:**
- Happy path: A silently activated preference appears in Recent with source, category, scope, policy explanation, revision, and recall-use history.
- Happy path: One Undo action demotes the current automatic memory, returns a receipt, and removes it from the next recall without deleting evidence.
- Happy path: A conflict/global procedural candidate remains inactive until impact preview and confirmation; confirmation produces a governed revision.
- Edge case: Capture-only and provider-missing states explain why no candidate exists without implying data loss.
- Edge case: Already demoted, superseded, or concurrently corrected memory returns an idempotent/stale result instead of mutating the wrong revision.
- Error path: Workbench session expiry, host restart, provider outage, or projection degradation disables unsafe actions but preserves authoritative status.
- Security: Hook credentials cannot call Workbench routes, browser sessions cannot call hook ingress, and model/provider metadata never reveals credentials or raw request payloads.
- Accessibility: Recent list, detail, review, and undo have keyboard paths, focus recovery, and restrained live announcements.

**Verification:**
- The operator can answer what was remembered, why, where, from which evidence, when it was used, and how it was undone.
- Undo is immediate for recall eligibility, immutable, auditable, and non-destructive.
- High-risk/global changes cannot become effective through the browser without the existing approval authority.

---

- U7. **Build replay, privacy, reliability, and performance qualification**

**Goal:** Prove that automatic memory improves continuity without secret leakage, repository contamination, excessive false activation, or unacceptable Codex latency.

**Requirements:** R1-R16; AE1-AE8

**Origin trace:** F1-F4; AE1-AE8

**Dependencies:** U3, U4, U5, U6

**Files:**
- Create: tests/fixtures/automatic-memory-v1.json
- Create: tests/helpers/automatic-memory-replay.ts
- Modify: tests/replay/automatic-memory-formation.test.ts
- Modify: tests/replay/automatic-memory-recall.test.ts
- Modify: tests/governance/automatic-memory-admission.integration.test.ts
- Modify: tests/integration/codex-automatic-memory.integration.test.ts
- Modify: tests/recovery/automatic-memory-inbox.recovery.test.ts
- Modify: tests/security/automatic-memory-secret-residual.test.ts
- Create: tests/integration/automatic-memory-benchmark.integration.test.ts
- Modify: tests/replay/context-pollution.test.ts
- Modify: tests/fixtures/replay-corpus.fixture.test.ts
- Create: docs/evaluations/codex-automatic-memory-verification.md

**Approach:**
- Pin a bilingual replay corpus across the four allowed types, every R6 exclusion, ambiguous reference, repository/global scope, conflict, correction, secret, provider attack, and context-pollution cases.
- Separate extractor quality, policy/admission quality, recall quality, privacy, reliability, and hot-path latency so one aggregate score cannot hide a safety failure.
- Use a deterministic fake provider for required CI. Add an opt-in live-provider qualification that records provider/model/prompt/schema versions, quality, latency, token use, and cost without committing conversation payloads.
- Measure false activation as the primary safety gate and recall of qualified memories as the usability gate. Report results per memory type and scope, not only globally.
- Inject failures at hook ingress, spool append, claim, provider request/result, policy parse, memoryPropose, recall, Workbench undo, and restart boundaries.
- Scan canonical database, WAL, backups, spool, logs, receipts, fixtures, and provider-request capture for secret residuals.
- Record the pre-existing known/frozen test failures from the managed-bootstrap baseline. New work must not add failures or claim the full suite is green if that baseline remains red.

**Execution note:** Evidence-first release qualification. No default silent activation until all blocking gates pass.

**Patterns to follow:**
- tests/helpers/g4b-replay.ts
- tests/replay/governance-replay.test.ts
- tests/replay/context-pollution.test.ts
- tests/security/secret-content-residual.test.ts
- docs/evaluations/g6-decision.md

**Test scenarios:**
- Acceptance: Reproduce AE1-AE8 end to end from hook input through later Codex prompt context or governed review.
- Quality: Each allowed category has explicit, implicit, contradictory, temporary, and ambiguous examples; false activation remains below the release threshold in every category.
- Scope: Repository A memories never appear in B; canonical aliases resolve to A; global preferences remain available but lose ordering to more specific applicable memory.
- Privacy: All pinned secrets and high-entropy adversarial values are absent from persistent and remote-request artifacts.
- Reliability: Runtime/provider outages, retries, duplicate events, crashes, and restarts converge to one evidence/candidate/admission chain or an observable terminal quarantine.
- Performance: Local capture p95 is at or below 100 ms and local recall preparation p95 is at or below 200 ms, excluding provider and Codex generation.
- Pollution: Irrelevant or stale memories cannot crowd out current-task and repository constraints under the same token budget.
- Physical: Supported Codex Desktop lifecycle events, trust review, restart, resume, compact, archive, and multiple windows match the documented integration behavior.

**Verification:**
- The evaluation document records corpus hash, config versions, environment, known baseline failures, per-gate outcomes, residual risks, and a GO/NO-GO decision.
- Release is NO-GO on any secret residual, cross-repository leak, high-risk auto-activation, unbounded hook failure, or missed immutable audit chain.
- Latency and quality numbers are reproducible from committed fixtures without live provider access.

---

- U8. **Roll out safely and document operation, privacy, and rollback**

**Goal:** Turn the qualified implementation into a low-burden fresh-install default while keeping upgrades, provider setup, hook trust, observation, disablement, and rollback explicit and recoverable.

**Requirements:** R1-R3, R9, R11, R16

**Origin trace:** F1-F4; AE1, AE6, AE8

**Dependencies:** U7 GO decision; stabilized managed-bootstrap baseline

**Files:**
- Modify: README.md
- Modify: docs/operations/mcp-explicit-loop.md
- Modify: docs/operations/memory-workbench.md
- Create: docs/operations/codex-automatic-memory.md
- Modify: docs/evaluations/memory-workbench-verification.md
- Test: tests/integration/codex-bootstrap-install.integration.test.ts
- Test: tests/integration/codex-bootstrap-deploy.integration.test.ts

**Approach:**
- Ship disabled/observe/balanced modes, with fresh qualified installs selecting balanced and upgrades first preserving current behavior until the idempotent installer completes hook merge, provider readiness, and trust guidance.
- Document exactly what is captured locally, what may be sent remotely, the redaction and minimal-window boundary, provider credential requirements and provider-side data policy, retention, audit, undo, disablement, and uninstall.
- Make provider-missing and provider-degraded states visible in Workbench without interrupting every conversation.
- Provide rollback that disables memo-graph handlers or restores the backed-up user hooks file, preserves canonical evidence/history, stops new remote formation, and leaves explicit MCP access available.
- Keep configuration and policy versions in the verification artifact so a later upgrade cannot inherit a GO decision from a different extractor or redaction policy.
- Update the explicit-loop document to describe it as a deliberate fallback/control path and remove claims that automatic context injection is unavailable after the feature is enabled.

**Execution note:** Documentation and installer verification must describe the actual packaged artifact, not the source-tree launch.

**Patterns to follow:**
- apps/codex-bootstrap/src/install.ts
- docs/operations/memory-workbench.md
- .trellis/tasks/08-02-managed-workbench-runtime/verification.md

**Test scenarios:**
- Integration: Fresh qualified install enables balanced mode only after provider/config and hook discovery checks succeed.
- Integration: Upgrade preserves existing hooks and explicit MCP behavior, carries existing canonical memory forward, leaves historical L0 evidence untouched, and creates no automatic formation job without a separately approved backfill decision.
- Edge case: Missing provider credential leaves capture and existing recall operational while Workbench reports formation degraded.
- Error path: Failed upgrade restores the previous hook/config state and does not strand an untrusted executable path.
- Rollback: Disabling automatic memory stops hook capture/recall and remote calls while preserving audit/history and explicit operator recovery.

**Verification:**
- A fresh user can obtain automatic capture and recall after the normal installer and one Codex hook-trust review, without learning a memory command.
- Upgrade and rollback are idempotent and recoverable.
- Operations docs match the shipped paths, security boundary, feature flags, and verified Desktop behavior.

---

## System-Wide Impact

~~~mermaid
flowchart TB
    X["Codex hooks"] --> H["Managed Workbench host"]
    H --> S["SQLite authority"]
    H --> P["Remote formation provider"]
    S --> K["Memory kernel and context compiler"]
    K --> H
    H --> W["Workbench browser"]
    H --> M["Existing MCP proxy"]
~~~

- **Interaction graph:** Codex lifecycle hooks add a new least-privilege ingress to the managed host; the host writes capture orchestration to SQLite, schedules formation, calls the provider, invokes the existing kernel, serves Workbench state, and returns compiled context.
- **Error propagation:** Hook and recall failures fail open to Codex; provider and formation failures retry/quarantine; governance failures remain candidate/review/reject outcomes; Workbench mutations fail closed through existing approval and revision checks.
- **State lifecycle risks:** Duplicate hooks, split user/assistant turns, concurrently continued Stop events, stale leases, spool replay, provider retry, concurrent correction/undo, migration, and host restart can otherwise create duplicate or stale memory. Event generations, stabilization, leases, CAS, idempotency, immutable receipts, and no implicit historical backfill are required at each boundary.
- **API surface parity:** Explicit MCP tools remain compatible. The automatic host endpoint is internal and credential-separated; Workbench gains read/review/demote operations without exposing them as unauthenticated public HTTP.
- **Integration coverage:** Unit tests cannot prove user-level hook merge/trust, real Desktop event coverage, packaged paths, provider privacy, or end-to-end cross-chat recall; U7 and U8 include physical and packaged verification.
- **Unchanged invariants:** SQLite remains canonical, raw evidence remains immutable/read-only, provider output remains untrusted, derived projections remain non-authoritative, only effective memory enters ordinary recall, and the host remains the single managed writer.

---

## Alternative Approaches Considered

- **Improve the MCP prompt and ask Codex to remember proactively:** Rejected as the primary path because capture and recall would still depend on per-turn model tool selection.
- **Tail or parse the full Codex transcript:** Rejected as the primary contract because Codex documents transcript format as unstable and full transcript access expands privacy and duplication risk.
- **Run the model synchronously inside UserPromptSubmit or Stop:** Rejected because provider latency/outage would enter the user-facing hot path and Stop continuation semantics are unsafe for background work.
- **Let the provider update a profile or memory collection directly:** Rejected because it bypasses local authority, evidence, conflicts, immutable revision, confirmation, and audit.
- **Only deterministic keyword rules:** Rejected as the sole extractor because implicit preferences, short confirmations, corrections, and project decisions require contextual interpretation. Deterministic rules remain the local safety and policy layer.
- **Adopt Mem0, MemOS, LangMem storage, or Graphiti as the new authority:** Rejected because the repository already has governed SQLite authority and migration/recovery semantics. Their extraction, background, provenance, and temporal patterns are adopted selectively.
- **Add Redis or a second service for capture jobs:** Rejected because the managed Runtime already provides single-owner background lanes and SQLite-backed recovery.

---

## Phased Delivery

### Phase 1: Observe-only capture foundation

- Complete U1-U3.
- Capture locally, prove scope identity and recovery, and expose content-free health.
- Keep provider formation and silent activation disabled in normal installs.

### Phase 2: Governed formation and automatic recall

- Complete U4-U5 with fake-provider replay first, then configured live-provider evidence.
- Run formation in observe/candidate-only mode before enabling balanced automatic activation.
- Preserve explicit MCP behavior throughout.

### Phase 3: Operator control and release qualification

- Complete U6-U8.
- Require Workbench audit/undo, privacy scans, replay thresholds, latency gates, real Desktop verification, installer rollback, and a documented GO decision.
- Only then select balanced automatic memory for fresh installs.

---

## Success Metrics

- Users obtain qualified cross-chat preferences, corrections, repository conventions, and confirmed decisions without saying “remember” or invoking memory tools.
- Every allowed-type replay case lands in the correct user/repository scope and governance state; every R6 exclusion has zero effective-memory activations.
- Conflicts, high-risk/sensitive candidates, and global procedural changes never silently activate.
- Repository A memory never enters repository B context; specific applicable scope wins ordering over global preference.
- Capture p95 is at or below 100 ms and local recall preparation p95 is at or below 200 ms, excluding provider and Codex generation.
- No pinned secret survives in canonical storage, WAL, backup, spool, log, receipt, Workbench response, or provider-request capture.
- Every effective memory and recall can be traced to event, evidence, scope, policy/provider versions, admission decision, current revision, and later undo/correction.
- Workbench Undo removes mistaken automatic memory from ordinary recall without deleting provenance.

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Remote disclosure exceeds user expectations | Medium | High | Local prefilter, minimal bounded window, explicit docs/config, no transcript/tool logs, provider metadata audit, disable/rollback |
| Secret detector misses a credential | Medium | Critical | Pinned multi-source corpus, pre-persistence and pre-provider scanning, residual scans, fail-closed candidate policy, NO-GO gate |
| Sensitive identifiers or local paths leave the machine | Medium | High | Separate provider-egress redaction, configured sensitive classes, path removal, remote-request fixtures, residual scans |
| Provider retention policy conflicts with local privacy expectations | Medium | High | Do not log raw requests locally, disclose the configured provider policy, support an eligible zero-retention account/endpoint, and keep disable/rollback immediate |
| Model falsely promotes temporary or speculative content | Medium | High | Four-category schema, authority checks, deterministic policy, candidate/review tiers, category-level false-positive gate, undo |
| Model prompt injection alters extractor behavior | Medium | High | Fixed instruction, no tools, structured output, local schema/evidence verification, unsupported-action quarantine |
| Dynamic workspace scopes broaden authorization | Medium | High | Host-minted project registry, Git common-directory and canonical-root rules, managed-only resolver, exact scopes, cross-root tests, no public self-registration |
| Hook latency or failure degrades Codex | Medium | High | No provider in hook, finite timeout/body, fail-open behavior, private spool, p95 gates |
| Existing hooks are overwritten or invalidated | Medium | High | Semantic merge, exact dedupe, private backup, idempotent uninstall, trust guidance, fake-home tests |
| Duplicate lifecycle events create duplicate memory | High | Medium | Stable event identity, unique constraints, idempotent receipts, lease/replay tests |
| Provider unavailable or credentials missing | Medium | Medium | L0 capture and existing recall continue, bounded retry/quarantine, visible degraded health, no heuristic autoactivation |
| Automatic context pollutes or conflicts with task instructions | Medium | High | Hard filters, exact scope, item/token budgets, specificity ordering, receipts, context-pollution replay |
| Current dirty bootstrap baseline obscures regressions | High | Medium | Characterization-first units, preserve user changes, record frozen failures, narrow tests before full qualification |
| Migration unexpectedly forms memory from historical evidence | Low | High | Empty forward-only orchestration migration, no implicit backfill, upgrade assertions, separately approved backfill requirement |
| Codex hook behavior differs across Desktop releases | Medium | High | Pin supported version, packaged physical matrix, trust verification, compatibility gate, transcript-independent design |

---

## Dependencies / Prerequisites

- Stabilize or explicitly baseline the in-progress managed Codex bootstrap and Workbench changes before U3 and U6 modify overlapping files.
- Before U1, create and activate the Trellis task that tracks this plan; task artifacts are execution bookkeeping, not a rollout deliverable in U8.
- Use the repository-pinned Node 24.18.0, pnpm 10.33.2, TypeScript 6.0.3, Vitest 4.1.10, Zod 4.4.3, and React 19.2.8 toolchain unless the active baseline changes first.
- Provide an explicit provider credential reference for live formation; do not depend on Codex internal authentication.
- Pin a supported Codex Desktop/CLI hook version and record trust/config behavior in the verification artifact.
- Preserve the existing data-root backup/recovery authority before applying migration 0020.

---

## Documentation / Operational Notes

- Document the lifecycle as capture locally, apply persistence redaction locally, apply stricter provider-egress redaction locally, form remotely, govern locally, recall locally.
- Explain that the model provider is enabled by default only when its explicit credential resolves; missing credentials do not stop Codex or erase captured evidence.
- Expose policy/provider versions and aggregate token/cost metadata in operator views without exposing raw provider payloads.
- Describe how to inspect and trust hooks, verify capture, disable automatic memory, stop remote formation, undo a memory, restore prior hooks, and retain explicit MCP access.
- Make release documentation distinguish feature implementation, observe-only qualification, balanced-mode GO, and fresh-install default.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-08-03-codex-automatic-memory-requirements.md](../brainstorms/2026-08-03-codex-automatic-memory-requirements.md)
- Related plan: [docs/plans/2026-07-28-001-feat-agent-memory-runtime-plan.md](2026-07-28-001-feat-agent-memory-runtime-plan.md)
- Related plan: [docs/plans/2026-08-02-001-feat-memory-workbench-plan.md](2026-08-02-001-feat-memory-workbench-plan.md)
- Related operations: [docs/operations/mcp-explicit-loop.md](../operations/mcp-explicit-loop.md)
- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [LangMem](https://langchain-ai.github.io/langmem/)
- [Mem0](https://github.com/mem0ai/mem0)
- [MemOS](https://github.com/MemTensor/MemOS)
- [Graphiti](https://github.com/getzep/graphiti)
- [Letta](https://github.com/letta-ai/letta)

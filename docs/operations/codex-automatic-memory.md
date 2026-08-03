# Codex Automatic Memory Operations

## Current rollout state

Automatic capture, model-assisted formation, local governance, bounded recall,
Workbench inspection, and governed Undo are implemented. The current release
decision is `NO-GO` for a silent `balanced` fresh-install default because the
full physical Codex Desktop lifecycle matrix is not yet recorded. Fresh
configuration therefore uses `observe`; upgrades preserve their existing
configuration.

`observe` is useful qualification mode: hooks capture eligible turns locally,
the configured provider may produce proposals, local policy records decisions,
but nothing silently becomes effective memory. Set `balanced` only as an
explicit local evaluation decision. `disabled` stops the automatic capture,
formation, and recall lanes while explicit MCP memory remains available.

## Data path and authority

The lifecycle is:

1. Codex hooks normalize `SessionStart`, `UserPromptSubmit`, `Stop`, and
   `SessionEnd` into bounded events.
2. Obvious secret-shaped prompt or assistant content is rejected before spool,
   HTTP ingress, or L0 persistence. Hook failure remains fail-open for Codex.
3. The managed Runtime stores immutable L0 evidence and content-free capture,
   turn, job, retry, and audit metadata in canonical SQLite.
4. A separate provider-egress pass removes credentials, configured sensitive
   identifiers, high-entropy values, connection strings, and local paths.
5. The remote provider receives only the minimal redacted user/assistant turn
   window. It receives no active memory, transcript, tool log, MCP resource,
   Workbench state, or provider credential in the request body.
6. Provider structured output is untrusted data. Local schema, evidence,
   authority, category, temporariness, conflict, injection, and scope policy
   determine reject, candidate, review, or activation.
7. On the next user prompt, local recall selects only current eligible global
   user and exact-project memory. Repository scope precedes global scope and the
   result is capped at 8 items, 600 estimated tokens, and 8,000 bytes.

SQLite and the memory kernel remain authority. The provider cannot write a
memory, approve a mutation, expand scope, or change system/tool behavior.

## Configuration

Both private MCP and operator configuration must describe the same automatic
memory policy. A provider-enabled evaluation configuration is:

```json
{
  "automatic_memory": {
    "mode": "observe",
    "provider": {
      "enabled": true,
      "kind": "openai_responses",
      "model": "gpt-5.6-luna",
      "api_key_env": "OPENAI_API_KEY",
      "endpoint": "https://api.openai.com/v1/responses",
      "timeout_ms": 20000
    },
    "sensitive_identifiers": []
  }
}
```

`OPENAI_API_KEY` is an explicit provider credential. memo-graph does not reuse
Codex Desktop login or internal authentication. Missing credentials degrade
formation but do not block Codex, erase captured evidence, disable existing
local recall, or disable explicit MCP tools. Provider-side retention and data
handling are properties of the configured account and endpoint; review them
before selecting `balanced`.

Add stable private names, customer identifiers, or local labels to
`sensitive_identifiers` so the egress pass removes them. Do not put secrets in
that array or in JSON configuration.

## Workbench inspection and Undo

Open Memory Workbench and select **自动记忆**. The view exposes content-free
capture/formation state, attempts, quarantine, provider/model and token
metadata, redaction action, local policy reasons, linked scope/revision, and
aggregate recall-use count. Raw conversation evidence remains in the read-only
evidence authority and is not copied into orchestration audit rows.

For an incorrect automatic activation:

1. select **撤销自动召回**;
2. review the impact stating that the current revision will become a candidate
   while history and provenance remain;
3. select **确认降为候选**.

The confirmation is bound to the Workbench session, exact memory/revision,
scope, request hash, expiry, and a one-use approval. It executes the existing
`memory_demote` mutation idempotently. The memory immediately becomes
ineligible for ordinary recall; evidence, revisions, decision audit, and the
mutation receipt are retained.

## Disable and rollback

To stop automatic behavior without deleting history, set `mode` to `disabled`
in both private configurations and relaunch the managed Runtime. This stops new
automatic capture/formation/recall and remote calls. Explicit MCP operations,
canonical evidence, prior audit rows, and governed operator recovery remain.

The installer semantically merges Codex hooks and writes a private backup of
the previous `hooks.json` or TOML representation before change. If a packaged
upgrade fails after registration, it restores the previous MCP registration.
To remove memo-graph hooks entirely, use the installer/uninstall recovery path
for that recorded backup rather than manually deleting another tool's hook
entries.

No migration backfills historical L0 into automatic jobs. Changing from
`observe` to `balanced` affects future stabilized turns only.

## Verification

```bash
pnpm build:runtime
pnpm typecheck
pnpm vitest run tests/replay/automatic-memory-corpus.test.ts
pnpm vitest run tests/integration/codex-automatic-memory.integration.test.ts
pnpm vitest run tests/integration/automatic-memory-benchmark.integration.test.ts
pnpm test:web:browser
```

See `docs/evaluations/codex-automatic-memory-verification.md` for the current
gate result and the physical Desktop evidence still required before changing
the fresh-install default.

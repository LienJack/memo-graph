# Memory Workbench Operations

## Boundary

Memory Workbench is a local management surface for one SQLite-authoritative
memo-graph Runtime. The managed host owns the SQLite writer lease, background
workers, private MCP IPC, loopback HTTP server, and browser sessions. The browser
never opens SQLite and never becomes memory authority.

The four surfaces have different roles:

- **Memory** browses governed, current-effective memory by default and performs
  correction only through sealed preview and explicit confirmation.
- **Graph** reads a bounded SQLite relation/projection view. It does not enable
  the native Graph backend rejected by G4A and cannot edit relationships.
- **Automatic memory** reads capture, formation, policy, admission, retry,
  quarantine, and recall-use audit metadata. Its Undo action uses governed
  preview-confirm demotion and never edits raw evidence.
- **Runtime dashboard** polls content-free health through authenticated GET. It
  has no retry, rebuild, backup, restore, cleanup, rollback, or key action.

This is local experimental software. It trusts the current OS user and does not
claim protection from a hostile process running as the same user.

## Build

Use the pinned workspace runtime:

```bash
source /Users/lienli/.nvm/nvm.sh
nvm use 24.18.0
pnpm install --frozen-lockfile
pnpm build:runtime
```

The management entry is:

```text
apps/operator-cli/dist/cli.js
```

The host package contains the built SPA. Source maps may exist in the web build
directory for development, but the host copies and serves only an exact
`.js`/`.css`/`.woff2` allowlist; it never serves `.map` files or remote assets.

## Operator configuration

Use an absolute, private configuration path outside the repository. A minimal
workbench section looks like this:

```json
{
  "data_root": "/absolute/local/path/memo-graph-data",
  "principal_id": "user_local",
  "workbench": {
    "allowed_scopes": [
      { "kind": "workspace", "id": "workspace_local" }
    ],
    "allowed_authorities": [
      "user_stated",
      "observed",
      "tool_result",
      "inferred",
      "derived",
      "imported"
    ],
    "destructive_tools_enabled": true
  },
  "recovery": {
    "backup_bundles": {},
    "restore_targets": {},
    "authority": null
  }
}
```

`destructive_tools_enabled: true` is required for governed correction. It does
not add dashboard operations or direct evidence editing. Existing roots that
require recovery-head verification must use the established external recovery
authority in `recovery.authority`; otherwise the host may truthfully start as
`health_only` instead of presenting an empty library.

## Start or reuse

Normal launch opens the default browser:

```bash
node apps/operator-cli/dist/cli.js workbench \
  --config /absolute/private/operator.json \
  --format human
```

The launcher serializes startup per canonical root. If the matching host is
already live, it authenticates that instance and reuses it; it does not open a
second SQLite writer. A one-use ticket is placed in the URL fragment, exchanged
for a page-local bearer, and immediately removed from browser history.

To suppress browser opening, run one of:

```bash
node apps/operator-cli/dist/cli.js workbench \
  --config /absolute/private/operator.json \
  --format human \
  --no-open

node apps/operator-cli/dist/cli.js workbench \
  --config /absolute/private/operator.json \
  --format human \
  --headless
```

`--no-open` and `--headless` are mutually exclusive. In either mode the launch
result gives the loopback base URL and prints a one-use launch URL only when
human output is attached to the controlling TTY. Open that launch URL directly;
there is no pairing-code entry flow. The launch URL is not written to JSON,
endpoint metadata, logs, environment variables, or files.

If automatic browser opening fails, open the one-use launch URL printed on the
controlling TTY. If it has expired, rerun the normal command to mint and open a
fresh link. Do not copy an old fragment URL: launch tickets, bearers, and
instance identity expire independently.

## Runtime states

| State | Meaning | Safe response |
| --- | --- | --- |
| `ready` | Canonical Runtime and governed content routes are available. | Use Memory, Graph, and Runtime dashboard normally. |
| `health_only` | The loopback host is inspectable but Runtime authority is blocked. | Read health reasons; fix configuration or recovery authority outside the dashboard, then relaunch. |
| stale page | The page retained an old or disconnected instance. | Do not confirm a draft; relaunch and establish a new browser session. |
| browser failed | Host may be live but no authenticated tab opened. | Open the one-use launch URL printed on the controlling TTY, or rerun the command. |

An unavailable projection does not mean canonical memory is unavailable. The
dashboard deliberately shows canonical storage first, then Runtime ownership,
derived projections, and background work. Each observation includes its scope,
time, state, reason, and read-only guidance.

## Process lifetime and clean shutdown

Closing the browser tab revokes only that page's practical access; it does not
stop the managed host. MCP proxy EOF also does not stop the owner. The host
handles `SIGTERM`/`SIGINT` by revoking sessions, closing HTTP and IPC, draining
bounded work, closing SQLite, and removing only artifacts it still owns.

The v1 operator CLI starts or reuses the host but has no public `stop`
subcommand. Process supervisors and test harnesses must send `SIGTERM` to the
verified endpoint owner rather than killing by name. Do not delete writer locks,
credentials, descriptors, or sockets while that process or its authenticated IPC
endpoint is live.

Runtime metadata is kept in the private per-user temporary directory
`memo-graph-workbench-<uid>`. Endpoint metadata contains identities, paths,
origin, port, and process ID but no browser bearer or launch ticket. Credential
files are mode `0600`; the directory is mode `0700`.

## Safe stale-metadata recovery

Repeated launch performs the supported recovery flow:

1. acquire the bounded per-root launch lock;
2. validate root and configuration identities;
3. authenticate the recorded HTTP and private IPC endpoints;
4. refuse cleanup while either owner is live;
5. quarantine stale owned artifacts only after liveness fails;
6. start one replacement instance and require new credentials.

Use another `workbench` launch for this flow. Do not manually remove the root
writer lease or reuse an endpoint file from another root/configuration.

## Verification commands

```bash
pnpm test:web
pnpm test:web:browser
pnpm test:web:e2e
pnpm exec vitest run \
  tests/security/workbench-http-boundary.test.ts \
  tests/integration/memory-workbench-http.integration.test.ts \
  tests/integration/workbench-host-launch.integration.test.ts \
  tests/recovery/workbench-launcher.recovery.test.ts \
  tests/integration/operator-workbench.integration.test.ts
```

See `docs/evaluations/memory-workbench-verification.md` for the full acceptance
matrix and residual limitations.
Automatic-memory operation and its separate release gate are documented in
`docs/operations/codex-automatic-memory.md` and
`docs/evaluations/codex-automatic-memory-verification.md`.

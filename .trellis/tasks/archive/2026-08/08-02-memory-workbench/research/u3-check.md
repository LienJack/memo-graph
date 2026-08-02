# U3 Managed Runtime Host Check

Checked on 2026-08-02 with Node.js 24.18.0 and pnpm 10.33.2.

## Verified invariants

- Direct stdio remains the default adapter and preserves the existing MCP tool/resource surface, diagnostics discipline, mutation receipts, replay, and one-writer lease behavior.
- Managed stdio is a framing-only proxy over mutually authenticated private Unix IPC. Attach failure serves typed health-only MCP and never opens a fallback SQLite owner.
- The handshake binds protocol, host instance, full root identity (canonical hash, device, and inode), and configuration identity. A root replaced at the same path is rejected.
- Multiple proxies share one Runtime/storage owner. Proxy EOF closes only that session; delayed session attachment during host shutdown cannot leak a transport handle.
- IPC credential, descriptor, socket, and Runtime directory use restrictive local permissions. Host close removes only owned artifacts, zeroes mutable credential buffers, and still revokes endpoint artifacts when Runtime close reports an error.
- Pending handshakes and active IPC sessions share a bounded admission cap; capacity is released after disconnect.
- Snapshot cursors are HMAC-bound to the host, hashed session identity, query, compact snapshot identity, offset, and expiry. Count/member/byte/TTL eviction, restart/session invalidation, duplicate-ID accounting, and maximum accepted identity lengths are covered.
- Managed supervision includes writer lease, FTS, consolidation, configured Graph, configured vector, and injected lanes with one-lane-at-a-time default concurrency, backoff observations, terminal state, and shutdown drain.
- FTS and consolidation attempt limits, retry timestamps, and terminal counts are durable across Runtime restart. Graph/vector repositories expose durable retrying versus terminal backlog counts; their existing claim limits remain authoritative.
- Managed Graph recall and projection borrow one lazy retryable Graph store manager. Borrowers cannot close the shared child, and a failed first startup does not permanently latch the Runtime unavailable.

## Reviewer findings resolved

The independent correctness and security reviews confirmed seven defects that were fixed before closure:

- full root device/inode identity was missing from the authenticated transcript;
- shutdown failure could bypass credential and endpoint revocation;
- concurrent pending handshakes were not globally bounded;
- a session handle could finish attaching after disconnect/host close and leak;
- maximum accepted identities could exceed the public cursor bound;
- duplicate snapshot IDs could corrupt retained resource accounting;
- FTS, Graph, and vector managed background behavior lacked durable/supervised closure.

Both reviewers also identified stale endpoint cleanup and pathname-replacement cleanup races. Those require the per-root bootstrap arbitration lock and authenticated liveness probe specified for U4; U3 deliberately does not delete an endpoint it did not create. They remain explicit U4 release blockers rather than being weakened into PID- or pathname-only cleanup.

## Passing gates

- Root runtime build, including contracts, storage, memory-kernel, Graph, vector, runtime-host, MCP, and operator CLI.
- Root TypeScript check.
- Root ESLint and `git diff --check`.
- Direct/managed MCP, lifecycle, snapshot, FTS, consolidation, Graph, and vector matrix: 14 files, 76 tests passed in the final focused run.
- Durable FTS terminal test: eight failed attempts persist their future `available_at`, survive restart, and stop being claimed.
- Durable consolidation terminal test: sixteen failed attempts survive restart, publish terminal backlog counts, and stop being claimed.
- Real managed proxy tests cover two concurrent child processes, shared mutation/read state, health-only attach failure, stdout-safe diagnostics, and owned artifact cleanup.

## U4 handoff

- Serialize deterministic descriptor/key/socket publication and removal under the per-root launch lock.
- Reuse only after an authenticated liveness probe matches instance, full root identity, config, and protocol.
- Quarantine stale artifacts only after a failed probe and identity-stable revalidation; never delete on PID or a single pathname `lstat` result.
- Keep browser bearer/ticket authority cryptographically and operationally separate from the U3 IPC credential.

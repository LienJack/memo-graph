# Baseline Verification

- Branch: `codex/memory-workbench`
- Baseline commit: `30497dacb8ad4348c0b4b6a90d1eb952f027610e`
- Required runtime: Node `v24.18.0`, pnpm `10.33.2`
- Date: 2026-08-02

The first probe inherited Node `v26.3.0`, outside the repository engine range, and produced two `StorageError: the storage request is invalid` failures in `tests/mcp/governance-mutations.integration.test.ts` and `tests/security/graph-content-residual.test.ts`.

Both failed tests passed after selecting the pinned Node 24 runtime. The complete workbench baseline selection then passed:

- 38 test files passed
- 237 tests passed
- contract, governance, MCP, operator-health parity, Graph projection/recall/replay/recovery, and Graph content-residual coverage included
- duration: 22.29 seconds after a successful Node 24 runtime build

All implementation and verification commands for this task must explicitly select Node 24.18.0 before invoking pnpm.

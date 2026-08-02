# Backend Directory Structure

## Scope

This repository is a pnpm workspace. Cross-package persisted/RPC payloads are
owned by `packages/contracts`; runtime behavior belongs in a package named for
one responsibility.

## Current layout

```text
packages/
  contracts/
    src/
      canonical-json.ts
      common.ts
      memory.ts
      mcp.ts
      receipts.ts
      learning.ts
      replay.ts
      index.ts
  evidence-adapter/
    src/
      index.ts
tests/
  contract/
  fixtures/
  helpers/
fixtures/replay/{calibration,holdout,transfer}/
docs/{adr,contracts,evaluations}/
```

`packages/evidence-adapter` owns pure, deterministic normalization from
explicit supported sources into canonical L0 `EvidenceRecord` and `Episode`
artifacts. It must not depend on storage, MCP, projections, governance, or
learning packages. Operator JSON result schemas and evidence-ingest schemas
remain owned by `packages/contracts`.

## Contracts package rule

- One runtime Zod schema owns each external or persisted payload.
- Export the inferred TypeScript type from the same module.
- Decode `unknown` at the package boundary. Consumers must not redeclare a
  payload interface or cast fields locally.
- `index.ts` re-exports the public surface; internal helpers stay unexported.

Example:

```ts
export const RecallRequestSchema = z.object({
  request_id: IdentifierSchema,
  token_budget: z.number().int().positive(),
});

export type RecallRequest = z.infer<typeof RecallRequestSchema>;
```

## Future package boundaries

The accepted architecture reserves separate packages for MCP adaptation,
memory control-plane behavior, SQLite storage, Context compilation, optional
graph/vector projection, learning, and observability. Do not place storage or
MCP behavior in `packages/contracts`.

## Naming

- Source files use lowercase kebab-case.
- Schemas use `PascalCaseSchema`.
- Inferred types use the same name without `Schema`.
- Tests end in `.contract.test.ts`, `.fixture.test.ts`, or the later
  integration/recovery/security suffix matching their suite.
- ADRs use zero-padded sequence numbers.

## Forbidden

- Database repositories, migrations, transport startup, and runtime data under
  `packages/contracts`.
- A generic `utils.ts` containing unrelated helpers.
- A second payload type definition in a consumer.
- Runtime state committed under `data/`.

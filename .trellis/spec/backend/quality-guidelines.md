# Backend Quality Guidelines

## Scenario: Cross-Package Runtime Contracts

### 1. Scope / Trigger

Use when adding or changing a persisted artifact, RPC/MCP payload, receipt,
enum, fixture schema, canonical hash rule, or cross-package status.

### 2. Signatures

The owner exports both:

```ts
export const PayloadSchema = z.object({ ... }).strict();
export type Payload = z.infer<typeof PayloadSchema>;
```

Canonical identities use:

```ts
canonicalJson(value: unknown): string
canonicalSha256(value: unknown): `sha256:${string}`
```

### 3. Contracts

- TypeScript 6 strict ESM/NodeNext on Node 24 LTS.
- Runtime schemas, not handwritten interfaces, own cross-layer payloads.
- Zod objects are strict; cross-field rules use `superRefine`.
- Orthogonal memory dimensions stay in separate enums.
- Canonical JSON sorts keys, preserves array order, and rejects non-JSON,
  unsafe numeric, sparse, symbolic, accessor, and non-enumerable input.
- Exact dependency versions and the pnpm lockfile are part of Gate evidence.
- Only `better-sqlite3` and pinned `esbuild` may run dependency build scripts.

### 4. Validation & Error Matrix

| Invalid input | Expected behavior |
| --- | --- |
| Unknown object key | Schema parse failure |
| Invalid enum combination | Cross-field schema issue |
| L2/L3 without lineage | Parse failure |
| Purged revision with content | Parse failure |
| Later revision without predecessor | Parse failure |
| Context over token budget | Parse failure |
| Sparse/non-finite/unsafe canonical value | `CanonicalJsonError` |
| Receipt hash mismatch | Integrity failure |

### 5. Good / Base / Bad Cases

- Good: add one schema, inferred type, public export, positive test, and negative
  invariant test.
- Base: extend an existing enum only after searching all exhaustive mappings,
  docs, fixtures, and tests.
- Bad: add a local interface and cast persisted JSON with `as Payload`.

### 6. Tests Required

- `pnpm test:contract`: schemas, invariants, MCP SDK/SQLite probes, hashes.
- `pnpm test:fixtures`: manifest/body hashes, coverage, partition isolation.
- `pnpm lint`: no debug code, suppressions, `any`, or non-null assertions.
- `pnpm typecheck`: root tests plus contracts package.
- `pnpm build`: emitted ESM and declarations.
- New public functions require direct positive and failure assertions.

All G0 commands run under the pinned Node 24 runtime.

### 7. Wrong vs Correct

#### Wrong

```ts
interface Receipt {
  id: string;
  status: string;
}

const receipt = JSON.parse(raw) as Receipt;
```

#### Correct

```ts
const ReceiptSchema = z.discriminatedUnion("kind", receiptVariants);
const receipt = ReceiptSchema.parse(JSON.parse(raw) as unknown);
```

## Review checklist

- No duplicate constants, enums, or payload field extraction.
- No circular dependency among contract modules.
- Every derived artifact points to source identifiers.
- Tool safety maps and status reducers are exhaustive.
- Tests would fail if the feature/invariant were removed.
- Docs distinguish declared targets from measured production evidence.
- `git diff --check` and Markdown fence checks pass before commit.

# H3 bounded recall research handoff

## Research identity

- Topic: `memo-graph-h3-bounded-recall`
- Run: `RUN20260729-055003-h3-bounded-recall-and-fr-58b9c8`
- Fixed source commit:
  `cd50bfdc399f22eb196bd67c835e63bc6fa9ec4f`
- Research workspace:
  `/Users/lienli/Documents/work/深度调研/research/memo-graph-h3-bounded-recall`
- Scope: H3 only; no graph, vector, Learning Lab, or M6 implementation.

## Direct conclusion

The four G3 `HOLD` findings form one correctness boundary across storage,
recall, Context identity, and receipts. H3 must:

1. preserve the existing normalized lexical matcher while proving candidate
   exhaustion with deterministic cursor paging;
2. validate the exact source revisions named by each returned projection;
3. persist and freeze one frontier per principal plus exact scope; and
4. make every pre-return cap observable as typed truncation/degradation.

The accepted M2 L0/L1 compiler remains the release fallback until a new
executable candidate passes G3R. Historical U7 evidence remains immutable.

## Decision refinement

The brainstorm selected storage-native relevance-before-limit as the initial
default and retained cursor exhaustion as an alternative. Fixed-commit
research refines the implementation choice to cursor exhaustion:

- the current relevance definition is JavaScript NFKC, locale folding, and
  all-token substring matching over projection text;
- introducing FTS or a persisted normalized search column would add indexing,
  migration, tokenizer, and semantic-equivalence work that is not required to
  close H3;
- a stable storage cursor preserves the existing matcher and can prove
  exhaustion without creating a new search authority;
- a configured scan ceiling keeps work bounded, but hitting it must produce
  `DEGRADED`/`TRUNCATED`, never clean `NO_MATCH`.

This satisfies the Product Contract alternative: relevance before the return
limit **or** explicit bounded exhaustion with truncation evidence.

## Claim/Evidence index

| Claim | Result | Evidence | Implementation consequence |
|---|---|---|---|
| H3-C001 | `LIMIT` precedes JavaScript relevance matching. | C0b330ea229b2, Cc6bda4e08f22, C799d30b03f80 | Page before final return limit; add late-match regression. |
| H3-C002 | Current query cannot prove exhaustive `NO_MATCH`. | C0b330ea229b2, Cc6bda4e08f22, C799d30b03f80, Wca4ac88e9863 | Add cursor, exhaustion, examined count, and truncation state. |
| H3-C003 | Cursor exhaustion is the smallest compatible bounded repair. | C0b330ea229b2, Cc6bda4e08f22, Wca4ac88e9863 | Keep matcher semantics; no FTS/search-authority change in H3. |
| H3-C004 | Consolidation can see 100,000 rows while recall sees 1,000. | Cb3e7183c6e69, C6ffd507e8413, Cecd3cf3f3ff4 | Delete prefix-derived online source frontier. |
| H3-C005 | Exact lineage needs one typed result per requested revision. | C14b54c3999ab, Cecd3cf3f3ff4, C6ffd507e8413 | Add exact-ID storage worker batch in one snapshot. |
| H3-C006 | Freshness and exact lineage are separate checks. | C14b54c3999ab, Cecd3cf3f3ff4 | Read persisted scope frontier; validate candidate lineage exactly. |
| H3-C007 | Multi-scope candidates currently share one scalar frontier. | C8f35fba5eb5c, C9cf4821abcfe, Cf2eb8301adbf, C1afe1010befb | Bind every candidate to its own scope frontier. |
| H3-C008 | Persisted projection frontier is also a global singleton. | Cb78167e8fec3, C42370b24e791 | Runtime-only fix is insufficient. |
| H3-C009 | Scope-keyed persisted frontier state is required. | Cb78167e8fec3, C42370b24e791, C305e7b23eb06 | Add migration `0011` and repository access. |
| H3-C010 | New Context needs canonical scoped frontiers and legacy replay. | C9cf4821abcfe, C1afe1010befb, C305e7b23eb06 | Introduce a versioned frontier union; keep V1 parser/replay. |
| H3-C011 | Candidate/frontier binding and epoch consistency are required. | C8f35fba5eb5c, Cf2eb8301adbf, C1afe1010befb | Canonical sort/hash; degrade or retry cross-scope epoch mismatch. |
| H3-C012 | Relation starts are silently sliced before traversal. | C164d8994e386, C6a1ded2c364e, C9365f8f7ccc4, C38a3764f745f | Surface caller truncation and merge it with repository truncation. |
| H3-C013 | Every cap needs typed counts and reason codes. | C38a3764f745f, C9365f8f7ccc4, C164d8994e386, C6a1ded2c364e | Extend telemetry and sealed receipt without overclaiming coverage. |
| H3-C014 | Frozen G3 corpus misses all four defect classes. | C7ef802e52364, C949c59c39990 | Add focused failing-before/passing-after fixtures. |
| H3-C015 | G3R needs a new candidate plus full original gates. | C7ef802e52364, Cbcec4403a211, C949c59c39990 | Re-freeze; do not edit old U7 evidence. |
| H3-C016 | All four repairs are one coordinated gate. | C0b330ea229b2, C6ffd507e8413, C8f35fba5eb5c, Cb78167e8fec3, C164d8994e386, C7ef802e52364, Cbcec4403a211 | No downstream gate opens before explicit G3R `GO`. |

All 16 claims are `supported` and `core`. The only web evidence used for a
core conclusion is the official SQLite SELECT processing semantics archived as
`Wca4ac88e9863`; the design remains primarily fixed-commit code research.

## Correctness invariants

### Projection search

- Cursor order is stable and total, using persisted fields plus
  `projection_revision_id` as a tie-breaker.
- `limit` means returned relevant candidates, not storage rows examined.
- `NO_MATCH` requires `exhausted=true`.
- `scan_ceiling_reached=true` implies typed degradation, examined/eligible/
  retained counts, and safe L1 fallback.

### Exact lineage

- Input IDs come only from the candidate's persisted projection lineage.
- The worker returns exactly one result per distinct requested source revision
  from one synchronous SQLite snapshot.
- Missing, revoked, tombstoned, usage-blocked, superseded, or scope-mismatched
  sources exclude that projection with a stable reason.
- No source payload is copied into the derived plane.

### Scope-local frontier

- Persisted key is principal plus normalized exact scope dimensions.
- Every projection batch updates only its scope row; a different scope cannot
  overwrite it.
- New Context frontiers are canonically sorted by scope key before aggregate
  hashing.
- Every projection candidate records or carries enough scope identity to
  select exactly one frontier.
- Cross-scope reads that do not share a consistent ledger/tombstone epoch
  retry or degrade explicitly.
- Legacy scalar-frontier slices remain parseable and replayable as issued.

### Truncation and receipts

- Projection pages, scan ceiling, exact-source batch, relation starts, and
  relation fanout each expose configured limit and observed counts.
- Caller-side relation truncation and repository fanout truncation are
  distinct stable reason codes.
- A receipt cannot claim clean exhaustion when any contributing lane is
  incomplete.

## Storage and contract boundary

The next migration is `0011`. It should introduce scope-keyed frontier state
without deleting the existing singleton during H3. The singleton may remain as
aggregate/backward-compatible health state, but online scope correctness must
not read it as a scope frontier.

The Context contract should be versioned rather than mutating the meaning of
the existing scalar `ProjectionFrontier`. A practical shape is a discriminated
V1 scalar frontier plus V2 scoped frontier set. V2 identity includes the
canonical scope ordering, each scope frontier, ledger/tombstone epochs, and an
aggregate hash. Exact field names remain a design task; the invariant is not
negotiable.

## Failure Oracles

| Fixture | Failure before H3 | Passing Oracle after H3 |
|---|---|---|
| Late relevant row | Clean `NO_MATCH` after first limited prefix. | Row is returned, or scan ceiling emits named degradation; never clean `NO_MATCH`. |
| More than 1,000 sources | Valid projection is rejected by partial frontier. | Exact named ancestors validate independent of scope population. |
| Two exact scopes | One scope frontier is reused or overwritten. | Both contribute eligible items; request-order permutations seal to one identity. |
| More than 100 relation starts | Starts disappear without explanation. | Telemetry and receipt include truncation counts and stable reason. |
| Correction/tombstone in one scope | Aggregate frontier hides or leaks change. | Only affected descendants are excluded; unrelated scope remains eligible. |
| Legacy frozen Context | New parser changes old identity or rejects replay. | V1 slice replays byte-for-byte under its original semantics. |

## G3R verification matrix

- Focused H3 tests for each Failure Oracle above.
- Original G3 utility, pollution, governance, budget, rebuild, ablation, and
  accepted-M2 parity.
- Full repository tests, lint, typecheck, and build on Node `24.18.0`.
- Frozen `pnpm install --frozen-lockfile` and production dependency audit.
- Small and Expected resource/performance reports at the corrected end-to-end
  retrieval boundary.
- Immutable manifests and hashes bound to the new executable candidate.
- Explicit G3R `GO` or `HOLD`; M4A, M4B, and M5 remain blocked on `HOLD`.

## Research stop condition

RQ001-RQ006 are covered. Remaining uncertainty is implementation behavior and
benchmark outcome, which must be resolved by H3 tests and G3R rather than more
pre-implementation research.

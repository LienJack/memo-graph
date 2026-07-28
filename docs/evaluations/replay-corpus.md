# Frozen Replay Corpus

- Corpus version: 1.0.0
- Fixture schema: 1.0.0
- Frozen: 2026-07-28
- Hash: SHA-256 over canonical JSON v1

## Partitions

| Partition | Cases | Permitted use |
| --- | ---: | --- |
| Calibration | 5 | Contract development and baseline tuning |
| Holdout | 4 | Gate evaluation only |
| Transfer | 2 | Cross-scenario regression and policy transfer |

The partition loader accepts exactly one partition and resolves case bodies
under that directory. Calibration enumeration cannot return holdout or transfer
bodies. The committed manifest exposes identifiers, risk family, anchors, path,
and immutable hash so integrity can be checked without handing protected
payloads to a candidate generator.

## Risk coverage

The corpus covers:

- normal cross-session preference;
- conflict and supersession;
- correction and stale-lineage invalidation;
- deletion and restore-frontier resurrection;
- scope privacy and policy exclusion;
- persisted prompt injection;
- temporal validity;
- multi-hop evidence lineage;
- derived-lane failure and degraded fallback;
- negative transfer blocking learning release.

Each body declares expected status, included memory identifiers, exclusion
codes, required explanations, and prohibited outcomes. These are contract
fixtures, not claims of production retrieval quality.

## Integrity

`pnpm test:fixtures` parses every manifest/body through the runtime schemas,
recomputes each content hash, verifies descriptor/body identity, and checks
partition isolation.

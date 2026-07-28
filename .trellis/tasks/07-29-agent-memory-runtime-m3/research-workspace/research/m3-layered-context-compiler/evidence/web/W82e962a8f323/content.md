# DBSP: automatic incremental view maintenance for rich query languages

Source: https://link.springer.com/article/10.1007/s00778-025-00922-y

Authors: Mihai Budiu, Tej Chajed, Frank McSherry, Leonid Ryzhyk, Val Tannen

Published 2025-05-08 in The VLDB Journal, volume 34, article 39.

## Extracted primary-source text

The abstract frames incremental view maintenance as maintaining a query-defined
view in response to database changes. DBSP supplies a data-stream model, a
mathematical definition of incremental view maintenance, and a transformation
from a program to an incremental program. The paper states that SQL and Datalog
can be implemented using primitives with efficient incremental implementations.

## Research relevance

This supports modeling L2/L3 objects as views over authoritative revisions and
processing ordered deltas. It does not require memo-graph to adopt DBSP itself:
the M3 scale permits a simpler outbox plus deterministic full rebuild oracle.

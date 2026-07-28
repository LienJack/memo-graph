# Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory

Source: https://arxiv.org/html/2504.19413v1

Authors: Prateek Chhikara, Dev Khant, Saket Aryan, Taranjeet Singh, Deshraj
Yadav

Published 2025-04-28 as arXiv:2504.19413.

## Extracted primary-source text

The abstract describes a memory architecture that dynamically extracts,
consolidates, and retrieves salient information, plus a graph variant for
relations. It evaluates single-hop, temporal, multi-hop, and open-domain
questions against several baselines, including full context.

The architecture section describes incremental extraction and update phases.
Extraction combines a conversation summary, recent messages, and the new
exchange. The update phase compares extracted memories with similar existing
ones and applies operations through a tool-call mechanism. A database is the
central repository.

## Research relevance

This supports multi-signal retrieval, explicit update semantics, and evaluating
structured memory against a full-context baseline. Its LLM-driven extraction is
not suitable as an authority boundary for M3, so derived records must remain
lineage-bound projections over the SQLite ledger.

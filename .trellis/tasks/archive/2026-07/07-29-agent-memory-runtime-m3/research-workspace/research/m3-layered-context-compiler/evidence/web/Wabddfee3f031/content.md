# LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory

Source: https://arxiv.org/html/2410.10813v1

Authors: Di Wu, Hongwei Wang, Wenhao Yu, Yuwei Zhang, Kai-Wei Chang, Dong Yu

Published 2024-10-14 as arXiv:2410.10813; accepted at ICLR 2025 according to
the authors' project repository.

## Extracted primary-source text

LongMemEval evaluates five abilities: information extraction, multi-session
reasoning, temporal reasoning, knowledge updates, and abstention. It contains
500 curated questions embedded in scalable chat histories. The paper reports a
substantial accuracy drop for long-context and commercial systems over sustained
interactions.

The paper decomposes a memory system into indexing, retrieval, and reading.
Reported optimizations include finer-grained session decomposition,
fact-augmented index keys, time-aware query expansion, and structured reading.

## Research relevance

This supports G3 coverage for temporal updates, cross-session reasoning,
abstention, recall, and downstream reading. G3 still needs project-specific
pollution, canonical-governance, token-budget, and paired-replay checks.

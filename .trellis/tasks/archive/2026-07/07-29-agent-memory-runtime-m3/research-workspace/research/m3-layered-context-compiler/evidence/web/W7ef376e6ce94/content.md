# MemGPT: Towards LLMs as Operating Systems

Source: https://research.memgpt.ai/

Authors: Charles Packer, Sarah Wooders, Kevin Lin, Vivian Fang, Shishir G. Patil,
Ion Stoica, Joseph E. Gonzalez (UC Berkeley)

## Extracted primary-source text

MemGPT manages a virtual context, inspired by virtual memory in operating
systems, to create unbounded LLM context. Its project page describes limited
context length as the central constraint for perpetual chat and says the system
manages different storage tiers to provide extended context within the model's
limited context window.

The abstract reports evaluation in document analysis and multi-session chat. In
the latter, conversational agents remember, reflect, and evolve through
long-term interactions.

## Research relevance

This is evidence for separating durable storage from a bounded compiled context.
It does not establish governance, revocation, projection authority, or a suitable
schema for memo-graph; those remain local design requirements.

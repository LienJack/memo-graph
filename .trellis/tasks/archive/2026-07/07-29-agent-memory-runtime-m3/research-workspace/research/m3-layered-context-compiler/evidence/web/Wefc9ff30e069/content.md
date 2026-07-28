# Generative Agents: Interactive Simulacra of Human Behavior

Source: https://arxiv.org/abs/2304.03442

Authors: Joon Sung Park, Joseph C. O'Brien, Carrie J. Cai, Meredith Ringel
Morris, Percy Liang, Michael S. Bernstein

Submitted 2023-04-07; revised 2023-08-06.

## Extracted primary-source text

The paper describes an architecture that stores a complete natural-language
record of an agent's experiences, synthesizes those memories into higher-level
reflections, and dynamically retrieves them for planning. Its evaluation uses
ablations and reports that observation, planning, and reflection each
contribute to believable behavior.

## Research relevance

This supports high-level derived memory and component ablation as useful design
patterns. It does not establish that generated reflections are authoritative;
memo-graph must preserve lower-revision lineage and canonical revalidation.

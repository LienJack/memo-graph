# Lost in the Middle: How Language Models Use Long Contexts

Source: https://aclanthology.org/2024.tacl-1.9/

Authors: Nelson F. Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Michele
Bevilacqua, Fabio Petroni, Percy Liang

Published in Transactions of the Association for Computational Linguistics,
volume 12, 2024, pages 157-173.

## Extracted primary-source text

The abstract reports controlled multi-document question answering and key-value
retrieval experiments. Performance changes with the position of relevant
information: it is often highest near the beginning or end of the input and
degrades when relevant information is in the middle, including for models
designed for long contexts.

## Research relevance

This is evidence that a larger context window does not by itself ensure useful
context. G3 must therefore compare task/evidence utility and pollution under the
same token budget, rather than reward raw recall volume or context length.

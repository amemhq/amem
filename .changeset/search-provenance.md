---
'@amemhq/core': major
'openclaw-amem': major
---

Say why each search result is in the list, and stop reporting link-expanded notes
as 0% similar.

Two-hop link expansion has worked since Story 18 and looked broken from outside.
`similarity` was read out of a map built from the dense top-n, and an expanded
note is by definition not in it — if it were, it would have been retrieved
directly instead of expanded into. So every expanded note reported `0`, the plugin
rendered `score: 0%`, and an agent running against a real store concluded
expansion was not happening. The gate at the top of the walk had already computed
the real cosine in order to threshold on it, and threw it away.

The number was also mislabelled. It is a cosine similarity; the list is ordered by
the RRF fusion of dense and BM25 with a heat/recency boost. Those disagree
routinely, so a column that looks like it should decrease down the list does not,
and there is no threshold to set on it because it is not what ranked anything.

`SearchResult` gains `via: 'match' | 'link'`. Matches are the ranked slice; links
are appended after them in discovery order and were never ranked at all. Without
that distinction the tail of the list reads as low-scoring matches, which is the
opposite of what it is — those are notes the graph vouched for.

Note `rrf` is not zero for a link: `bm25Score` returns every note in the store,
zero-scoring ones included, so nearly everything carries some fused score. That is
exactly why `rrf` cannot answer "why is this row here" and `via` has to.

The plugin now labels the column `similarity`, marks linked rows, and counts the
two kinds separately in the header.

**Breaking** only for direct `@amemhq/core` consumers that construct a
`SearchResult` themselves; the field is additive for anyone reading one.

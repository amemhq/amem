---
'@amemhq/core': major
'openclaw-amem': major
---

Stop feeding notes the query never hit into the ranking.

`bm25Score` is a scorer, not a retriever: it returns every note in the store, and
the ones sharing no term with the query come back at exactly 0, sorted among
themselves in the order the store handed them over. `searchMemory` sliced the
first `n` of that straight into the RRF fusion, so up to `n` notes selected by
nothing at all competed with the dense results at the same rank weights.

Measured on a 50-note store with a query that hit no term: BM25 returned all 50,
none scoring above 0, and the first of them entered the fusion at 0.0163934 —
identical to the weight of the top dense hit. Scroll order is stable, so it was
the same notes on every such query. That is a systematic bias, not noise that
averages away.

Filtering to `score > 0` is exact rather than a heuristic here: the idf is the
`+ 1` variant, which stays positive even for a term present in every note, so a
real lexical match can never fall through it. When nothing matches, RRF now
degenerates to the dense ranking, which is the right answer for a query with no
lexical signal.

This also makes `rrf: 0` mean what it says. Until now nearly every note carried a
fused score whether or not any retriever had chosen it.

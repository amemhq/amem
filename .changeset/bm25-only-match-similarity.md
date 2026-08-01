---
'@amemhq/core': patch
'openclaw-amem': patch
---

Report the real similarity for a result BM25 found on its own.

RRF fuses two lists, so a note can reach the results on lexical match alone,
having never been in the dense top-n. Nothing had measured its cosine, and
`similarity` fell through to `0` — so a note that matched the query by text
rendered as the least relevant row in the list.

2.1.0 fixed the same `?? 0` for link-expanded notes and missed this one. Both
vectors are already in memory, so the fallback now measures rather than guesses.

Found by an agent re-testing retrieval on a real store: it saw a `similarity: 0`
row in the top 5 and concluded zero-scoring notes were still getting into the
dense side. They were not — that path was fixed. The row was a lexical hit whose
cosine nobody had taken.

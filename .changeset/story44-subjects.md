---
'@heichaowo/amem-core': minor
'openclaw-amem': minor
---

Add `subjects` — who a memory is about (Story 44).

`agent_id` says whose memory *store* a note lives in. It never said who the note
is *about*. For a companion that meets several people those are different
questions, and without the second one every player's memories land in the same
pool and contaminate each other's retrieval.

Every note now carries `subjects`, a list:

- `[]` — a fact about the world, or about the character itself. Visible to everyone.
- `["alex"]` — about one person. Surfaced only when scoped to them.
- `["alex", "sam"]` — a shared experience. Surfaced for either of them.

A list rather than a single value because shared experience is the normal case
for a companion, not an edge case: "we beat the dragon together" belongs to both
people, and splitting it into two near-identical notes would only give the
deduplicator something to merge back. The three-way visibility rule then falls
out of the shape, with no extra mode switch.

`searchMemory(query, topK, agentId, { subject })` and the `memory_search` /
`memory_add` tools expose it. Scoping is applied inside the vector-store query,
so an out-of-scope memory is never fetched — and it is applied to BOTH retrieval
paths, semantic and keyword, since scoping only the vector side would leak
another person's memories through BM25.

`subjects` defaults to empty, so existing memories are all world facts and stay
visible exactly as before; omitting `subject` on a search is today's behaviour.

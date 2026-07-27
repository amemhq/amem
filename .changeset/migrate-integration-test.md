---
'@amemhq/core': patch
---

Exercise the embedding-model migration against a real Qdrant.

`migrateCollection` had unit coverage only, with every Qdrant call mocked. That
proved the branching and nothing else — and this is the command 2.0.0 will tell
people to run across the entire contents of their memory store, so "the mocks
agree with my assumptions" is not the bar.

Eight tests now push real points through a real server: the rebuild lands at the
target width with content intact, the source comes back byte-identical (the
property the whole approach rests on), a dry run leaves no collection behind, a
non-empty target and a missing source are both refused, `refreshFields` re-extracts
only the notes that never had keywords and makes no LLM call when off, and the
target records the model that built it.

No production code changed.

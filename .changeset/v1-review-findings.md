---
'@amemhq/core': patch
'openclaw-amem': patch
---

Fix what a pre-release review of the final v1 turned up.

`EmbeddingDimensionMismatchError` told everyone to "point AMEM_COLLECTION at the
new one". That is right for the default collection and wrong for a mode B one,
whose name comes from the plugin's `collection` setting and is handed straight to
`createStorageContext` — the env var is never consulted for it. A mode B operator
following that instruction would repoint the *default* store at their migrated
collection and still be staring at the original error.

`EmbeddingModelMismatchError` gave prose where its sibling gives a runnable
command, and pointed at `docs/reference/embedding-models.md`, a repo path that is
not in the published package. Both errors now share one tail, so they cannot drift
apart again.

The plugin checked only `EmbeddingDimensionMismatchError`, so the model mismatch —
added in this same release — fell through to `logger.warn` and never reached the
"memory is UNUSABLE" path. It does not stop writes, but it silently mixes two
vector geometries, which is worse to find out about late than a hard failure.

Docs: the collection-schema section named the wrong default model
(`multilingual-e5-small` rather than `paraphrase-multilingual-MiniLM-L12-v2`),
which could have led someone to set `AMEM_EMBED_MODEL` to a model their store was
never built with. The dtype list was missing `uint8` and `bnb4`.

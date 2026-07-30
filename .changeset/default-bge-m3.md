---
'@amemhq/core': major
'openclaw-amem': major
---

Default to `Xenova/bge-m3`. Existing stores keep the model they were built with.

The old default caps at 128 tokens. Anything longer never reached the vector, so
every memory past a couple of sentences was being retrieved on its opening clause
— quietly, because a truncated encode returns a perfectly well-formed vector.
bge-m3 reads 8192, needs no query prefix, is MIT, and its ONNX is maintained by
the author of Transformers.js. `Conan-embedding-v1` scores 11 points higher on
C-MTEB and is CC BY-NC; Qwen3-Embedding scores higher and needs an `Instruct:`
prefix amem does not send. Neither is a default I want to ship.

Nothing moves on upgrade. A collection is opened with the model recorded in its
Qdrant metadata, and a store predating that field is inferred from its vector
width — 384 could only have come from the old default, since picking anything else
has always meant setting `AMEM_EMBED_MODEL`. The inference is repeated on every
open rather than written back: a wrong record is permanent, and re-deriving it
costs nothing. So the new default only ever applies to a store that does not exist
yet, and moving an existing one is `amem-migrate` and nothing else.

`AMEM_EMBED_MODEL` still wins over both, because someone who set it is migrating
on purpose.

**Breaking** in two places. A new store is 1024-dim instead of 384. And two
collections open in one process that need different models is now
`MixedEmbeddingModelsError` rather than a dimension error from whichever one lost
— reachable in mode B, mid-migration, when one per-agent collection has moved and
the others have not.

Also here:

- `AMEM_EMBED_DTYPE` defaults to `fp16` **for bge-m3 only** — 1.08 GB instead of
  2.16 GB. Not global: `multilingual-e5-large-instruct` and `Qwen3-Embedding-4B`
  publish fp32 and nothing else, and failing their load to save someone a
  gigabyte they did not ask about is not amem's call.
- The mismatch errors were telling people to run `amem-migrate --to <name>`, which
  is not a flag. It parses `--to-collection`, so the argument was silently
  dropped; the derived target made it work anyway, and the missing
  `--from-collection` would have migrated the wrong store in mode B. Both errors
  now print the flag that exists, and the CLI repeats the collection flags it was
  given into every "now run this" line it prints.

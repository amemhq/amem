---
'@heichaowo/amem-core': minor
'openclaw-amem': minor
---

Make the embedding model selectable, and ship the migration before changing it.

The default model caps at 128 tokens, so anything longer never reaches the vector.
Replacing it is worth doing — but a model change is a breaking change whenever the
vector width differs, because Qdrant fixes a collection's size at creation. This
release changes **no default**. It only builds the machinery, so the switch can
happen later without breaking an existing install.

- `AMEM_EMBED_MODEL` selects the model. Unset behaves exactly as before.
- The vector width is **measured** — by encoding one short string — rather than
  read from a table. A table is silently wrong for any model not in it, and the
  collection would then be created at the wrong size.
- `ensureCollection` now compares the model's width against the collection that
  already exists and throws `EmbeddingDimensionMismatchError` at **startup**, with
  the fix in the message. Previously a mismatch surfaced as a raw Qdrant error on
  the first write, long after the change that caused it. The plugin logs this one
  as an error rather than a warning, because memory is unusable until it is
  resolved.
- `migrateCollection({ from, to })` backfills into a new collection and **never
  writes to the source**, which is what makes the switch reversible —
  `AMEM_COLLECTION` is read on every call, so going back is one variable. It
  defaults to a dry run, and refuses a target that already holds points.
- Notes that never had `keywords`/`tags` extracted are re-run through the current
  pipeline during migration. A vector built from a note missing those fields is
  built from less text than the same note would produce today. Existing values are
  left alone: this fills gaps, it does not relabel.

Re-embedding costs no LLM calls except for those gap-filling re-extractions —
every field that feeds the vector is already in the payload.

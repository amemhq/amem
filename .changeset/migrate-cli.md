---
'@amemhq/core': minor
---

Add `amem-migrate`, so the dimension-mismatch error can end in a command.

When the embedding model changes width, startup fails and the message has to tell
the operator what to do about it. It used to describe the procedure in prose —
build a collection, backfill it, repoint `AMEM_COLLECTION` — which is not runnable
at the moment memory has stopped working. It now prints:

```
AMEM_EMBED_MODEL=<model> \
  npx --package=@amemhq/core amem-migrate --to <collection>_v2
```

with the real model and collection names filled in. Dry run by default; `--apply`
writes. The source collection is only read, so the operation stays reversible.

`migrateCollection()` is unchanged and still exported. A library should not
re-embed someone's entire store because it was imported, so the decision to run
lives in a command rather than in engine startup — this only adds the entry point,
not a policy.

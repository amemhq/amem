---
---

Docs only.

**`openclaw plugins update` was never documented.** Only `install` was, and the
update path has two traps that cost a 2.27 GB re-download and an hour today: it
rebuilds `node_modules`, which is where the model cache lives unless
`AMEM_MODEL_CACHE` points elsewhere; and a workaround added for an older version
(`AMEM_EMBED_DTYPE=fp32`, needed on 2.0.x) silently outlives the release that
needed it.

**The model page led with what a model is good at.** The first question is whether
it runs. Now it opens with five tiers — runs on a real store / loaded but nothing
runs on it / should work but never loaded / loads through an unsupported path /
does not work — and the by-use-case tables follow, since those only matter once a
model is in one of the first two.

The counts are the audit script's, not hand-written: 20 of 33 clean on both
structural checks, 9 fallback, 4 with a `Dense` module. Tiers 1 and 2 are the only
ones a script cannot decide, which is why they hold three models between them.

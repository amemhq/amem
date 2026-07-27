---
'@amemhq/core': patch
'openclaw-amem': patch
---

Pool embeddings the way the model expects, instead of always mean-pooling.

`encode()` hardcoded `pooling: 'mean'`. That is correct for the default model and
wrong for every BGE-, GTE- and Arctic-family model, which are trained for `cls` —
so anyone who pointed `AMEM_EMBED_MODEL` at one of the models this project's own
docs recommend was getting a degraded vector.

It degrades rather than breaks, which is why it went unnoticed: both modes return
a normalized vector of the right width, and search keeps working because notes and
queries pass through the same function. It simply retrieves worse than the model
can, with nothing to indicate it.

The mode is now resolved from the model name, overridable with
`AMEM_EMBED_POOLING`. A model that is not recognised falls back to `mean` — the
behaviour of every previous release — so this can only improve an existing setup,
never change one that was already right.

Unlike the vector dimension, which amem measures with a probe encode, pooling
cannot be detected at runtime: both modes look equally valid from the outside. So
this is a lookup table, and each of its entries was read from that model's own
`1_Pooling/config.json`.

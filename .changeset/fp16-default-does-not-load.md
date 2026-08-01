---
'@amemhq/core': patch
'openclaw-amem': patch
---

Stop setting `fp16`. It does not load.

2.0.0 defaulted `AMEM_EMBED_DTYPE` to `fp16` for `bge-m3`, to halve a 2.27 GB
download. `onnxruntime-node` 1.24.3 aborts on those weights in
`SimplifiedLayerNormFusion`, on a node the fp16 conversion inserts, so a fresh
install of 2.0.0 or 2.0.1 could not embed at all — the plugin logs
`memory is UNUSABLE` and no search or write works. Reproduced on `bge-m3` and
`gte-multilingual-base`, on two machines, so it is the runtime and the precision
rather than one model.

Nothing picks a dtype now, for any model. `AMEM_EMBED_DTYPE` is a pass-through
again and the default install gets the library's `fp32`.

Existing stores were never affected: the fp16 default only applied to `bge-m3`,
and a store built before 2.0.0 keeps its own model.

The reason this shipped is that no test had ever loaded a model — every unit and
integration test mocks `embedding.js`, correctly, since they test retrieval rather
than ONNX. A `model-smoke` workflow now loads the default model at the dtype amem
resolves for it, encodes, and checks the vector is unit length and that a
paraphrase outscores an unrelated sentence. Weekly and on demand, not per-PR: the
download is over 2 GB.

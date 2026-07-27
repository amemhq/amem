---
'@amemhq/core': minor
'openclaw-amem': patch
---

Add `AMEM_EMBED_DTYPE` and `AMEM_EMBED_DEVICE`.

Both are pass-through to Transformers.js and both default to unset, so an
unconfigured install keeps exactly the behaviour it had.

`AMEM_EMBED_DTYPE` decides which weights are downloaded. The library default on
Node is `fp32`, which is the largest file a model publishes — `bge-m3` is 2.16 GB
at fp32 against 1.08 GB at fp16. Changing it needs no migration, because
quantization does not change the vector width.

`AMEM_EMBED_DEVICE` decides where inference runs. amem has always run on CPU, and
it turns out that was only because nothing ever passed a device:
`onnxruntime-node`'s macOS arm64 binary links CoreML.framework and exports the
CoreML provider, and Transformers.js accepts `coreml`, `dml`, `cuda` and `webgpu`
on Node. Whether any of them is actually faster here is **unmeasured** — CoreML
partitions a graph operator by operator and can lose to CPU — so this ships as an
experiment to run, with no recommendation and no change of default.

The extractor cache key now covers model, device and dtype together. It keyed on
the model alone, so changing either of the new settings would have been ignored
until the process restarted.

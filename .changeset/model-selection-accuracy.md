---
---

Docs and tooling only — no package change.

The embedding-model tables listed anything with an ONNX export. That is not the
same as usable, and two of the ways it differs are invisible from the repo listing:

- A `Dense` module after pooling is a learned projection a stock export leaves
  behind. `Conan-embedding-v1` projects 1024 → 1792, so the 76.67 C-MTEB score it
  was listed for belongs to vectors amem cannot produce — it loads, reports 1024
  dims, and never complains. `LaBSE` is worse: 768 → 768, so even the width is
  right. Both were sitting in usable tables.
- Nine models load through a generic fallback because Transformers.js has no
  mapping for their architecture, including every Qwen3-Embedding.

Both are checkable without downloading weights, so `tools/audit-embedding-models.mjs`
now does, and the tables carry a `Runtime` column with what it found. The page also
says plainly that native does not mean measured: only `bge-m3` has actually been
loaded and had its output checked.

`gte-multilingual-base` was checked properly rather than recommended on paper. fp32
works — 768 unit-norm dims, 0.86 on a Chinese near-synonym pair against 0.44 on an
unrelated one. fp16 does not load at all: onnxruntime aborts in
`SimplifiedLayerNormFusion`. It was being recommended in three places as the
smaller option, and the only build smaller than bge-m3 is the broken one.

Also documents what a fallback model actually risks, which is less than it sounds:
if one stops loading, the plugin cannot open the store, but `amem-migrate` never
loads the source model — it re-embeds from the payload text through the raw
helpers. Downtime and a rebuild, not data loss.

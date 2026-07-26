# Embedding models

amem embeds memories locally with [Transformers.js](https://huggingface.co/docs/transformers.js),
so a model is usable only if an **ONNX export** exists that `onnxruntime-node` can
load. That rules out several otherwise-good models regardless of their scores.

The default today is `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim).

::: warning The default has a 128-token limit
That is a hard cap on how much of a memory reaches the vector — anything past 128
tokens is truncated and effectively invisible to dense search. It is also absent
from the C-MTEB leaderboard entirely; it was never built for retrieval. If your
memories are longer than a sentence or two, this is the most consequential thing
on this page.
:::

## Candidates

C-MTEB retrieval, NDCG@10. Higher is better.

| Model | Score | Dim | Params | Max seq | Prefix required | Licence |
| :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| `paraphrase-multilingual-MiniLM-L12-v2` *(current)* | — | 384 | 118M | **128** | no | Apache-2.0 |
| `Xenova/multilingual-e5-small` | 59.95 | 384 | 118M | 512 | **yes** | MIT |
| `Xenova/multilingual-e5-base` | 61.63 | 768 | 278M | 512 | **yes** | MIT |
| `Xenova/bge-small-zh-v1.5` | 61.77 | 512 | 24M | 512 | optional | MIT |
| `Xenova/multilingual-e5-large` | 63.66 | 1024 | 560M | 512 | **yes** | MIT |
| `Xenova/bge-m3` | 64.0 | 1024 | 568M | 8192 | no | MIT |
| `Xenova/bge-base-zh-v1.5` | **69.49** | 768 | 102M | 512 | optional | MIT |
| `onnx-community/gte-multilingual-base` | **~69.7**\* | 768 | 305M | 8192 | no | Apache-2.0 |

\* **Not directly comparable.** gte's figure is a 6-dataset partial average from its
model card; every other score is the standard 8-dataset average. Treat it as "in
the same band as bge-base-zh", not as a win.

The current model has **no published C-MTEB retrieval score**. The closest
lower-bound proxy is `text2vec-base` at 38.79 — a model that is at least
Chinese-tuned. So the gap to anything in this table is a step change, not a few
points.

### Ruled out by the runtime, not by quality

| Model | Why |
| :--- | :--- |
| `jina-embeddings-v3` (68.60) | ONNX files use IR version 10; `onnxruntime-node` supports up to 9. No `onnx-community/` export exists. Also needs a non-standard `task_id` input. |
| `jina-embeddings-v5-*` | CC BY-NC 4.0 — non-commercial. Transformers.js architecture support unconfirmed. |
| `Qwen3-Embedding-4B` | ONNX exists, but 4B params is not viable for CPU inference in-process. |
| `snowflake-arctic-embed-*` (xs / m) | English-only backbones; poor Chinese. |

## What to pick

**Chinese and English both matter** → `onnx-community/gte-multilingual-base`.
Apache-2.0, no prefix to thread through the calling code, 8192-token window, and
Chinese quality in the same band as the Chinese-only leader. This is the default
recommendation.

**Chinese only, and you want the smallest good model** → `Xenova/bge-base-zh-v1.5`.
Highest verified Chinese score here at 102M params. It is Chinese-*only* — English
retrieval degrades noticeably.

**Very constrained on memory or startup time** → `Xenova/bge-small-zh-v1.5`.
24M params for 61.77 is the best ratio in the table by a wide margin.

**You want to change as little as possible** → `Xenova/multilingual-e5-small`.
The only candidate that keeps 384 dimensions, so the Qdrant collection does not
have to be rebuilt. But it scores lowest of the options, and it *requires*
`query: ` / `passage: ` prefixes — omitting them silently degrades quality rather
than failing, which is a bad failure mode.

**Longest context** → `Xenova/bge-m3` (8192 tokens, 100+ languages, no prefix), at
the cost of 568M params and a lower Chinese score than models a fifth its size.

::: tip Dimension barely matters at this scale
At a few thousand memories the difference between 384 and 1024 dimensions is a few
megabytes. Quality tracks training and language-specific tuning, not vector width —
`bge-base-zh-v1.5` at 768 beats `bge-m3` at 1024.
:::

## Language support beyond Chinese

The BM25 half of retrieval segments Chinese with [jieba](https://github.com/messense/node-jieba).
**jieba is Chinese-specific**, not CJK-general — it uses a Chinese dictionary and
Chinese-trained models.

The language check is `/[一-鿿]/` (CJK Unified Ideographs), which has
consequences worth knowing:

- **Chinese** — segmented by jieba, as intended.
- **Japanese** — kanji fall inside that range, so Japanese text is segmented with a
  *Chinese* dictionary, which gives poor results. Text that is mostly kana falls
  through to the `\w+` path and yields no usable tokens at all. Japanese needs a
  different segmenter (MeCab, Sudachi) that amem does not ship.
- **Korean** — Hangul is outside the range, so Korean takes the `\w+` path. Korean
  is space-delimited, so this partly works, but there is no morphological analysis.

Dense retrieval is unaffected by any of this — a multilingual embedding model
handles all three. Only the BM25 half is Chinese-tuned.

## Changing the model

A model change is a **breaking change** whenever the dimension differs: Qdrant
fixes a collection's vector size at creation and cannot alter it in place.

The intended shape is to build a new collection alongside the old one, backfill it,
verify, and only then switch `AMEM_COLLECTION` — which is read on every call, so the
switch is atomic and reversible. Re-embedding needs **no LLM calls**: every field
that feeds the vector (`content`, `keywords`, `tags`, `context`) is already in the
payload, so the cost is local compute.

::: warning Not yet available
The model is currently a constant, and there is no migration tooling — this section
describes where it is going, not something you can run today. `ensureCollection`
also does not check the dimension of an existing collection, so a mismatched model
would fail at the first write rather than at startup. Both land together in a
release that keeps the current model as the default, before any default changes.
:::

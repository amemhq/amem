# Embedding models

amem embeds memories locally with [Transformers.js](https://huggingface.co/docs/transformers.js)
on `onnxruntime-node`, in the same process as the agent. A model is usable here
only if an **ONNX export** exists on HuggingFace. Models that only run through
Python — sentence-transformers, FlagEmbedding, vLLM — are not listed on this page
at all, however good their scores.

Set one with `AMEM_EMBED_MODEL`, giving the repo id of the **ONNX** export:

```bash
AMEM_EMBED_MODEL=Xenova/bge-m3
```

The default today is `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim).

::: warning The default has a 128-token limit
That is a hard cap on how much of a memory reaches the vector — anything past 128
tokens is truncated and effectively invisible to dense search. It is also absent
from the C-MTEB leaderboard entirely; it was never built for retrieval. If your
memories are longer than a sentence or two, this is the most consequential thing
on this page.
:::

::: danger Changing this on an existing install is a breaking change
Qdrant fixes a collection's vector size when the collection is created and cannot
change it afterwards. Point `AMEM_EMBED_MODEL` at a model of a different width and
startup fails with `EmbeddingDimensionMismatchError`; memory stays unusable until
you migrate or change it back. Pick before you have data, or migrate deliberately.

A model of the **same** width is caught too, by a different mechanism: amem records
which model built a collection in Qdrant's collection metadata, and refuses to open
it with a different one (`EmbeddingModelMismatchError`). Without that, swapping
between two 1024-dimension models would pass every check and silently leave the
store holding vectors from two different geometries. Needs Qdrant 1.16 or newer;
on older servers only the width check applies.
:::

## Changing the model on a store you already have

One command, run until it says it is done:

```bash
AMEM_EMBED_MODEL=Xenova/bge-m3 npx --package=@amemhq/core amem-migrate
```

It reports where the store is and what comes next. `--apply` does the next step
and is safe to interrupt — re-running picks up where it stopped, so a rebuild that
died two thousand notes in does not start over. `--switch` is the last step: it
puts the rebuilt store behind the name you already use, so **nothing in your
configuration changes**.

Only `--switch` is irreversible. It drops the pre-migration collection, because
Qdrant will not put an alias over a name a real collection holds — and it refuses
to do that unless the new store holds at least as much as the old one.

Re-embedding costs no LLM calls: content, keywords, tags and context are already
in the payload, so it is local compute. The exception is notes written before the
extraction pipeline filled those fields in, which get re-extracted.
`--no-refresh-fields` skips that and makes the whole thing offline, at the cost of
those notes embedding from less text than they would today.

Using `@amemhq/core` directly rather than the plugin? `migrateCollection()` and
`switchToMigrated()` are exported — sequence them however your deployment wants.

## Reading the tables

- **zh** is C-MTEB / MTEB(cmn) **retrieval** NDCG@10. **en** is MTEB(eng)
  **retrieval** NDCG@10. **multi** is MTEB Multilingual or MIRACL retrieval.
- Scores come from model cards and papers, and are **not converted between
  benchmarks** — a number under `zh` and one under `en` are different evaluations
  and only comparable within their own column. Aggregate scores across all task
  types are not retrieval scores and are marked where used.
- **not published** means exactly that. Nothing here is estimated or inferred.
- Sizes are the real ONNX file sizes listed on HuggingFace, per dtype.

## Chinese and English both matter

| Model (ONNX repo) | zh | en | multi | Dim | Max seq | Params | Licence | Prefix |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| `Xenova/bge-m3` | 65.29¹ | not published | **67.8** MIRACL² | 1024 | 8192 | 568M | MIT | none |
| `onnx-community/gte-multilingual-base` | ~69.7³ | not published | not published | 768 | 8192 | 305M | Apache-2.0 | none |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 71.03 | not published | not published | 1024 | 32768 | 0.6B | Apache-2.0⁴ | **required** |
| `intfloat/multilingual-e5-large-instruct` | 63.65 | 53.47 | 65.7 MIRACL | 1024 | 512 | 560M | MIT | **required** |
| `ibm-granite/granite-embedding-311m-multilingual-r2` | not published | 52.6 | 65.2 MTEB-multi | 768 | 32768 | 311M | Apache-2.0⁵ | none |
| `ibm-granite/granite-embedding-97m-multilingual-r2` | not published | 50.1 | 60.3 MTEB-multi | 384 | 32768 | 97M | Apache-2.0⁵ | none |
| `onnx-community/harrier-oss-v1-0.6b-ONNX` | not published | not published | 69.0 MTEB-multiᵃ | 1024 | 32768 | 0.6B | MIT | **required** |
| `onnx-community/harrier-oss-v1-270m-ONNX` | not published | not published | 66.5 MTEB-multiᵃ | 640 | 32768 | 270M | MIT | **required** |
| `onnx-community/embeddinggemma-300m-ONNX` | not published | 69.67ᵃ | 60.9 MTEB-multi | 768 | 2048 | 300M | Gemma⁶ | none |
| `Xenova/LaBSE` | not published | not published | not published | 768 | 512 | 470M | Apache-2.0 | none |

**MIRACL and MTEB-multi are different benchmarks** and their numbers are not
comparable with each other. Only the two MIRACL figures — bge-m3's 67.8 and
multilingual-e5-large-instruct's 65.7 — can be read against one another, and even
then over 18 versus 16 languages.

1. Dense-only, averaged over 8 C-MTEB retrieval sub-tasks (arXiv:2402.03216).
2. MIRACL, dense, nDCG@10, averaged over 18 languages (arXiv:2402.03216 Table 2).
   Within that average, Chinese is 61.7 and English 56.9. The model covers 100+
   languages and its cross-lingual MKQA result is Recall@100 75.1 — a different
   metric again, so it is not in the table.
3. Sources disagree between ~69.7 and 71.95 depending on evaluation split.
4. Apache-2.0 is declared, but [an open issue](https://github.com/QwenLM/Qwen3-Embedding/issues/166)
   questions MS MARCO (non-commercial) training data, unanswered as of July 2026.
5. Tokenizer derives from Gemma 3 and carries Google's Gemma Terms of Use.
6. Custom Google licence; requires accepting terms on HuggingFace before download.

ᵃ Aggregate across all MTEB task types, **not** a retrieval score. Not comparable
with the retrieval numbers in the other columns.

## Chinese-focused

Higher Chinese scores, at the cost of English retrieval.

| Model (ONNX repo) | zh | Dim | Max seq | Params | Licence | Prefix |
| :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| `onnx-community/Conan-embedding-v1` | **76.67** | 1024 | 512 | 335M | **CC BY-NC 4.0** | none |
| `Xenova/bge-base-zh-v1.5` | 69.49 | 768 | 512 | 102M | MIT | optional |
| `Xenova/bge-small-zh-v1.5` | 61.77 | 512 | 512 | 24M | MIT | optional |

`Conan-embedding-v1` is the highest Chinese retrieval score on this page and its
ONNX was uploaded by the Transformers.js author, which is about as good a
compatibility signal as exists. It is **non-commercial only** — fine for personal
use, not something to build a product on. Its 512-token window is still four times
the current default's.

::: warning Conan-embedding-v2 is better in every way except the one that matters
v2 is Apache-2.0 (v1 is not), scores **78.31** on C-MTEB retrieval and **66.40** on
MTEB English retrieval — the best numbers on this page in both languages — and
takes 32768 tokens.

It has **no ONNX export**: not in `TencentBAC/Conan-embedding-v2`, and no
`onnx-community` or `Xenova` conversion exists. Its architecture is a custom
`ConanEmbedModel` built on a from-scratch 1.4B LLM, so even an export would need
Transformers.js to add support for it. The usable Conan is v1; the good Conan is
v2.
:::

## English-focused

Chinese is unpublished for all of these because the backbones are English-only;
expect Chinese retrieval to be poor. `all-MiniLM-L6-v2` scores **3.61** on
MTEB(cmn) retrieval, which is the shape of the whole band.

| Model (ONNX repo) | en | Dim | Max seq | Params | Licence | Prefix |
| :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| `Alibaba-NLP/gte-large-en-v1.5` | **57.91** | 1024 | 8192 | 434M | Apache-2.0 | none |
| `Snowflake/snowflake-arctic-embed-l` | 55.98 | 1024 | 512 | 335M | Apache-2.0 | **required** |
| `Alibaba-NLP/gte-modernbert-base` | 55.33 | 768 | 8192 | 149M | Apache-2.0 | none |
| `Xenova/e5-large-v2` | 55.26 | 1024 | 512 | 335M | MIT | **required** |
| `Snowflake/snowflake-arctic-embed-m` | 54.90 | 768 | 512 | 110M | Apache-2.0 | **required** |
| `Xenova/bge-large-en-v1.5` | 54.29 | 1024 | 512 | 335M | MIT | **required** |
| `Xenova/bge-base-en-v1.5` | 53.25 | 768 | 512 | 110M | MIT | **required** |
| `nomic-ai/nomic-embed-text-v1.5` | 58.81ᵇ | 768 | 8192 | 137M | Apache-2.0 | **required** |
| `Xenova/all-mpnet-base-v2` | 43.81 | 768 | 384 | 110M | Apache-2.0 | none |

ᵇ BEIR average rather than the MTEB 15-task retrieval set the others use.

`gte-large-en-v1.5` and `gte-modernbert-base` are the two here that need no prefix
and take 8192 tokens — the least trouble for the least loss.

## Small and fast

For weak machines, or when latency matters more than a few points.

| Model (ONNX repo) | zh | en | Dim | Max seq | Params | int8 size | Licence |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| `onnx-community/granite-embedding-small-english-r2-ONNX` | not published | 50.9 | 384 | 8192 | 47M | 52 MB | Apache-2.0 |
| `Xenova/bge-small-en-v1.5` | not published | 51.68 | 384 | 512 | 33M | 34 MB | MIT |
| `onnx-community/granite-embedding-30m-english-ONNX` | not published | 49.1 | 384 | 512 | 30M | 30 MB | Apache-2.0 |
| `Xenova/all-MiniLM-L6-v2` | 3.61 | 41.95 | 384 | 256 | 23M | 23 MB | Apache-2.0 |
| `Xenova/bge-small-zh-v1.5` | 61.77 | not published | 512 | 512 | 24M | ~25 MB | MIT |

`granite-embedding-small-english-r2` is the standout: 8192 tokens and 50.9 English
retrieval in 52 MB.

## Large models

Worth listing because some people have the machine for it — but see
[what it costs](#what-a-model-costs-you) first, and note that **the ONNX exports
for the largest models are fp32-only**, which is what actually rules them out
rather than the parameter count.

| Model (ONNX repo) | zh | en | Smallest ONNX | RAM needed | Licence |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `onnx-community/Qwen3-Embedding-8B-ONNX` | **78.21** | 69.44 | fp32 **30.3 GB** | ~36 GB+ | Apache-2.0³ |
| `onnx-community/Qwen3-Embedding-4B-ONNX` | **77.03** | 68.46 | fp32 **16.1 GB** | ~22 GB+ | Apache-2.0³ |
| `Xenova/LaBSE` | not published | not published | int8 471 MB | ~1 GB | Apache-2.0 |
| `Alibaba-NLP/gte-large-en-v1.5` | not published | 57.91 | int8 446 MB | ~1 GB | Apache-2.0 |

::: warning Qwen3-Embedding-4B and 8B do not fit a normal machine
Both publish **only an fp32 ONNX**. There is no fp16, q8 or q4 variant, so the
usual "just run the quantized one" does not apply. 4B needs roughly 22 GB of free
RAM and 8B roughly 36 GB — a 16 GB machine cannot load either.

Quantized builds do exist (`Qwen/Qwen3-Embedding-4B-GGUF`, Q4_K_M at 2.5 GB) but
they are **GGUF for llama.cpp**, which Transformers.js cannot load. If a quantized
ONNX export appears, these become the strongest Chinese models available here.
:::

## Pooling

A model produces one vector per token. Collapsing those into one sentence vector
is either **`mean`** (average across tokens) or **`cls`** (take the first token),
and a model only works properly with the one it was trained for.

amem resolves this from the model name and falls back to `mean`. Override with
`AMEM_EMBED_POOLING` if you use a model not listed here.

| Wants `cls` | Wants `mean` |
| :--- | :--- |
| every `bge-*`, including `bge-m3` | `paraphrase-multilingual-MiniLM-L12-v2` (the current default) |
| every `gte-*` | every `multilingual-e5-*`, and `e5-large-v2` |
| `snowflake-arctic-embed-m`, `snowflake-arctic-embed-l` | `Conan-embedding-v1` |
| | `all-MiniLM-L6-v2`, `all-mpnet-base-v2` |
| | `nomic-embed-text-v1.5` |

The split is by family, and it is not a rule of thumb — each entry was read from
that model's own `1_Pooling/config.json`.

::: warning Getting this wrong does not fail
Both modes return a normalized vector of the correct width. Search keeps working,
because notes and queries go through the same function — it just retrieves worse
than the model is capable of, with nothing to indicate it. Versions before 1.4.2
pooled with `mean` unconditionally, so anyone who pointed `AMEM_EMBED_MODEL` at a
BGE or GTE model was silently in this state.
:::

## Prefixes are the quiet failure

Several models were trained with a required prefix — `query: ` / `passage: `,
`Represent this sentence for searching relevant passages: `, or Qwen3's
`Instruct: {task}\nQuery: {text}`. amem passes plain text.

Omitting a required prefix **does not fail**. It silently costs retrieval quality,
by roughly 1–5% on the models that quantify it. That is a worse failure mode than
an error, which is why models needing no prefix are preferred for the default even
when a prefixed model scores higher.

## What a model costs you

Embedding sits on the **hot path of every memory write and every search**. A model
that is ten times larger makes both of those roughly ten times slower, on top of
holding its weights resident in the same process as your agent.

- **Disk and RAM** — the ONNX file sizes in the tables are exact, as listed on
  HuggingFace. Working memory is roughly **weights + 50%** for activations and
  runtime. That last part is a rule of thumb, not a measurement.
- **Speed** — no measured latency numbers are published here, because none have
  been measured on this runtime. Compare parameter counts instead: the current
  default is 118M, so `bge-m3` at 568M is roughly five times the work per encode
  and `Qwen3-Embedding-4B` is roughly thirty-four times.
- Inference runs on **CPU by default** — by configuration, not by limitation. See
  [Device](#device).

## Precision

`AMEM_EMBED_DTYPE` picks which weights are downloaded and used. Transformers.js
defaults to **`fp32`** on Node, which is the largest file a model publishes — for
`bge-m3` that is 2.16 GB where `fp16` is 1.08 GB and `int8` is 542 MB.

```bash
AMEM_EMBED_DTYPE=fp16
```

Valid values are whatever the model publishes: `fp32`, `fp16`, `q8`, `int8`,
`uint8`, `q4`, `q4f16`, `bnb4`. An unknown one fails at load and names the valid
options, so a typo does not run silently.

**Changing this needs no migration.** Quantization does not change the vector
width, so the collection is unaffected. It does perturb the values slightly, which
means a store written at `fp32` and later queried at `int8` is marginally
inconsistent — quantization error is small next to semantic distance, but that is
reasoning rather than a measurement.

Note that a smaller file does not always mean less memory: on x86 there is no
native fp16 arithmetic, so ONNX Runtime inserts casts back to fp32 at inference.
The download shrinks; the compute may not.

## Device

`AMEM_EMBED_DEVICE` picks where inference runs. Transformers.js accepts `cpu`,
`coreml` (macOS), `dml` (Windows), `cuda` (Linux x64) and `webgpu` on Node, and
defaults to `cpu`.

amem has never passed a device, which is the only reason it has always run on CPU.
`onnxruntime-node`'s macOS arm64 binary links `CoreML.framework` and exports the
CoreML provider — the capability was there the whole time.

::: warning Unmeasured
Nobody has benchmarked this on amem's models, so there is no recommendation here.
CoreML partitions a graph operator by operator and falls back to CPU for the ones
it cannot take, so it can lose to plain CPU on some models, and it pays a
compilation cost on first load. Treat it as an experiment to run, not a setting to
turn on.
:::

## Not usable today

Almost everything at the top of C-MTEB and MTEB is out of reach, and **it is the
runtime that puts it there, not the models**. The top of both leaderboards is
1.5B–8B models published as SafeTensors only. The best Chinese model that actually
loads here is `Conan-embedding-v1`, which is non-commercial.

These are listed rather than dropped, with the specific blocker and what would
lift it, because **most of the blockers are properties of our runtime choice, not
of the model**. If amem ever moves off Transformers.js, this table is the
re-filtering list — "no ONNX export" stops mattering the moment ONNX stops being
the only format we can load.

Models with **no open weights at all** are excluded outright and are not in the
table: `text-embedding-3-large` (OpenAI), `Cohere-embed-multilingual-v3.0`,
`gemini-embedding-exp`. There is nothing to load, and sending memory text to an
embedding service is against amem's design regardless.

Chinese and English figures below come from the `Qwen3-Embedding-8B` and
`Conan-embedding-v2` model cards — C-MTEB retrieval and MTEB(eng, v2) retrieval,
NDCG@10, one leaderboard snapshot each — so they are comparable *within* a column.

| Model | zh | en | Weights | Blocked by | Would be unblocked by |
| :--- | ---: | ---: | :--- | :--- | :--- |
| `TencentBAC/Conan-embedding-v2` | **78.31** | **66.40** | SafeTensors, Apache-2.0, 1.48B | No ONNX anywhere; custom `ConanEmbedModel` architecture | An ONNX or GGUF export **and** runtime support for the architecture |
| `Alibaba-NLP/gte-Qwen2-7B-instruct` | 75.70 | 58.09 | SafeTensors 30.5 GB, 7.6B | No ONNX ([request open since Jan 2025](https://huggingface.co/Alibaba-NLP/gte-Qwen2-7B-instruct/discussions/49)); too large for a consumer machine at fp32 | A quantized export — needs both a format we can load and ~8 GB of RAM |
| `richinfoai/ritrieve_zh_v1` | 76.97 | not published | SafeTensors, **MIT**, 0.3B | No ONNX; ends in a `2_Dense` module so a backbone-only export is not enough | A *full-pipeline* export including the Dense head. The best value on this table — MIT and small |
| `lier007/xiaobu-embedding-v2` | 76.50 | not published | SafeTensors + partial ONNX, **no licence declared** | `onnx/model.onnx` is backbone-only; `modules.json` declares Dense(1024→1792) | A full-pipeline export **and** a declared licence |
| `BAAI/bge-multilingual-gemma2` | 73.73 | 59.24 | SafeTensors 37 GB, 9B | No ONNX; too large | A quantized export |
| `Alibaba-NLP/gte-Qwen2-1.5B-instruct` | 71.86 | 50.25 | SafeTensors, 1.5B | No ONNX | Any loadable export |
| `intfloat/e5-mistral-7b-instruct` | 61.75 | 57.62 | SafeTensors, 7B | No ONNX for feature extraction; too large | A quantized export |
| `nvidia/NV-Embed-v2` | not published | 62.84 | SafeTensors, 7.8B | No ONNX; too large | A quantized export |
| `BAAI/bge-en-icl` | not published | 62.16 | SafeTensors, 7B | No ONNX; too large | A quantized export |
| `NovaSearch/stella_en_1.5B_v5` | not published | 52.42 | SafeTensors + ONNX, 1.5B | ONNX exists but the full set is 19.5 GB | A smaller quantized ONNX |
| `GritLM/GritLM-7B` | not published | 54.95 | SafeTensors, Apache-2.0, 7B | No ONNX; too large | A quantized export |
| `jinaai/jina-embeddings-v3` | 68.60ᶜ | not published | ONNX exists | Architecture unsupported by Transformers.js ([#1072](https://github.com/huggingface/transformers.js/issues/1072), closed unimplemented); needs a `task_id` input tensor that text-only calling code cannot supply | A runtime supporting the architecture, **plus** calling-code changes to pass `task_id` |
| `jinaai/jina-embeddings-v4` | not published | not published | SafeTensors, 4B, Qwen Research Licence | No ONNX; non-permissive licence | A loadable export — but the licence still bars it as a default |
| `jinaai/jina-embeddings-v5-*` | not published | 58.80 | ONNX, **CC BY-NC 4.0** | Licence bars it as a default; `text-nano`'s EuroBERT architecture is unsupported ([#1628](https://github.com/huggingface/transformers.js/issues/1628)) | Nothing — licence is not a runtime problem. Usable as a personal opt-in if the architecture lands |
| `infgrad/jasper_en_vision_language_v1` | not published | not published | SafeTensors | No ONNX | Any loadable export |

ᶜ C-MTEB score from an earlier snapshot; not from the two model cards above.

Read the last column as a watchlist. **"A quantized export"** covers most of it,
and the GGUF ecosystem already has that for several of these — so the obvious
question is why amem does not just load GGUF instead.

We looked, and stayed on ONNX. The short version: `Qwen3-Embedding-4B`, the model
that made the case, [fails past 512 tokens](https://github.com/QwenLM/Qwen3-Embedding/issues/35)
under `node-llama-cpp`, and amem is leaving its current model precisely because it
truncates at 128. The longer version, including what the comparison got wrong the
first time, is in [Design Rationale](/guide/design-rationale#why-not-gguf).

::: tip The old IR-9 ceiling no longer applies
Earlier versions of this page ruled models out for exporting at ONNX IR version 10.
Current `@huggingface/transformers` bundles onnxruntime-node 1.24.3, which supports
IR 10. Nothing on this page is excluded on IR grounds any more.
:::

## Known runtime caveats

- **`gte-multilingual-base`** declares `model_type: "new"` / `NewModel`, which
  Transformers.js has no registered class for. It loads through a generic
  encoder-only fallback and prints two warnings on every load. Embeddings come out
  correct in user reports, but the fallback's handling of the RoPE-based
  8192-token context is unverified — which matters, since the long context is the
  reason to pick it. Tracked in issues
  [891](https://github.com/huggingface/transformers.js/issues/891),
  [939](https://github.com/huggingface/transformers.js/issues/939) and
  [1177](https://github.com/huggingface/transformers.js/issues/1177), none fixed.
- **`ibm-granite/*`** quantized files are named `model_quint8_avx2.onnx`. The
  AVX2-specific quantization may misbehave on ARM; prefer fp32 on Apple Silicon.
- **`onnx-community/bge-m3-ONNX`** ships a 2-byte, broken `model_fp16.onnx`. Use
  `Xenova/bge-m3` instead.
- **Check `modules.json` before trusting any ONNX.** Sentence-Transformers models
  can end in a `Dense` projection after pooling, and a stock Optimum export covers
  the transformer backbone only. Transformers.js does its own pooling but has no
  notion of a Dense head, so a model whose `modules.json` lists three modules will
  silently produce vectors of the wrong width and the wrong content. Two modules —
  Transformer and Pooling — is what you want. This is what rules out
  `xiaobu-embedding-v2`, and it fails quietly rather than loudly.

## Dimension barely matters at this scale

At a few thousand memories the difference between 384 and 1024 dimensions is a few
megabytes of storage. Quality tracks training data and language coverage, not
vector width. Choose on scores, context length and licence — not on dimension.

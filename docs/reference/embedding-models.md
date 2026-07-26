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
:::

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
| `Xenova/bge-m3` | 65.29¹ | not published | — | 1024 | 8192 | 568M | MIT | none |
| `onnx-community/gte-multilingual-base` | ~69.7² | not published | — | 768 | 8192 | 305M | Apache-2.0 | none |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 71.03 | not published | — | 1024 | 32768 | 0.6B | Apache-2.0³ | **required** |
| `intfloat/multilingual-e5-large-instruct` | 63.65 | 53.47 | 65.7 (MIRACL) | 1024 | 512 | 560M | MIT | **required** |
| `ibm-granite/granite-embedding-311m-multilingual-r2` | not published | 52.6 | 65.2 | 768 | 32768 | 311M | Apache-2.0⁴ | none |
| `ibm-granite/granite-embedding-97m-multilingual-r2` | not published | 50.1 | 60.3 | 384 | 32768 | 97M | Apache-2.0⁴ | none |
| `onnx-community/harrier-oss-v1-0.6b-ONNX` | not published | not published | 69.0ᵃ | 1024 | 32768 | 0.6B | MIT | **required** |
| `onnx-community/harrier-oss-v1-270m-ONNX` | not published | not published | 66.5ᵃ | 640 | 32768 | 270M | MIT | **required** |
| `onnx-community/embeddinggemma-300m-ONNX` | not published | 69.67ᵃ | 60.9 | 768 | 2048 | 300M | Gemma⁵ | none |
| `Xenova/LaBSE` | not published | not published | not published | 768 | 512 | 470M | Apache-2.0 | none |

1. Dense-only, averaged over 8 C-MTEB retrieval sub-tasks (arXiv:2402.03216).
2. Sources disagree between ~69.7 and 71.95 depending on evaluation split.
3. Apache-2.0 is declared, but [an open issue](https://github.com/QwenLM/Qwen3-Embedding/issues/166)
   questions MS MARCO (non-commercial) training data, unanswered as of July 2026.
4. Tokenizer derives from Gemma 3 and carries Google's Gemma Terms of Use.
5. Custom Google licence; requires accepting terms on HuggingFace before download.

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
- Inference runs on **CPU**. Apple Silicon's neural engine is not used.

## Ruled out

Not because of quality — these have no ONNX export that this runtime can load.

| Model | Why |
| :--- | :--- |
| `BAAI/bge-multilingual-gemma2` | No ONNX export anywhere; 37 GB SafeTensors only. |
| `intfloat/e5-mistral-7b-instruct` | No ONNX export for feature extraction. |
| `Alibaba-NLP/gte-Qwen2-7B-instruct` | SafeTensors only (30.5 GB); community ONNX request open since Jan 2025. |
| `Alibaba-NLP/gte-Qwen2-1.5B-instruct` | SafeTensors only; no conversion exists. |
| `NovaSearch/stella_en_1.5B_v5` | ONNX exists but the full set is 19.5 GB. |
| `infgrad/jasper_en_vision_language_v1` | No ONNX export. |
| `jina-embeddings-v3` | Architecture unsupported by Transformers.js ([issue #1072](https://github.com/huggingface/transformers.js/issues/1072), closed unimplemented), and it requires a `task_id` input tensor that text-only calling code cannot supply. |
| `jina-embeddings-v4` | 4B params, no ONNX export, Qwen Research License. |
| `jina-embeddings-v5-*` | CC BY-NC 4.0. The `text-nano` variant's EuroBERT architecture is also unsupported ([issue #1628](https://github.com/huggingface/transformers.js/issues/1628)). |

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

## Dimension barely matters at this scale

At a few thousand memories the difference between 384 and 1024 dimensions is a few
megabytes of storage. Quality tracks training data and language coverage, not
vector width. Choose on scores, context length and licence — not on dimension.

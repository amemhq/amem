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

The default is `Xenova/bge-m3` (1024-dim, 8192 tokens), which is what a store
created from 2.0.0 onwards uses. Its ONNX is maintained by the author of
Transformers.js itself, and it needs no query prefix — see [why it was
picked](#why-bge-m3-is-the-default).

::: warning Upgrading to 2.0.0 does not move your store
A collection built before 2.0.0 keeps `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
(384-dim), because that is what its vectors are. amem detects this and says so on
every startup. Nothing breaks; your memories keep working exactly as they did.

But that model caps at **128 tokens**, so anything longer has always been
truncated before it reached the vector — invisible to dense search, silently. It
is also absent from the C-MTEB leaderboard entirely; it was never a retrieval
model. [Migrating](#changing-the-model-on-a-store-you-already-have) is the point
of this release.
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

::: danger Mode B: migrate every collection before you restart
One process embeds with one model. Open two collections that need different ones
and the second raises `MixedEmbeddingModelsError` — memory is unusable for it until
they agree.

Mode A never hits this; there is only one collection. Mode B does, and in the
ordinary way: migrate one per-agent collection, restart, and every collection you
have not migrated yet now disagrees with the one you have. Migrate them all in one
sitting, then restart:

```bash
for c in amem_alice amem_bob amem_main; do
  npx --package=@amemhq/core amem-migrate --from-collection "$c" --apply
done
```

then `--switch` each in turn. There is no partial state that works, so do not
restart the agent in the middle.
:::

## Why bge-m3 is the default

Not because it tops a leaderboard. `Conan-embedding-v1` scores 11 points higher on
C-MTEB and `Qwen3-Embedding-0.6B` scores 6 higher. Neither is a row you can act on:
Conan turned out to be [unusable](#not-usable-today) and Qwen3 loads through a
fallback. bge-m3 wins on the properties that decide whether a default is safe:

- **8192 tokens.** The single biggest change from the old default's 128. Memories
  longer than a couple of sentences now reach the vector whole.
- **No prefix.** Qwen3 and e5 need `Instruct:` / `query:` prefixes that amem does
  not send; omitting them costs 1–5% silently, which is a worse default than a
  lower score honestly obtained.
- **XLM-RoBERTa, with ONNX by the Transformers.js author.** Not a community export
  that might carry a missing `Dense` head or an IR version the runtime rejects.
- **MIT, and the export is the whole model.** Conan is CC BY-NC *and* its ONNX
  drops a `Dense(1024 → 1792)` head, so the score it is famous for is not a score
  you can get here. Qwen3's Apache-2.0 has an
  [open question](https://github.com/QwenLM/Qwen3-Embedding/issues/166) over its
  training data.
- **Chinese and English both work.** 65.29 C-MTEB dense-only retrieval and 67.8
  MIRACL over 18 languages, which is the actual target here.

The cost is size: 2.27 GB, against 118 MB for the model it replaces. 2.0.0 shipped
an `fp16` default to halve that and it did not load — see [Precision](#precision).

`onnx-community/gte-multilingual-base` is the real alternative, and it is not the
smaller one it was described as here. Both builds were loaded and checked:

- **fp32 works.** 768 dims, unit norm, and a near-synonym Chinese pair at 0.86
  against 0.44 for an unrelated Chinese/English pair. 1.26 GB — *more* than bge-m3
  costs, because amem's fp16 default covers its own model only.
- **fp16 does not load.** onnxruntime 1.24.3 aborts in `SimplifiedLayerNormFusion`
  on a node the fp16 conversion inserts. That was the only build smaller than
  bge-m3, so the size argument for gte is gone.

It scores about 4.4 higher on C-MTEB. Against that: its architecture is `new`,
which Transformers.js has no mapping for, so it runs through a generic fallback
the library itself logs as unsupported, and working today is not working after an
upgrade. See [what a fallback model risks](#what-a-fallback-model-risks) for what
that actually costs — less than it sounds, but not nothing. The *default* stays on
the natively-mapped model because a default should not ask that question of
someone who never opened this page.

If size is the binding constraint and Chinese is all you need,
`Xenova/bge-small-zh-v1.5` is 25 MB and native, at 61.77 and a 512-token window.

## Changing the model on a store you already have

One command, run until it says it is done:

```bash
npx --package=@amemhq/core amem-migrate
```

That migrates onto the current default. Set `AMEM_EMBED_MODEL` to go somewhere
else, and `--from-collection` if this is not the store `AMEM_COLLECTION` names —
per-agent collections need it.

The bare run downloads the model. It has to: the state it reports is the source's
vector width against the target model's, and the only way to know the second is to
load it and measure. So the first `amem-migrate` of any kind pulls the whole model,
2.27 GB for the default, even though it writes nothing.

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

### The `Runtime` column

An ONNX export existing is not the same as the model working, and the difference
is invisible from the repo listing. Two things are checked for every model here,
without downloading weights, by `node tools/audit-embedding-models.mjs`:

| `Runtime` | Meaning |
| :--- | :--- |
| **native** | Transformers.js maps the architecture, and there is no `Dense` module for the export to drop. |
| **fallback** | No mapping for the architecture. It still loads, through a generic encoder path that Transformers.js logs as unsupported. Nobody here has confirmed the vectors are right. |

A model with a `Dense` module is not given a row at all — it is in [Not usable
today](#not-usable-today), because the export leaves the projection behind and you
get a representation that was never benchmarked. `Conan-embedding-v1` and `LaBSE`
were both in these tables until the audit was written.

**native does not mean measured.** It means nothing structural is wrong. Only
`bge-m3` has actually been loaded and had its output checked, because it is the
default and every test exercises it.

## Chinese and English both matter

| Model (ONNX repo) | Runtime | zh | en | multi | Dim | Max seq | Params | Licence | Prefix |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| `Xenova/bge-m3` | native | 65.29¹ | not published | **67.8** MIRACL² | 1024 | 8192 | 568M | MIT | none |
| `onnx-community/gte-multilingual-base` | **fallback** | ~69.7³ | not published | not published | 768 | 8192 | 305M | Apache-2.0 | none |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | **fallback** | 71.03 | not published | not published | 1024 | 32768 | 0.6B | Apache-2.0⁴ | **required** |
| `intfloat/multilingual-e5-large-instruct` | native | 63.65 | 53.47 | 65.7 MIRACL | 1024 | 512 | 560M | MIT | **required** |
| `ibm-granite/granite-embedding-311m-multilingual-r2` | native | not published | 52.6 | 65.2 MTEB-multi | 768 | 32768 | 311M | Apache-2.0⁵ | none |
| `ibm-granite/granite-embedding-97m-multilingual-r2` | native | not published | 50.1 | 60.3 MTEB-multi | 384 | 32768 | 97M | Apache-2.0⁵ | none |
| `onnx-community/harrier-oss-v1-0.6b-ONNX` | **fallback** | not published | not published | 69.0 MTEB-multiᵃ | 1024 | 32768 | 0.6B | MIT | **required** |
| `onnx-community/harrier-oss-v1-270m-ONNX` | **fallback** | not published | not published | 66.5 MTEB-multiᵃ | 640 | 32768 | 270M | MIT | **required** |
| `onnx-community/embeddinggemma-300m-ONNX` | **fallback** | not published | 69.67ᵃ | 60.9 MTEB-multi | 768 | 2048 | 300M | Gemma⁶ | none |

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

| Model (ONNX repo) | Runtime | zh | Dim | Max seq | Params | Licence | Prefix |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| `Xenova/bge-base-zh-v1.5` | native | 69.49 | 768 | 512 | 102M | MIT | optional |
| `Xenova/bge-small-zh-v1.5` | native | 61.77 | 512 | 512 | 24M | MIT | optional |

`Conan-embedding-v1` used to have a row here, on the strength of the highest
Chinese retrieval score on the page and an ONNX conversion that loads without
complaint. Both are true and neither makes it usable: `modules.json` upstream ends
in `Dense(1024 → 1792)`, the conversion covers the backbone only, and 76.67 was
measured on the 1792-dim output. Through Transformers.js you get 1024 dims, amem
measures 1024, builds the collection at 1024, and never has cause to complain.
It is in [Not usable today](#not-usable-today). Separately, it is CC BY-NC.

::: warning Conan-embedding-v2 is better in every way except the one that matters
v2 is Apache-2.0 (v1 is not), scores **78.31** on C-MTEB retrieval and **66.40** on
MTEB English retrieval — the best numbers on this page in both languages — and
takes 32768 tokens.

It has **no ONNX export**: not in `TencentBAC/Conan-embedding-v2`, and no
`onnx-community` or `Xenova` conversion exists. Its architecture is a custom
`ConanEmbedModel` built on a from-scratch 1.4B LLM, so even an export would need
Transformers.js to add support for it. Neither Conan is usable here — v1 for the
Dense head, v2 for having no export at all.
:::

## English-focused

Chinese is unpublished for all of these because the backbones are English-only;
expect Chinese retrieval to be poor. `all-MiniLM-L6-v2` scores **3.61** on
MTEB(cmn) retrieval, which is the shape of the whole band.

| Model (ONNX repo) | Runtime | en | Dim | Max seq | Params | Licence | Prefix |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| `Alibaba-NLP/gte-large-en-v1.5` | **fallback** | **57.91** | 1024 | 8192 | 434M | Apache-2.0 | none |
| `Snowflake/snowflake-arctic-embed-l` | native | 55.98 | 1024 | 512 | 335M | Apache-2.0 | **required** |
| `Alibaba-NLP/gte-modernbert-base` | native | 55.33 | 768 | 8192 | 149M | Apache-2.0 | none |
| `Xenova/e5-large-v2` | native | 55.26 | 1024 | 512 | 335M | MIT | **required** |
| `Snowflake/snowflake-arctic-embed-m` | native | 54.90 | 768 | 512 | 110M | Apache-2.0 | **required** |
| `Xenova/bge-large-en-v1.5` | native | 54.29 | 1024 | 512 | 335M | MIT | **required** |
| `Xenova/bge-base-en-v1.5` | native | 53.25 | 768 | 512 | 110M | MIT | **required** |
| `nomic-ai/nomic-embed-text-v1.5` | native | 58.81ᵇ | 768 | 8192 | 137M | Apache-2.0 | **required** |
| `Xenova/all-mpnet-base-v2` | native | 43.81 | 768 | 384 | 110M | Apache-2.0 | none |

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

| Model (ONNX repo) | Runtime | zh | en | Smallest ONNX | RAM needed | Licence |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| `onnx-community/Qwen3-Embedding-8B-ONNX` | **fallback** | **78.21** | 69.44 | fp32 **30.3 GB** | ~36 GB+ | Apache-2.0³ |
| `onnx-community/Qwen3-Embedding-4B-ONNX` | **fallback** | **77.03** | 68.46 | fp32 **16.1 GB** | ~22 GB+ | Apache-2.0³ |
| `Alibaba-NLP/gte-large-en-v1.5` | **fallback** | not published | 57.91 | int8 446 MB | ~1 GB | Apache-2.0 |

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
| every `bge-*`, including `bge-m3` (the default) | `paraphrase-multilingual-MiniLM-L12-v2` (the default before 2.0.0) |
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
`bge-m3` that is 2.27 GB where `fp16` is 1.13 GB and `int8` is 568 MB.

```bash
AMEM_EMBED_DTYPE=int8
```

amem sets nothing here. It is a pass-through, for every model including its own.

::: danger fp16 does not load
`onnxruntime-node` 1.24.3 aborts loading an fp16 ONNX in
`SimplifiedLayerNormFusion`, on a node the fp16 conversion inserts:

```
Attempting to get index by a name which does not exist:
  InsertedPrecisionFreeCast_/encoder/layer.23/output/LayerNorm/Constant_output_0
```

Reproduced on `bge-m3` and on `gte-multilingual-base`, on two machines. It is the
runtime and the precision, not a particular model.

2.0.0 and 2.0.1 set `fp16` for `bge-m3` automatically, to halve the download. That
means a fresh install of either **could not embed at all** — and nothing caught it,
because every test mocks the embedding module and no test had ever loaded a model.
Fixed in 2.0.2 by setting no dtype at all, and a
[smoke workflow](https://github.com/amemhq/amem/blob/main/.github/workflows/model-smoke.yml)
now loads the default model for real on a schedule.

If you set `fp16` yourself, expect it to fail until onnxruntime ships a fix. `int8`
and `q8` are untested here — see the header of the tables about what "untested"
means on this page.
:::

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
1.5B–8B models published as SafeTensors only. `Conan-embedding-v1` looks like the
exception — it has an ONNX and it loads — but the export is backbone-only and the
score belongs to the projection it leaves behind, so it is in the table below with
everything else.

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
| `onnx-community/Conan-embedding-v1` | **76.67** | not published | SafeTensors + ONNX, **CC BY-NC 4.0** | Conversion is backbone-only; upstream `modules.json` ends in Dense(1024→1792), so the score belongs to vectors this cannot produce. Loads and reports 1024 dims without error | A full-pipeline export. The licence would still rule it out for anything commercial |
| `Xenova/LaBSE` | not published | not published | SafeTensors + ONNX, Apache-2.0 | Upstream `modules.json` ends in Dense(768→768). Same width in and out, so dropping it changes the vectors and nothing anywhere can notice | A full-pipeline export |
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

## What a fallback model risks

Nine models on this page load through a path Transformers.js has no mapping for.
It works — `gte-multilingual-base` at fp32 returns 768 unit-norm dims with a
Chinese near-synonym pair at 0.86 against 0.44 for an unrelated one — but the
library logs it as unsupported and nothing promises the next version still does it.

**What breaks if that happens.** The plugin cannot open the store: every path goes
through `ensureCollection`, which measures the model's width, which means loading
it. You get `memory is UNUSABLE` at startup and no reads or writes until it is
resolved.

**What does not break: your memories.** `amem-migrate` never loads the model that
built the source. It reads the collection through the raw helpers that deliberately
bypass `ensureCollection`, throws the stored vectors away, and re-embeds from the
payload text — content, keywords, tags and context are all still there. The only
model it needs to load is the one you are moving *to*.

So the recovery is:

```bash
AMEM_EMBED_MODEL=Xenova/bge-m3 npx --package=@amemhq/core amem-migrate --apply
# then --switch
```

Downtime and a rebuild, not data loss. Weigh a fallback model against that, not
against losing the store — but do weigh it, because the rebuild is the whole store
and the outage lasts until you finish.

Two things reduce the exposure if you take one:

- **Pin `@huggingface/transformers`.** The plugin bundles its own copy, so the
  version that works stays working until you update the plugin.
- **Keep the payload complete.** The rebuild is only as good as the text in the
  store. `--no-refresh-fields` on the original migration leaves early notes with
  empty keywords and tags, and those are what a future rebuild has to work from.

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
- **Check `modules.json` for a `Dense` module before trusting any ONNX.**
  Sentence-Transformers models can end in a learned projection after pooling, and a
  stock Optimum export covers the transformer backbone only. Transformers.js does
  its own pooling but has no notion of a Dense head, so you silently get the
  pre-projection vectors — a representation nobody benchmarked.

  Read the module *types*, not the count. `Transformer, Pooling, Normalize` is
  three modules and is fine: `Normalize` is plain L2, which amem does itself.
  `bge-m3` and `gte-multilingual-base` are both that shape. `Transformer, Pooling,
  Dense` is the one to refuse.

  This is what rules out `xiaobu-embedding-v2` and `Conan-embedding-v1`. Conan is
  the clearest case: its `2_Dense/config.json` projects 1024 → 1792, so the real
  model emits 1792-dim vectors and its 76.67 C-MTEB score was measured on those.
  Through Transformers.js you get 1024 dims, amem measures 1024, builds the
  collection at 1024, and everything runs. Nothing tells you the model you are
  running is not the model you read about.

## Dimension barely matters at this scale

At a few thousand memories the difference between 384 and 1024 dimensions is a few
megabytes of storage. Quality tracks training data and language coverage, not
vector width. Choose on scores, context length and licence — not on dimension.

# Design Rationale

Why amem is built the way it is, and what evidence each decision rests on.

This page exists because "we chose X" is not useful on its own. The reasoning is
what lets you judge whether a decision still holds when your situation differs
from ours. When evidence is published, we cite it. When a decision is our own
judgement, we say so.

> **Every figure below was checked against the source it is attributed to.**
> Claims that could not be verified were removed rather than softened. See
> [Evidence quality](#evidence-quality) at the end for what that process did and
> did not establish.

---

## The core finding: architecture dominates model tier

The strongest and most consistent result across recent work is that **how a memory
pipeline is assembled matters far more than how capable the model driving it is.**

| Finding | Evidence |
| :--- | :--- |
| Replacing a two-pass extract-then-reconcile write path with single-pass ADD-only **raised** LoCoMo 71.4 → 92.5 and LongMemEval 67.8 → 94.4 — **with no change of backbone model** | mem0, [Token-Efficient Memory Algorithm](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm) (Apr 2026) |
| Retrieval method shifts accuracy by **14–23 points**; write strategy by only **3–8 points**. Raw chunking with **zero LLM calls** (81.1%) beat LLM fact extraction (77.3%) under the same retrieval | [arXiv:2603.02473](https://arxiv.org/abs/2603.02473), MemAgents Workshop @ ICLR 2026 |
| For fact extraction, `gpt-4o-mini` (76.88%) vs `gpt-4o` (78.96%) on LongMemEval-S — a **2.1 point** gap | TiMem, [arXiv:2601.02845](https://arxiv.org/abs/2601.02845), ACL 2026 Findings |
| `gpt-4o` used as a raw long-context reader scores **60.0%**, *below* `gpt-4o-mini` inside a deterministic pipeline at **78.0%** | [arXiv:2606.01435](https://arxiv.org/abs/2606.01435) |

The mem0 result is the sharpest: removing a worse-designed step gave the *same*
model substantially better memory. Their account names the mechanism:

> That reconciliation step was slow, and it was where context got destroyed.

> Overwrites sometimes erased key information from the original fact.

> Deletes sometimes removed information that would be relevant later.

**Consequence for amem:** amem treats "requires a strong model" as a design smell.
It is usually a way of paying to paper over a weak pipeline.

## The exception: detecting contradiction

Architecture does not dominate *everywhere*. There is one task where model
capability produces a large, real gap. That task is deciding whether a new fact
**contradicts** a stored one, as opposed to merely adding to it.

| Task | Cheap model | Strong model |
| :--- | :--- | :--- |
| Single-hop conflict detection | `gpt-4o-mini` 78.0% | `gpt-4o` 94.8% |
| Multi-hop conflict detection | `gpt-4o-mini` 30.2% | `gpt-4o` 51.5% |
| **Implicit** invalidation (STALE) | `gpt-4o-mini` **8.7%** | Gemini-3.1-pro 55.2% |
| Indirect (implied) recall | `gpt-4.1-mini` direct 0.5526 → **indirect 0.0032** | — |

Sources: [arXiv:2606.01435](https://arxiv.org/abs/2606.01435) (conflict),
[arXiv:2605.06527](https://arxiv.org/abs/2605.06527) (STALE),
[arXiv:2603.26680](https://arxiv.org/abs/2603.26680) (AlpsBench).

### The uncomfortable number

The STALE benchmark measured existing memory frameworks on a `gpt-4o-mini`
backbone. **A-MEM — the architecture amem is derived from — scored 5.1%**, with
Zep at 6.0%, mem0 at 8.3%, and LightMem highest at 17.8%.

We include this because it is the most important number on this page for
understanding amem's roadmap. The *foundational* design has a real blind spot for
memories that have quietly gone stale. A cheap model cannot cover that blind spot.

### But architecture still wins, even here

The same STALE paper reports that an explicit adjudication design (CUPMem) lifts
that 8.7% to **68.0%**. This is above the best raw frontier model's 55.2%. A
purpose-built structure beat a bigger model at the one task bigger models were
winning.

Reasoning models are **not** a general answer: `o4-mini` underperforms `gpt-4o`
on multi-hop conflict inside a rigid pipeline (43.2% vs 51.5%). Extra reasoning
does not help when the pipeline gives it nowhere to go.

## How this shapes amem

### 1. Cheap-tier capable is a requirement, not a compromise

amem must run well on a small, fast, locally-hostable model. That is the floor.
A stronger model can raise the ceiling, but it is never required. This follows
directly from the evidence above: the write path's dominant cost is frequency, and
its quality is mostly architecture-bound.

The model is configurable at every level — see [Configuration](/reference/configuration#llm-settings).

### 2. The write path is layered, so the LLM handles only what it must

```
new memory
  ├─ 1. exact hash dedup          — no LLM
  ├─ 2. high-similarity vector    — no LLM, updates in place
  ├─ 3. LLM CRUD decision         — only the residual reaches here
  └─ 4. scheduled consolidation   — batch, offline, full context
```

Layers 1–2 absorb the majority of writes at zero LLM cost. What reaches layer 3 is
the genuinely hard remainder. This is exactly the population a cheap model is
worst at. The next decision handles that tension, not a larger model.

### 3. A destructive update must prove it has the right target

The CRUD step picks a memory to update from a numbered list. An **in-range but
wrong** index is the one silent, unrecoverable failure in the write path. It is a
valid position, usually a note you own, so nothing structural catches it.

This is a documented failure class, not a hypothetical. Memory-R1
([arXiv:2508.19828](https://arxiv.org/abs/2508.19828)) exists because, in its
words:

> Existing approaches mainly rely on vanilla LLMs to choose operations from
> in-context instructions without any learning signal tied to correctness.

Its appendix documents a case where a stored memory about adopting a dog named
Buddy is treated as contradicted when a second dog, Scout, is mentioned — and the
first is deleted, when both were true.

amem's answer is architectural, not tier-based:

- Before overwriting, the replacement must be plausibly *about* the memory it
  replaces (cosine ≥ `crudUpdateMinSim`). Both vectors are already in hand, so it
  costs one dot product and no LLM call. Failing the check stores the fact as a
  **new** memory instead.
- The replaced text is retained in `evolution_history`, so even an accepted
  overwrite stays recoverable.

The asymmetry is the whole point: a false positive costs a duplicate, which
consolidation can merge. A false negative destroys a memory, which nothing can
recover. See [CRUD update safety](/reference/configuration#crud-update-safety).

We follow Zep's principle here rather than hard deletion. The temporal graph
([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)) marks superseded facts
instead of removing them:

> When the system identifies temporally overlapping contradictions, it invalidates
> the affected edges by setting their `t_invalid` to the `t_valid` of the
> invalidating edge.

amem's `DELETE` is likewise a soft delete (`is_active: false`).

### 4. Parsing assumes an imperfect model, because that is the target

amem supports any OpenAI-compatible endpoint. Users routinely point it at
open-weight and reasoning models that wrap output in `<think>` blocks or chat
special tokens. amem strips those before JSON parsing and tolerates a preamble
before the JSON object.

This is not cosmetic. Before this fix, a *valid* response from such a model
would fail to parse and silently fall back to a blank result. Nothing in the
logs distinguished it from a genuine model failure.

## What we deliberately did not do

| Not done | Why |
| :--- | :--- |
| Require a frontier model | The evidence does not support it for extraction, and it would foreclose local deployment |
| Remove the CRUD step, as mem0 did | Their gain came from deleting a *broken* step. amem's runs only on the hard residual, where it has non-redundant value — the fix is to make it safe, not to remove it |
| Default to a reasoning model | They underperform inside rigid pipelines ([arXiv:2606.01435](https://arxiv.org/abs/2606.01435)) and cost more |
| Trust an LLM to pick an update target unchecked | See §3 |
| Move embeddings from ONNX to GGUF | See below |

### Why not GGUF

Running embeddings through `@huggingface/transformers` means only models with an
ONNX export are usable. That constraint costs real quality: the strongest Chinese
retrieval models either have no ONNX at all or publish fp32-only files too large
to load. `node-llama-cpp` and the GGUF ecosystem would lift it. We looked
properly and stayed put, for three reasons.

**The model that motivated the switch does not work there.** GGUF's appeal was
`Qwen3-Embedding-4B`: C-MTEB retrieval 77.03, and 2.5 GB at Q4_K_M against 16.1 GB
for the fp32-only ONNX. But it fails past 512 tokens under `node-llama-cpp`
(`Failed to get embeddings for token 512`,
[QwenLM/Qwen3-Embedding#35](https://github.com/QwenLM/Qwen3-Embedding/issues/35)),
unaffected by context or batch settings. amem moved off a model *because* it truncates
at 128 tokens. Trading that for one that breaks at 512 is not the fix.

**The acceleration argument was based on something we never checked.** The case
for GGUF leaned on Metal on Apple Silicon, against ONNX being CPU-only. ONNX is not
CPU-only: `onnxruntime-node`'s macOS arm64 binary links `CoreML.framework` and
exports `OrtSessionOptionsAppendExecutionProvider_CoreML`, and Transformers.js
accepts `device: 'coreml'` and `device: 'webgpu'` on Node. It defaults to `cpu`,
and amem never passed a device. We were comparing a rival's best case against
our own untouched default.

**GGUF gives up controls that fail silently when lost.** `node-llama-cpp` exposes
no pooling configuration. It reads pooling from the GGUF's metadata, which
community conversions often omit. Getting that wrong produces vectors, not errors.
It is also ESM-only and cannot be inlined, but the plugin ships as a single CJS
bundle. It replaces download-by-model-name with a user-supplied path to a
multi-gigabyte file.

Not settled, just decided for now. Revisit when #35 is fixed and an official GGUF
with correct pooling metadata exists. Measure `coreml` and `webgpu` on the ONNX
side first, because that is the cheaper experiment and it has never been run.

## Evidence quality

We fetched and checked every source cited here: that the identifier resolves,
that the title is what we say it is, and that the specific figures appear in the
text. That process removed one claim and corrected two more:

- A widely-repeated latency figure attributed to the Zep paper **does not appear in
  it** and was dropped.
- mem0's blog and its migration guide publish **different** post-change scores
  (92.5/94.4 vs 91.6/93.4). This page cites the blog, the primary announcement.
- Two phrases we had treated as direct quotes were paraphrases, and are no longer
  presented as quotations.

**What this does not establish.** These are other people's published results on
their own benchmarks. They are not measurements of amem. amem's own regression
numbers are in [Smoke Test Results](/reference/smoketest). The tier question
(which model is *sufficient*) has not been measured on amem across model tiers.
Where this page reasons from published results to an amem decision, that inference
is ours.

## References

| ID | Title |
| :--- | :--- |
| [arXiv:2502.12110](https://arxiv.org/abs/2502.12110) | A-MEM: Agentic Memory for LLM Agents (NeurIPS 2025) — the architecture amem implements |
| [arXiv:2504.19413](https://arxiv.org/abs/2504.19413) | Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory |
| [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) | Zep: A Temporal Knowledge Graph Architecture for Agent Memory |
| [arXiv:2508.19828](https://arxiv.org/abs/2508.19828) | Memory-R1: Enhancing LLM Agents to Manage and Utilize Memories via Reinforcement Learning |
| [arXiv:2601.02845](https://arxiv.org/abs/2601.02845) | TiMem: Temporal-Hierarchical Memory Consolidation for Long-Horizon Conversational Agents |
| [arXiv:2603.02473](https://arxiv.org/abs/2603.02473) | Diagnosing Retrieval vs. Utilization Bottlenecks in LLM Agent Memory |
| [arXiv:2603.26680](https://arxiv.org/abs/2603.26680) | AlpsBench: An LLM Personalization Benchmark for Real-Dialogue Memorization and Preference Alignment |
| [arXiv:2605.06527](https://arxiv.org/abs/2605.06527) | STALE: Can LLM Agents Know When Their Memories Are No Longer Valid? |
| [arXiv:2606.01435](https://arxiv.org/abs/2606.01435) | Don't Ask the LLM to Track Freshness: A Deterministic Recipe for Memory Conflict Resolution |

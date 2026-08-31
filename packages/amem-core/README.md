# @amemhq/core

Framework-agnostic **A-MEM agentic memory engine** — memories that **evolve**, not just accumulate. Qdrant + local Transformers.js + LLM, **no Python required**.

```bash
npm i @amemhq/core
```

We extracted this package from [`openclaw-amem`](https://github.com/amemhq/amem/tree/main/packages/openclaw-amem) so that any host can share one memory engine: an OpenClaw plugin, a standalone service ([`amem-api`](../amem-api)), or a game agent. It is part of the [amem monorepo](../../).

> Based on _A-MEM: Agentic Memory for LLM Agents_ ([arXiv:2502.12110](https://arxiv.org/abs/2502.12110), NeurIPS 2025). For the original research implementation, see [agiresearch/A-MEM](https://github.com/agiresearch/A-MEM).

## What is A-MEM?

Unlike a flat vector store, A-MEM maintains memory as a living, self-evolving semantic graph. On every write:

1. **Note Construction** — an LLM extracts keywords, tags, and a context summary, categorizes the note, and classifies it as `memory` (episodic) or `knowledge` (durable). For knowledge notes, the LLM extracts 1–5 `topics`.
2. **Link Generation** — the engine retrieves the top-6 candidates. The LLM judges whether to link them bidirectionally (similarity > 0.3).
3. **Memory Evolution** — the engine evolves the attributes of up to 3 linked notes from the new context. This can trigger further links.
4. **Hybrid Retrieval** — the engine fuses dense vectors (Transformers.js `bge-m3`, 1024-dim) and BM25 via Reciprocal Rank Fusion (RRF). Retrieval heat boosts the result.
5. **2-hop BFS Graph Expansion** — after the RRF top-K, BFS walks the link graph up to 2 hops and admits up to 8 graph-connected notes that pass an embedding relevance gate (cos-sim ≥ 0.25). This is the key advantage over flat vector systems.

## Features

- 🔄 **Dynamic memory network** (Zettelkasten-inspired) — notes are graph nodes with bidirectional links, not flat rows.
- 🧬 **Evolution & strengthening** — linked notes update context/tags/embeddings when new details arrive. The `evolution_history` is a full audit trail.
- 🚦 **LLM CRUD gate** — the LLM analyzes a user↔assistant exchange and decides `NEW` / `UPDATE` / `DELETE` / `NONE` to keep memory clean.
- 🧹 **Same-day merge + daily consolidation** — the engine merges semantic duplicates (≥ 0.80 same-day, ≥ 0.75 in the 02:30 sweep) and **cascades link references** to preserve graph topology.
- ⏳ **Temporal soft-delete** — the engine marks outdated and conflicting notes `is_active: false` (zero-migration Qdrant filter) and excludes them from search.
- 🔥 **Heat tracking with time decay** — `retrieval_count` + `last_accessed` give a logarithmic boost. Age dampens the boost so stale notes do not permanently outrank fresh ones:

  ```
  Final Score = RRF Score × (1 + 0.05 × ln(1 + retrieval_count) / (age_days + 1))
  ```

- 🔍 **2-hop graph traversal with relevance gate** — BFS walks from anchors and admits only nodes with cos-sim ≥ 0.25 to the query.
- 🀄 **Chinese-optimized BM25** — [Jieba](https://github.com/fxsjy/jieba) (`@node-rs/jieba`) provides word segmentation for Chinese. Whitespace segmentation is the fallback elsewhere. Japanese and Korean get no lexical tokens, but dense retrieval still covers them.
- 🧠 **Knowledge vs episodic** — `note_type` separates durable `knowledge` (skips consolidation-merge + time-decay) from `memory`. The `topics` tags and `topicsFilter` enable subject-level recall.
- 🔐 **Multi-agent isolation** — every note has explicit `owner` / `readers` / `writers` fields. Mode A uses a shared collection filtered by `agent_id`. Mode B uses a dedicated collection.
- 📊 **Quality controls** — the write-time gate rejects content shorter than 10 characters and flags ephemeral notes. `scanLowQuality` finds too-short, expired, and conflicting notes.

## Architecture

```
host (OpenClaw plugin / amem-api / game agent)
     │  addMemory / searchMemory / consolidate ...
     ▼
  @amemhq/core (TypeScript)
     ├── LLM (Anthropic)        note construction · link judgment · CRUD · evolution
     ├── Transformers.js (ONNX) local embeddings + Jieba BM25
     └── Qdrant :6333           vector store · owner/readers/writers · agent_id isolation
```

## Memory Evolution

When a new note is borderline-similar to an existing one (cosine 0.72–0.85), @amemhq/core routes it through an **LLM evolution judgment** instead of naive dedup. The LLM classifies the relationship:

| Type | Meaning | Action |
| --- | --- | --- |
| **EVOLVE** | New info deepens/updates the old note | Old content updated, `evolution_history` appended, new note absorbed |
| **CONFLICT** | Old and new contradict | Both kept, both marked `conflict: true` |
| **EXPAND** | New info complements the old | Content merged into old note, history appended, new note absorbed |
| **NEW** | Unrelated | Both kept as-is |

Memories **evolve** rather than being silently overwritten. The `evolution_history` is a full audit trail. (Taxonomy per the SSGM framework, arXiv:2603.11768.)

## Quality Scoring

- **Write-time gate** (`checkQuality`) — the gate rejects content shorter than 10 chars. Temporal signal words (`待跑`, `等确认`, `昨日`, `明天完成`) flag the note `ephemeral: true`.
- **Periodic scan** (`scanLowQuality` / `generateReviewBatch`) — flags `too_short`, `expired_ephemeral` (> 7 days), and `pending_conflict`. It patches `low_quality: true` and emits an Obsidian-compatible review batch.

## Multi-Agent Isolation

Every `MemoryNote` carries access fields:

```ts
{ owner: 'main', readers: ['main'], writers: ['main'] } // readers: ['*'] = shared with all agents
```

- **Mode A** (default) — one shared Qdrant collection, isolated by `agent_id` at query time. Setting `agent_id="shared"` (explicit, auditable) publishes a note to all agents.
- **Mode B** — a dedicated collection per agent for full physical isolation.

Isolation is the default. Sharing is an explicit exception (per arXiv:2604.16548). Consolidation runs per-agent scope.

## Usage

```ts
import { configure, addMemory, searchMemory, createStorageContext } from '@amemhq/core'

configure({ dataDir: '~/.myapp' }) // evo counter + consolidation logs (default ~/.amem, or AMEM_DATA_DIR)

const storageCtx = createStorageContext(/* collection */ undefined, /* modeBIsolated */ false)
await addMemory('The player prefers building with oak.', 'game-agent', { storageCtx })
const hits = await searchMemory('what does the player like to build with?', 5, 'game-agent', { storageCtx })
```

## Requirements

- Node.js 24 (18+ works)
- [Qdrant](https://qdrant.tech) on `:6333`
- An LLM for note, link, and evolution calls — `ANTHROPIC_API_KEY` is the default. To use any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, vLLM…), set `AMEM_LLM_PROVIDER=openai` with `AMEM_LLM_BASE_URL` and `AMEM_LLM_API_KEY`.

## References & Citation

| Reference | Role |
| --- | --- |
| Xu et al., _A-MEM: Agentic Memory for LLM Agents_, NeurIPS 2025 · [arXiv:2502.12110](https://arxiv.org/abs/2502.12110) | Core architecture |
| Cormack et al., _Reciprocal Rank Fusion…_, SIGIR 2009 | RRF fusion of BM25 + dense |
| Robertson & Zaragoza, _The Probabilistic Relevance Framework: BM25 and Beyond_, 2009 | BM25 ranking (k1=1.5, b=0.75) |
| _Governing Evolving Memory in LLM Agents: SSGM_, arXiv:2603.11768, 2026 | Evolution taxonomy (EVOLVE/CONFLICT/EXPAND/NEW) |
| _Security of Long-Term Memory in LLM Agents_, arXiv:2604.16548, 2026 | Isolation-by-default; explicit sharing |
| Chhikara et al., _Mem0…_, ECAI 2025 · [arXiv:2504.19413](https://arxiv.org/abs/2504.19413) | Scope isolation; amem's explicit shared marker |

```bibtex
@inproceedings{xu2025amem,
  title={A-Mem: Agentic Memory for LLM Agents},
  author={Xu, Wujiang and Liang, Zujie and Mei, Kai and Gao, Hang and Tan, Juntao and Zhang, Yongfeng},
  booktitle={Advances in Neural Information Processing Systems (NeurIPS)},
  year={2025}
}
```

## License

MIT © heichaowo

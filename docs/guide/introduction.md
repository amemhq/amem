# Introduction

**amem** is an agentic-memory stack for LLM agents — memory that **constructs, links, and evolves** notes like a Zettelkasten instead of dumping flat vector rows. It is an open-source implementation of the **A-MEM** research (NeurIPS 2025), written in TypeScript on top of Qdrant + local Transformers.js. **No Python required.**

## The amem stack

amem is a monorepo you can adopt one piece at a time:

| Package | Role | Status |
| --- | --- | --- |
| [`@amemhq/core`](https://www.npmjs.com/package/@amemhq/core) | **Engine** — note construction, evolution, hybrid retrieval. Framework-agnostic. | shipping |
| [`openclaw-amem`](https://www.npmjs.com/package/openclaw-amem) | **OpenClaw Plugin** — drops A-MEM into OpenClaw's `memory` slot. | shipping |
| `amem-api` | **Server** — single-writer HTTP + MCP service so many processes share one store. | coming soon |

> **New here? Start with the [OpenClaw Plugin →](/guide/installation).** It's the fastest way to give an agent evolving long-term memory today — the [`amem-core`](https://github.com/amemhq/amem) engine is bundled inside it, so there's nothing extra to install.

---

## What is A-MEM?

A-MEM is a memory architecture for LLM agents inspired by the **Zettelkasten method**. Unlike a flat vector database, A-MEM maintains memory as a living, self-evolving semantic graph. This is the behavior the **`amem-core` engine** implements — every consumer in the stack inherits it.

### The memory lifecycle

1. **Note Construction** — On write, the LLM extracts keywords, tags, a context summary, and categorizes the note (Technical, Business, Personal, Project, Research, System, General).

2. **Link Generation** — Retrieves top-6 candidates; the LLM judges whether to link bidirectionally (similarity > 0.3).

3. **Memory Evolution & Strengthening** — Up to 3 linked memories have their attributes evolved based on the new context, potentially triggering additional links.

4. **Hybrid Retrieval** — Fuses vector search (local ONNX `bge-m3`, 1024-dim) and BM25 using Reciprocal Rank Fusion (RRF), boosted by retrieval frequency (heat).

5. **2-hop BFS Graph Expansion** — After RRF top-K selection, BFS traverses the link graph up to 2 hops, appending up to 8 contextually linked notes. Each candidate passes an embedding relevance gate (cos-sim ≥ 0.25) before admission.

6. **Per-Agent Memory Isolation** — Each agent operates in its own private namespace (`agent_id` filter in Qdrant). Memories written by `main` are invisible to `dev` by default. A `shared` scope (explicit `agent_id="shared"`) allows publishing to all agents. See [Agent Isolation](/guide/agent-isolation) for full details.

---

## Architecture

How the **OpenClaw Plugin** wires the engine in-process:

```
OpenClaw Agent
     │
     ├── memory_search(query)  ──►  openclaw-amem plugin (TypeScript, in-process)
     └── memory_add(text)      ──►       │
                                         ▼
                          ┌──────────────┼──────────────┐
                          ▼              ▼               ▼
                       Qdrant     Transformers.js  LLM (Anthropic/OpenAI)
                    (vector store)  (ONNX embed)   (CRUD decision
                      :6333        local, no Python + link judgment
                   agent_id ISO   + Jieba BM25     + evolution)
```

When `amem-api` ships, this same engine runs as a shared single-writer service instead of in-process — so multiple agents and processes read and write one store.

---

## Academic Background

Based on the paper: _A-MEM: Agentic Memory for LLM Agents_ — [arXiv:2502.12110](https://arxiv.org/abs/2502.12110) (NeurIPS 2025). For the original research implementation, see [agiresearch/A-MEM](https://github.com/agiresearch/A-MEM).

```bibtex
@inproceedings{xu2025amem,
  title={A-Mem: Agentic Memory for LLM Agents},
  author={Xu, Wujiang and Liang, Zujie and Mei, Kai and Gao, Hang and Tan, Juntao and Zhang, Yongfeng},
  booktitle={Advances in Neural Information Processing Systems (NeurIPS)},
  year={2025}
}
```

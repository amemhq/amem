---
layout: home

hero:
  name: amem
  text: Agentic memory that evolves
  tagline: An open-source agentic-memory stack for LLM agents — memories evolve, not just accumulate. Graph linking, hybrid retrieval, LLM-driven evolution. TypeScript, local embeddings, no Python.
  image:
    src: /logo.webp
    alt: A-MEM Logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/introduction
    - theme: alt
      text: View on GitHub
      link: https://github.com/amemhq/amem
    - theme: alt
      text: npm
      link: https://www.npmjs.com/package/openclaw-amem

features:
  - icon: 🔄
    title: Dynamic Memory Network
    details: Inspired by Zettelkasten. Memories are stored as nodes in a graph with automatic bidirectional link generation and LLM-verified connections — not flat vector rows.
  - icon: 🧬
    title: Memory Evolution & Consolidation
    details: Linked memories evolve context, tags, and embeddings when new details arrive. A near-identical write (≥ 0.85) folds into the note it matches instead of becoming a second one; 0.72–0.85 is stored but flagged for review. Daily consolidation at 02:30 merges the rest.
  - icon: 🚦
    title: LLM CRUD Gate & Quality Controls
    details: Hooked into agent_end to run NEW / UPDATE / DELETE / NONE decisions after a turn that succeeded. A write-time quality gate rejects low-quality content; memory_quality_scan surfaces stale or conflicting entries.
  - icon: 🔍
    title: Hybrid Retrieval & Heat Tracking
    details: BM25 + dense vector hybrid (RRF) with 2-hop BFS graph expansion. Frequently retrieved memories get a logarithmic heat boost dampened by time decay, so fresh facts stay on top.
  - icon: 🧠
    title: Knowledge vs Episodic
    details: Notes are auto-classified as memory (episodic) or knowledge (durable). Knowledge notes carry topic tags and skip consolidation merging and time-decay penalties.
  - icon: 🀄
    title: Chinese-Optimized BM25
    details: Uses Jieba (via @node-rs/jieba) to segment Chinese, which is what makes BM25 work on it at all. English and mixed text fall back to whitespace tokenization. Japanese and Korean get nothing usable — Korean and kana-only Japanese produce no tokens at all, and Japanese containing kanji is segmented as though it were Chinese — a 13-word sentence yields 2 tokens. Dense retrieval covers both, so search works on one half of the hybrid rather than two.
  - icon: 🔐
    title: Per-Agent Memory Isolation
    details: Each agent operates in its own private namespace — memories written by main are invisible to dev by default. An explicit shared scope plus owner/readers/writers fields on every note control cross-agent access.
---

## Install the OpenClaw plugin

The fastest way to try amem today is the **openclaw-amem** plugin — the `amem-core` engine is bundled inside, so there is nothing else to install.

::: code-group

```bash [ClawHub]
openclaw plugins install clawhub:openclaw-amem
```

```bash [npm]
openclaw plugins install openclaw-amem
```

:::

Point OpenClaw's `memory` slot at `openclaw-amem` and your agent remembers across sessions — linking, evolving, and consolidating on its own. → **[Full installation guide](/guide/installation)**

## The amem stack

amem is a monorepo you can adopt one piece at a time.

| Package | Role | Status |
| --- | --- | --- |
| **@amemhq/core** | **Engine** — note construction, evolution, hybrid retrieval. Framework-agnostic. | shipping · [npm](https://www.npmjs.com/package/@amemhq/core) · also bundled in the plugin |
| **openclaw-amem** | **OpenClaw Plugin** — drops A-MEM into OpenClaw's `memory` slot. | shipping · [npm](https://www.npmjs.com/package/openclaw-amem) · ClawHub |
| **amem-api** | **Server** — single-writer HTTP + MCP service so many processes share one store. | *coming soon* |

## Grounded in research

openclaw-amem implements **[A-MEM: Agentic Memory](https://arxiv.org/abs/2502.12110)** (NeurIPS 2025) — memory that constructs, links, and evolves notes like a Zettelkasten instead of dumping flat vector rows. Embeddings run locally via Transformers.js and are stored in Qdrant. **No Python, no external embedding API.** MIT-licensed.

<div class="tip custom-block" style="padding-top: 8px">

In a hurry? Jump straight to the **[Quick Start](/guide/quick-start)**.

</div>

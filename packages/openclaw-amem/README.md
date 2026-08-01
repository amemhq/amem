# openclaw-amem

<p align="center">
  <img src="https://raw.githubusercontent.com/amemhq/amem/main/docs/public/logo.webp" width="120" alt="amem logo" />
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](../../LICENSE)
[![npm](https://img.shields.io/npm/v/openclaw-amem?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/openclaw-amem)
[![arXiv](https://img.shields.io/badge/arXiv-2502.12110-b31b1b?style=for-the-badge)](https://arxiv.org/abs/2502.12110)

**Memory for [OpenClaw](https://github.com/openclaw/openclaw) agents that catches its own contradictions.**

A nightly pass re-reads what changed and flags memories that no longer agree with each other — the failure mode every long-lived memory store eventually has. The rest: facts extracted instead of transcripts stored, notes rewritten as new ones arrive, linked into a Zettelkasten-style graph, retrieved with hybrid BM25 + dense search over 2-hop expansion. Memories are scoped per agent (`owner`/`readers`/`writers`) and per subject, both enforced inside the Qdrant query rather than filtered after it.

Runs on a small model — `gpt-4o-mini`, `haiku`, a local Ollama. No Python.

中文走 [jieba](https://github.com/messense/node-jieba) 分词，提示词有完整中文版（`AMEM_PROMPT_LOCALE=zh`），embedding 模型本身多语言。

Requires a local [Qdrant](https://qdrant.tech). Implements [A-MEM](https://arxiv.org/abs/2502.12110) (arXiv 2502.12110); the engine itself is [`@amemhq/core`](../amem-core).

> 📖 Full guides, architecture & references: **[amem.owo.lc](https://amem.owo.lc)**.

⭐ Useful? [Star it on GitHub](https://github.com/amemhq/amem).

## Highlights

- 🔄 **Memories evolve** — new facts update/link related memories (EVOLVE / CONFLICT / EXPAND / NEW), not silent overwrite.
- 🔍 **Hybrid retrieval** — BM25 (Jieba for Chinese) + dense vectors (RRF) + 2-hop graph expansion with a relevance gate.
- 🧠 **Knowledge vs episodic** — durable knowledge notes skip consolidation & time-decay; topic tags for precise recall.
- 🧹 **Self-consolidating** — daily 02:30 in-process merge of semantic duplicates with link cascading.
- 🔐 **Per-agent isolation** — private by default; explicit `owner`/`readers`/`writers`; Mode A (shared collection) or Mode B (dedicated collection).
- 🀄 **Chinese-optimized** & local embeddings (Transformers.js) — no Python, no external embedding API.

→ Full feature list & internals: **[@amemhq/core README](../amem-core)** · **[docs](https://amem.owo.lc)**.

## Requirements

- OpenClaw v2026.4+
- Node.js 24 (18+ works; 24/26 supported)
- Qdrant running on `:6333`
- An LLM: `ANTHROPIC_API_KEY` by default, or any OpenAI-compatible provider — see [LLM provider](#llm-provider)
- ~1.1 GB of disk for the embedding model, downloaded once on first run

## Installation

### 1. Install the plugin

```bash
# From ClawHub (recommended)
openclaw plugins install clawhub:openclaw-amem

# From npm
openclaw plugins install openclaw-amem

# From a local checkout of the amem monorepo
pnpm --filter openclaw-amem build
openclaw plugins install --link ./packages/openclaw-amem
```

Updating:

```bash
openclaw plugins update openclaw-amem
```

OpenClaw asks you to restart the gateway afterwards; whether it is actually needed
depends on your setup, so check whether search works before running
`openclaw gateway restart`.

An update rebuilds `node_modules`, and the model cache lives there by default — so
it re-downloads 2.27 GB unless `AMEM_MODEL_CACHE` points somewhere outside the
plugin directory. Set that once and updates cost nothing.

### 2. Configure `~/.openclaw/openclaw.json`

Add `openclaw-amem` to your allowed plugins and hook it into the `memory` slot:

```json
{
  "plugins": {
    "allow": ["openclaw-amem"],
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "topK": 5
        }
      }
    },
    "slots": {
      "memory": "openclaw-amem"
    }
  }
}
```

> **⚠️ Memory slot conflict:** If your `openclaw.json` already assigns the `memory` slot to another plugin (e.g. `memory-core`), you **must** change it to `openclaw-amem`. The gateway only loads one plugin per slot — any additional `memory`-kind plugins are **silently skipped**. Set `"memory-core": { "enabled": false }` in `entries` to disable the old plugin.

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

First run downloads the embedding model (`bge-m3`, 2.27 GB) and caches it. Later
restarts are instant. If that is too much, the only smaller model worth setting is
`AMEM_EMBED_MODEL=Xenova/bge-small-zh-v1.5` — 25 MB, Chinese only, and it caps at
512 tokens. Set it **before** you have memories, since changing it afterwards means
a [migration](https://amem.owo.lc/reference/embedding-models#changing-the-model-on-a-store-you-already-have).

Upgrading from 1.x downloads nothing. Your existing memories keep the model that
built them, and the plugin says so at startup along with the one command that
moves them.

## LLM provider

The plugin calls an LLM for note construction, linking, and evolution. Pick the backend with `AMEM_LLM_PROVIDER`:

- **`anthropic`** (default) — the Anthropic Messages API. Set `ANTHROPIC_API_KEY`.
- **`openai`** — the OpenAI Chat Completions API, which every OpenAI-compatible endpoint speaks. Set `AMEM_LLM_PROVIDER=openai`, point `AMEM_LLM_BASE_URL` at the endpoint, and set `AMEM_LLM_API_KEY` (or the standard `OPENAI_API_KEY`). Covers **OpenAI, DeepSeek, OpenRouter, Groq, Together**, and local servers (**Ollama, vLLM, LM Studio** — no key needed). Reasoning models (`o1`, `o3`, `gpt-5`) are handled automatically.

Choose the model with `AMEM_LLM_MODEL`. Full env-var reference and examples: **[amem.owo.lc/reference/configuration](https://amem.owo.lc/reference/configuration)**.

## Configuration Reference

| Key                             | Type                                      | Default  | Description                                                                                                                          |
| ------------------------------- | ----------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`                       | `string`                                  | `"main"` | Agent namespace for memory isolation                                                                                               |
| `topK`                          | `number`                                  | `5`      | Maximum memories to retrieve during search                                                                                         |
| `agents`                        | `Record<string, {agentId?, collection?}>` | `{}`     | Per-agent overrides. Set `collection` for Mode B physical isolation.                                                               |
| `hooks.allowConversationAccess` | `boolean`                                 | `false`  | **Required** for automatic memory write-back. Without it, the `agent_end` hook is silently blocked by OpenClaw's security policy. |

## Tools

Once installed, the plugin exposes five tools to the agent:

| Tool | What it does |
| --- | --- |
| `memory_add` | Write a memory — hash dedup, LLM note construction, bidirectional linking, evolution. |
| `memory_search` | Search via RRF (BM25 + cosine) with heat ranking + 2-hop BFS graph expansion. Accepts `topicsFilter`. |
| `memory_list` | Total active note count for the current agent namespace. |
| `memory_consolidate` | Manually trigger category-based semantic dedup + link cascading. |
| `memory_quality_scan` | Scan for low-quality/expired/conflicting notes → Obsidian-compatible review batch file. |

## Security & data flow

A memory plugin's job is to read configuration from the environment and send memory data to backends **you** control, so registry static scanners flag its `env` + `network` pattern (e.g. ClawHub's `suspicious.env_credential_access`). This is structurally expected for any configurable memory/LLM plugin — the audit outcome is **advisory (`Review`), not `Malicious`**, and VirusTotal reports the bundle clean.

What it actually does — all of it declared in [`openclaw.plugin.json`](openclaw.plugin.json):

- **Environment variables it reads** (its configuration surface, supplied by you): `AMEM_LLM_PROVIDER`, `AMEM_LLM_API_KEY`, `OPENAI_API_KEY`, `AMEM_LLM_BASE_URL`, `AMEM_LLM_MODEL`, `AMEM_COLLECTION`, `AMEM_DATA_DIR`, `AMEM_EVO_COUNTER_PATH`, `AMEM_REVIEW_DIR`, `AMEM_PROMPT_LOCALE`. No credential is bundled, hardcoded, or logged.
- **Network destinations**: only your **local Qdrant** (`http://localhost:6333`) and your configured **LLM endpoint** (Anthropic by default, or any OpenAI-compatible endpoint via `AMEM_LLM_PROVIDER=openai` + `AMEM_LLM_BASE_URL`). It sends memory text/embeddings there to store and evolve notes — its stated purpose. It does not phone home.
- **Conversation content** is processed for memory only when you set `hooks.allowConversationAccess: true`. Keep Qdrant and review-output paths scoped to locations you control.

## Development

This package is part of the **[amem monorepo](../../)**. From the repo root:

```bash
pnpm install
pnpm -r build                       # build all packages
pnpm --filter openclaw-amem build   # build just the plugin
pnpm --filter openclaw-amem test    # vitest (needs Qdrant on :6333)
```

## Docs & References

Full guides, architecture, and academic references: **[amem.owo.lc](https://amem.owo.lc)** · engine: **[@amemhq/core](../amem-core)** · paper: [A-MEM (arXiv:2502.12110)](https://arxiv.org/abs/2502.12110).

## License

MIT

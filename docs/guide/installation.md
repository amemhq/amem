# Installation

## Requirements

| Dependency  | Version                                                        |
| ----------- | -------------------------------------------------------------- |
| OpenClaw    | v2026.4+                                                       |
| Node.js     | 18+ (Node 24/26 fully supported)                               |
| Qdrant      | Running on `:6333`                                             |
| LLM access  | `ANTHROPIC_API_KEY` (default), or any OpenAI-compatible provider — see [LLM provider](#llm-provider) |

Qdrant can be started via Docker:

```bash
docker run -p 6333:6333 qdrant/qdrant
```

---

## Install the plugin

```bash
# From npm (recommended)
openclaw plugins install openclaw-amem

# From a local checkout of the amem monorepo
pnpm --filter openclaw-amem build
openclaw plugins install --link ./packages/openclaw-amem
```

### Updating

```bash
openclaw plugins update openclaw-amem
openclaw gateway restart
```

Two things worth knowing before you run it.

**It rebuilds `node_modules`, which is where the model cache lives by default** —
so an update re-downloads 2.27 GB unless you have set `AMEM_MODEL_CACHE` to a path
outside the plugin directory. Set it once and updates stop costing a download:

```bash
AMEM_MODEL_CACHE=~/.openclaw/model-cache
```

**Check whether you still need any workaround you added.** `AMEM_EMBED_DTYPE=fp32`
was needed on 2.0.0 and 2.0.1, whose default could not load; from 2.1.0 the default
is correct and that variable can go. A stale override is not harmless — it pins you
to a choice the release has moved past.

---

## Configure `openclaw.json`

Add `openclaw-amem` to your plugin config and hook it into the `memory` slot:

```json
{
  "plugins": {
    "allow": ["openclaw-amem"],
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
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

::: warning Memory slot conflict
If your `openclaw.json` already has a `memory` slot assigned to another plugin (e.g. `memory-core`), **you must replace it** with `openclaw-amem`. The gateway only loads one plugin per slot — a second `memory`-kind plugin is **silently skipped** with no log output.

```json
// ❌ Will cause amem to be silently ignored
"slots": {
  "memory": "memory-core"
}

// ✅ Correct — amem replaces memory-core
"slots": {
  "memory": "openclaw-amem"
}
```

If you were previously using `memory-core`, you can safely remove or disable it in `plugins.entries`:

```json
"entries": {
  "memory-core": { "enabled": false },
  "openclaw-amem": {
    "enabled": true,
    "hooks": { "allowConversationAccess": true },
    "config": { "agentId": "main", "topK": 5 }
  }
}
```

:::

> **Required:** `hooks.allowConversationAccess: true` must be set explicitly. Without it, the `agent_end` hook is blocked by OpenClaw's security policy and **automatic memory write-back will not work** — memories will only be written when you call `memory_add` manually.

> If `allowConversationAccess` is not set, the plugin will log a warning after 10 minutes of startup and append a notice to every `memory_search` result indicating that write-back is disabled (Story 34).

---

## Restart OpenClaw

```bash
openclaw gateway restart
```

On first run, the plugin downloads the `bge-m3` ONNX embedding model (2.27 GB) and caches it locally. Subsequent restarts are instant.

Upgrading rather than installing fresh? Nothing is downloaded — an existing store keeps the model that built it, and moving to `bge-m3` is a [deliberate migration](/reference/embedding-models#changing-the-model-on-a-store-you-already-have). If 2.27 GB is more than you want, see [choosing a smaller model](/reference/embedding-models#why-bge-m3-is-the-default) — the obvious candidate does not load, and the ones that do give up either the context window or English.

---

## LLM provider

The engine calls an LLM for note construction, linking, and evolution. Choose the backend with `AMEM_LLM_PROVIDER`:

- **`anthropic`** (default) — the Anthropic Messages API. Set `ANTHROPIC_API_KEY`.
- **`openai`** — the OpenAI Chat Completions API, which every OpenAI-compatible endpoint speaks. Set `AMEM_LLM_PROVIDER=openai`, point `AMEM_LLM_BASE_URL` at the endpoint, and set `AMEM_LLM_API_KEY` (or the standard `OPENAI_API_KEY`). This covers **OpenAI, DeepSeek, OpenRouter, Groq, Together**, and local servers (**Ollama, vLLM, LM Studio** — no key needed).

```bash
# DeepSeek
AMEM_LLM_PROVIDER=openai AMEM_LLM_BASE_URL=https://api.deepseek.com/v1 \
AMEM_LLM_API_KEY=sk-... AMEM_LLM_MODEL=deepseek-chat

# Local Ollama (keyless)
AMEM_LLM_PROVIDER=openai AMEM_LLM_BASE_URL=http://localhost:11434/v1 \
AMEM_LLM_MODEL=qwen2.5
```

Full env-var reference and model recommendations: **[Configuration →](/reference/configuration)**.

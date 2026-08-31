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
```

The gateway does not load the new build automatically. Restart it:

```bash
openclaw gateway restart
```

Know these two things before you update.

**An update rebuilds `node_modules`, which is where the model cache lives by default.** As a result, an update re-downloads 2.27 GB unless you have set `AMEM_MODEL_CACHE` to a path outside the plugin directory. Set it once. After that, updates do not require a download:

```bash
AMEM_MODEL_CACHE=~/.openclaw/model-cache
```

**Check whether you still need any workaround you added.** `AMEM_EMBED_DTYPE=fp32` was needed on 2.0.0 and 2.0.1, whose default did not load. From 2.1.0 the default is correct and that variable can go. A stale override is not harmless. It pins you to a choice the release has moved past.

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
If your `openclaw.json` already has a `memory` slot assigned to another plugin (for example `memory-core`), **you must replace it** with `openclaw-amem`. The gateway only loads one plugin per slot. The gateway **silently skips** a second `memory`-kind plugin with no log output.

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

> **Required:** `hooks.allowConversationAccess: true` must be set explicitly. Without it, OpenClaw's security policy blocks the `agent_end` hook and **automatic memory write-back will not work**. The plugin writes memories only when you call `memory_add` manually.

> If `allowConversationAccess` is not set, the plugin logs a startup warning. It also appends a notice to every `memory_search` result saying write-back is disabled. The plugin decides this once, by reading the configuration, rather than by waiting to see whether the hook ever fires.

---

## Restart OpenClaw

```bash
openclaw gateway restart
```

On first run, the plugin downloads the `bge-m3` ONNX embedding model (2.27 GB) and caches it locally. Subsequent restarts are instant.

If you upgrade rather than install fresh, no download occurs. An existing store keeps the model that built it. Moving to `bge-m3` is a [deliberate migration](/reference/embedding-models#changing-the-model-on-a-store-you-already-have). If 2.27 GB is more than you want, see [choosing a smaller model](/reference/embedding-models#why-bge-m3-is-the-default). The obvious candidate does not load. The ones that do give up either the context window or English.

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

For the full environment variable reference and model recommendations, see **[Configuration →](/reference/configuration)**.

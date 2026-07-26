# Configuration

## Plugin config (`openclaw.json`)

```json
{
  "plugins": {
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "topK": 5
        }
      }
    }
  }
}
```

### Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agentId` | `string` | `"main"` | Agent namespace for memory isolation. Notes from different agents are stored separately in Qdrant. |
| `topK` | `number` | `5` | Maximum memories returned by `memory_search`. |
| `agents` | `Record<string, {agentId?, collection?}>` | `{}` | Per-agent overrides. Set `collection` for Mode B physical isolation. |
| `llmProvider` | `"anthropic" \| "openai"` | `"anthropic"` | Request format for the engine's own LLM calls. See [LLM settings](#llm-settings) below. |
| `llmModel` | `string` | `claude-sonnet-4-6` (anthropic) · `gpt-4o-mini` (openai) | Model used for note construction, linking and evolution. |
| `llmBaseURL` | `string` | provider default | Endpoint for LLM calls, e.g. an OpenAI-compatible gateway. |
| `llmStrongProvider` | `string` | falls back to `llmProvider` | Optional strong tier: request format. |
| `llmStrongModel` | `string` | falls back to `llmModel` | Optional strong tier: model for the hard judgements. Unset = single-model behaviour. |
| `llmStrongBaseURL` | `string` | falls back to `llmBaseURL` | Optional strong tier: endpoint. |
| `llmCrudRole` | `"fast" \| "strong"` | `"fast"` | Which tier the `agent_end` CRUD decision runs on. |
| `conflictSweep` | `boolean` | `true` | Run the nightly contradiction sweep. See [Contradiction sweep](#contradiction-sweep). |
| `crudUpdateMinSim` | `number` | `0.35` | Similarity floor for accepting an LLM-chosen `UPDATE` target. See [CRUD update safety](#crud-update-safety). |
| `hooks.allowConversationAccess` | `boolean` | `false` | Required for `agent_end` hook access. Set under `plugins.entries.openclaw-amem.hooks`, not under `config`. Without this, automatic memory write-back is silently blocked by OpenClaw. |

### CRUD update safety

When the `agent_end` hook decides an existing memory should be **updated**, it
picks one from a numbered list of candidates. Picking the wrong number is the
one write-path mistake that is both silent and destructive: the index is valid,
the note is usually one you own, so nothing structural catches it — and the
update overwrites that memory's text in place.

Two guards, both on by default:

- Before overwriting, the engine checks the replacement text is plausibly *about*
  the memory it is replacing (cosine similarity ≥ `crudUpdateMinSim`). If not, the
  fact is stored as a **new** memory instead. Nothing is lost either way —
  scheduled consolidation can merge a duplicate later, but it cannot resurrect an
  overwritten note.
- The replaced text is kept in the note's `evolution_history` (`action:
  "crud_update"`), so even an accepted overwrite stays recoverable.

`crudUpdateMinSim` is a heuristic, not a tuned constant. It sits just above the
`0.3` bar the engine uses for "related at all", because a legitimate update is
often a correction ("drinks tea" → "switched to coffee") that is related but not
near-identical. **Raise it when running a cheaper or smaller model** — those are
likelier to mis-pick, and the cost of being strict is a duplicate rather than a
destroyed memory.

### Memories about different people

`agent_id` says **whose memory store** a note lives in. It does not say **who the
note is about** — and for a companion that meets several people, those are
different questions. One character, one store, many people it remembers.

Every memory carries `subjects`, a list of who it concerns:

| `subjects` | meaning | who sees it |
| :--- | :--- | :--- |
| `[]` *(default)* | a fact about the world, or about the character itself | everyone |
| `["alex"]` | about one person | only when scoped to them |
| `["alex", "sam"]` | a shared experience | either of them |

An array rather than a single value because shared experience is the normal case
for a companion — *"we beat the dragon together"* belongs to both people, and
splitting it into two near-identical memories would just give the deduplicator
something to merge back.

```
memory_add   { text: "alex prefers mining at night", subjects: ["alex"] }
memory_add   { text: "we beat the dragon together",  subjects: ["alex","sam"] }
memory_add   { text: "the server spawn is a desert" }        // about nobody

memory_search { query: "mining", subject: "alex" }
  → alex's own memories + shared ones + world facts.  Never sam's.
```

Scoping happens in the vector-store query, not after the fact, so an out-of-scope
memory is never fetched at all. Both retrieval paths — semantic and keyword — are
scoped together.

::: tip Nothing changes until you use it
`subjects` defaults to empty, so every memory written before this existed is a
world fact and stays visible exactly as before. Omit `subject` on a search and
you get today's behaviour.
:::

### Contradiction sweep

The per-turn CRUD decision runs on the fast model. That is safe — the update
guard stops it writing to the wrong memory — but **dull**: it misses
contradictions it should have caught. A cheap model scores around 8.7% at
noticing that a stored memory has quietly stopped being true.

So a sweep runs nightly, after the daily consolidation, in batches, on the **strong** tier
(or the fast one, if no strong model is configured — nothing starts costing more
on its own). Set `conflictSweep: false` to turn it off.

It only re-reads batches that **gained a memory** since the last run, so the first
night costs roughly one call per 25 memories and every night after that costs one
or two. The tradeoff is worth stating: a new memory is compared against the batch
it lands in — its category's most recent — not against the entire history, so a
contradiction between two old memories that never shared a batch is not found.
Clearing `conflict_scanned_at` forces a full re-read. It hands the model a
whole batch of memories at once rather than comparing them pairwise, because the
contradictions that matter are often *far apart* in meaning — "is vegetarian" and
"loved the steak" would never be paired by a similarity check. When it finds a
pair, it marks **both** notes with a pointer to the other and the reason, so the
conflict can be reviewed as **one decision** rather than two disconnected entries.

| `AMEM_CONFLICT_MODE` | What happens |
| :--- | :--- |
| `review` *(default)* | Both notes are flagged and appear in the quality review batch. Nothing is removed. You decide. |
| `auto` | As above, **and** the note the model identifies as *superseded* is retired automatically. If it cannot tell which one that is, nothing is retired. |

::: danger Read this before enabling `auto`
Even a strong model is only around **55%** accurate at spotting implicit
contradictions. In `auto` mode that means roughly **two in five retirements will
silence a memory that was still true**.

Which side gets retired is the model's *semantic* judgement, never a timestamp
comparison. A note records when it was **written down**, not when the fact became
true, and the two come apart constantly — "back in 2019 I was vegetarian",
recorded today, is the newer row and the older fact. Retiring by write time would
get that case exactly backwards. When the model cannot tell which side is
superseded, the pair is flagged for review and **nothing is retired**.

The retirement is a soft delete — the note and its text survive and can be
restored — but for a system answering in real time, "recoverable" only helps once
somebody notices. `review` is the default for this reason.
:::

### Choosing models: a fast one and (optionally) a strong one

amem splits its own LLM calls into two tiers, because they are not equally hard:

| Tier | What runs on it | What to configure |
| :--- | :--- | :--- |
| **fast** | Almost everything: extracting keywords and tags, judging whether two notes link, refreshing a note's context, and the per-turn CRUD decision | **A cheap, fast model.** Local models are fine — this is the high-frequency path |
| **strong** | Only the genuinely hard judgements: deciding whether two memories should merge, and classifying whether new information contradicts what is stored | **A more capable model** — or nothing at all |

**If you configure only one model, everything runs on it.** That is the default and
it works. The `strong` tier is opt-in: leave it unset and `strong` simply *is*
`fast`, exactly as before.

Why the split: for extraction, a cheap model scores within ~2 points of a strong
one — but for spotting that a new fact *contradicts* a stored one, the gap is
large. So it is worth paying for a better model on the handful of calls that
actually need it, and not on the thousands that do not. The reasoning and the
evidence are in [Design Rationale](/guide/design-rationale).

```json
{
  "plugins": {
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "config": {
          "llmProvider": "openai",
          "llmModel": "gpt-4o-mini",

          "llmStrongModel": "gpt-4o"
        }
      }
    }
  }
}
```

Each `strong` field falls back to its `fast` counterpart **individually**, which
makes all three useful shapes work:

- **Same provider, better model** — set only `llmStrongModel`. Most common.
- **Two different backends** — set all three `llmStrong*` fields. This is how you
  run a local Ollama for the fast tier and a hosted API for the strong one.
- **One model for everything** — set none of them.

::: tip Which model is "fast enough"?
Any competent instruction-following model that reliably returns JSON. `gpt-4o-mini`,
`claude-haiku`, `gemini-flash`, `deepseek-chat` and comparable local models are all
in range. amem does not need a reasoning model here, and reasoning models can
actually do *worse* inside a fixed pipeline like this one.
:::

::: warning There is no built-in strong default
If you do not set a `strong` model, amem will not silently pick a pricier one for
you. You have to ask for it.
:::

### LLM settings

The engine makes its own small LLM calls — extracting keywords and tags, judging
whether two notes should link, evolving a neighbourhood. You can point those at a
different model or endpoint than the one your agent session uses:

```json
{
  "plugins": {
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "config": {
          "llmProvider": "openai",
          "llmModel": "gpt-4o-mini",
          "llmBaseURL": "http://localhost:11434/v1"
        }
      }
    }
  }
}
```

**Precedence**, highest first:

1. the environment variable (`AMEM_LLM_PROVIDER`, `AMEM_LLM_MODEL`, `AMEM_LLM_BASE_URL`)
2. the plugin config keys above
3. the built-in default for the provider

An environment variable set to an empty string counts as unset, so it cannot
silently shadow your config.

> **API keys are not configurable here, by design.** Keys are read from the
> environment only (`AMEM_LLM_API_KEY`, or the provider's own variable). A key
> field in `openclaw.json` would make the memory engine a channel for your
> credentials; endpoint and model are enough to route a call.

These are explicit settings — the engine does **not** currently follow whichever
model your agent session is using. That is deliberate: these are cheap,
high-frequency utility calls, and inheriting a large reasoning model would make
every memory write slow and expensive.

### Per-agent configuration (`agents`)

Each agent can override its `agentId` and optionally use a dedicated Qdrant collection (Mode B physical isolation):

```json
{
  "plugins": {
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "topK": 5,
          "agents": {
            "dev": {
              "agentId": "dev"
            }
          }
        }
      }
    }
  }
}
```

For full physical isolation (Mode B), add a `collection` field:

```json
"agents": {
  "dev": {
    "agentId": "dev",
    "collection": "amem_notes_dev"
  }
}
```

See [Agent Isolation](/guide/agent-isolation) for a full explanation of Mode A vs Mode B.

## Environment variables

These environment variables override plugin defaults at runtime. Useful for testing or scripting without modifying config files.

| Variable | Default | Description |
|----------|---------|-------------|
| `AMEM_LLM_PROVIDER` | `anthropic` | Request format for LLM calls. `anthropic` uses the native Messages API; `openai` uses the Chat Completions API, which every OpenAI-compatible endpoint speaks (OpenAI, DeepSeek, OpenRouter, Groq, Together, Ollama, vLLM, LM Studio…). |
| `AMEM_LLM_MODEL` | `claude-sonnet-4-6` (anthropic) · `gpt-4o-mini` (openai) | LLM model used for note construction, CRUD decisions, link judgment, and memory evolution. Set to a cheaper model when running smoke tests to avoid consuming production quota. |
| `AMEM_LLM_STRONG_PROVIDER` | falls back to `AMEM_LLM_PROVIDER` | Optional strong tier: request format. See [Choosing models](#choosing-models-a-fast-one-and-optionally-a-strong-one). |
| `AMEM_LLM_STRONG_MODEL` | falls back to `AMEM_LLM_MODEL` | Optional strong tier: model for merge adjudication and contradiction classification. Unset = everything runs on the fast model. |
| `AMEM_LLM_STRONG_BASE_URL` | falls back to `AMEM_LLM_BASE_URL` | Optional strong tier: endpoint. Set all three to run the tiers on different backends. |
| `AMEM_CONFLICT_MODE` | `review` | What the contradiction sweep does with a pair it finds: `review` (mark only) or `auto` (also retire the older one). See [Contradiction sweep](#contradiction-sweep). |
| `AMEM_LLM_CRUD_ROLE` | `fast` | Which tier the `agent_end` CRUD decision uses (`fast` or `strong`). |
| `AMEM_LLM_BASE_URL` | provider default | Override the SDK base URL. Point it at your OpenAI-compatible gateway (with `AMEM_LLM_PROVIDER=openai`) or an Anthropic proxy. |
| `AMEM_LLM_API_KEY` | provider env | Override the API key. If unset, the Anthropic path falls back to `ANTHROPIC_API_KEY` and the OpenAI path to `OPENAI_API_KEY`; if neither is set, the OpenAI path sends a placeholder so keyless local servers (Ollama, vLLM) work. |
| `AMEM_LLM_TIMEOUT` | `30000` | Per-request timeout in milliseconds for the LLM client. Guards against a slow or stuck endpoint (a loaded vLLM, an unreachable gateway) hanging the whole memory-write pipeline. |
| `AMEM_CRUD_UPDATE_MIN_SIM` | `0.35` | Similarity floor (0–1) for accepting an LLM-chosen CRUD `UPDATE` target. See [CRUD update safety](#crud-update-safety). |
| `AMEM_EMBED_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Which model embeds memories. Changing it is a **breaking change** whenever the vector width differs — see [Embedding models](/reference/embedding-models). |
| `AMEM_COLLECTION` | `amem_notes` | Qdrant collection name. Override to use a separate collection for testing. |
| `AMEM_REVIEW_DIR` | `process.cwd()` | Output directory for quality review batch files. |
| `AMEM_EVO_COUNTER_PATH` | `~/.openclaw/amem_evo_cnt.json` | File path for the evolution throttle counter. |
| `AMEM_PROMPT_LOCALE` | `en` | Prompt language for memory CRUD, merge, and evolution functions. Set to `zh` for Chinese prompts (better for Chinese-primary users). |

> `AMEM_DATA_DIR` (the engine's on-disk location for the evolution counter and consolidation logs) is read by the engine but **fixed to `~/.openclaw` by the plugin**, so setting it has no effect when running as the OpenClaw plugin — it applies only when using [`@heichaowo/amem-core`](https://www.npmjs.com/package/@heichaowo/amem-core) directly.

### Example: run smoke test with Gemini

```bash
AMEM_LLM_MODEL=gemini-3.5-flash-low node run_smoketest.mjs
```

## LLM requirements

By default the engine uses the **Anthropic SDK** against `https://api.anthropic.com`. Set `ANTHROPIC_API_KEY` (or `AMEM_LLM_API_KEY`) to authenticate, and `AMEM_LLM_BASE_URL` to point at an Anthropic-compatible proxy.

To use an **OpenAI-compatible** provider instead, set `AMEM_LLM_PROVIDER=openai` and point `AMEM_LLM_BASE_URL` at its endpoint. This covers OpenAI, DeepSeek, OpenRouter, Groq, Together, and local servers (Ollama, vLLM, LM Studio). Reasoning models (`o1`, `o3`, `gpt-5`) are handled automatically.

```bash
# Example: DeepSeek
AMEM_LLM_PROVIDER=openai \
AMEM_LLM_BASE_URL=https://api.deepseek.com/v1 \
AMEM_LLM_API_KEY=sk-... \
AMEM_LLM_MODEL=deepseek-chat node run_smoketest.mjs

# Example: local Ollama (no key needed)
AMEM_LLM_PROVIDER=openai \
AMEM_LLM_BASE_URL=http://localhost:11434/v1 \
AMEM_LLM_MODEL=qwen2.5 node run_smoketest.mjs
```

Recommended models:

| Use case | Model |
|----------|-------|
| Production (Anthropic) | `claude-sonnet-4-6` |
| Production (OpenAI-compatible) | `gpt-4o-mini`, `deepseek-chat` |
| Testing / smoke | `gemini-3.5-flash-low` |

## Qdrant collection schema

The plugin auto-creates the Qdrant collection on first run with:

- **Vector size**: 384 (multilingual-e5-small)
- **Distance**: Cosine
- **Payload fields**: `id`, `content`, `keywords`, `tags`, `context`, `category`, `links`, `retrieval_count`, `last_accessed`, `is_active`, `agent_id`, `created_at`, `updated_at`, `owner`, `readers`, `writers`

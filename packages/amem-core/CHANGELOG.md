# @heichaowo/amem-core

## 0.4.0

### Minor Changes

- [#60](https://github.com/heichaowo/amem/pull/60) [`d903552`](https://github.com/heichaowo/amem/commit/d903552e9f6d8751c712c2383046b69c9c1ae75a) Thanks [@heichaowo](https://github.com/heichaowo)! - Enforce the `writers` access rule on every write path (Access Protocol, Story 33).

  Notes have carried `owner` / `readers` / `writers` since per-agent isolation landed,
  but only `readers` was enforced. Because the agent filter matches
  `agent_id == caller OR agent_id == 'shared'`, every query can return another
  agent's shared note — and each mutation then wrote to it unchecked. An audit of
  the engine found **eight such write sites**: high-similarity dedup, bidirectional
  link generation, evolution (neighbour rewrite and strengthen), the plugin's
  agent_end CRUD update and delete, the quality scan, and consolidation's link
  rewriting. In the worst of them, one agent's write could silently overwrite the
  content and embedding of another agent's shared memory.

  All eight now gate on a new exported rule, `canWrite(note, callerAgentId)` — true
  for the owner, an agent listed in `writers`, or `writers: ['*']`. Denial degrades
  gracefully and never throws: dedup inserts the caller's own note instead of
  overwriting, back-links and evolution skip that note, CRUD ops are logged and
  skipped, and the quality scan no longer flags notes it cannot act on.
  `updateNoteContent` and `invalidateNote` take an optional `callerAgentId` for
  callers that hold only an id (they return `false`, unwritten, when denied);
  omitting it preserves existing behaviour, so consolidation and merge — already
  scoped to their own private notes — are unchanged.

- [#63](https://github.com/heichaowo/amem/pull/63) [`9b22d73`](https://github.com/heichaowo/amem/commit/9b22d73bed52feb12b40e60db807f58cd0e827fd) Thanks [@heichaowo](https://github.com/heichaowo)! - Let a host choose the engine's LLM provider, model and endpoint (Story 35).

  The engine's own LLM settings were frozen at module load: `PROVIDER` and `MODEL`
  were top-level consts, so the only way to change them was to set an environment
  variable before the process started. A host embedding the engine had no way in.

  They now resolve per call, and `configureLlm({ provider, model, baseURL })` lets a
  host set them after import. The OpenClaw plugin wires this to three new config
  keys — `llmProvider`, `llmModel`, `llmBaseURL` — so `openclaw.json` can point
  amem's note construction, linking and evolution at a different model than the one
  your agent session uses. Precedence, highest first: environment variable, then
  plugin config, then the built-in default per provider. Configure nothing and
  behaviour is exactly as before.

  Two deliberate choices worth naming. There is **no way to inject an API key**:
  keys come from the environment only. Configuration arrives from a host config
  file, and a key field would make the memory engine a channel for a user's gateway
  credentials — endpoint and model are enough to route a call. And an environment
  variable set to the **empty string now counts as unset**, so an exported-but-blank
  `AMEM_LLM_MODEL` can no longer silently outrank a valid configured model.

  The engine still does not follow whichever model your agent session is using;
  that needs host APIs this change does not depend on, and is tracked separately.
  Following it is also not obviously desirable — these are cheap, high-frequency
  utility calls, and inheriting a large reasoning model would make every memory
  write slow and expensive.

- [#62](https://github.com/heichaowo/amem/pull/62) [`8da3791`](https://github.com/heichaowo/amem/commit/8da37918c2c7d9f23dfee727ad19cf1efee3c0c3) Thanks [@heichaowo](https://github.com/heichaowo)! - Enforce the `readers` access rule on reads by id (Access Protocol, Story 36).

  Story 33 closed the write half of the protocol. The read half had one hole left:
  `getNote(id)` fetches straight by UUID, so unlike every list and search path it
  never went through the `agent_id` filter and never consulted `readers`. That
  mattered because of how shared notes link: a shared note is returned to every
  agent by every query, and its `links[]` can name its owner's **private** notes.
  Evolution walks that neighbourhood and puts each neighbour's content into the
  LLM prompt — so one shared note could carry its owner's private memory out to
  any agent that linked to it.

  `getNote` now takes an optional `readerAgentId`. When passed, an unreadable note
  comes back as `null` — indistinguishable from missing, so nothing leaks, and
  every existing caller already handles `null`. Omitting it skips the check, so
  internal callers that only ever hold their own ids are unchanged. The two
  neighbourhood walks in evolution now pass the caller: the link expansion that
  feeds `llmEvolveNote`, and the strengthen step, whose target ids come from the
  model rather than from a filtered query.

  The rule ships as `canRead(note, callerAgentId)` alongside `canWrite` — true for
  the owner, an agent listed in `readers`, or `readers: ['*']`. Read and write are
  independent: a shared note is typically public to read and closed to write.
  Search and list paths were audited and need no change; they build their working
  set from the agent-filtered `listNotes`, so they cannot materialise a note the
  caller may not see.

- [#68](https://github.com/heichaowo/amem/pull/68) [`f52a083`](https://github.com/heichaowo/amem/commit/f52a08318bdfdf3a61d0855209ad766da39e9a28) Thanks [@heichaowo](https://github.com/heichaowo)! - Make the CRUD `UPDATE` path non-destructive (Story 41).

  When the `agent_end` hook decides an existing memory should be updated, it picks
  one from a numbered candidate list. Picking the wrong number was the engine's one
  silent, unrecoverable failure: the index is valid and the note is usually one the
  caller owns, so neither bounds-checking nor the access protocol catches it — and
  `updateNoteContent` overwrites content and embedding in place. (`DELETE` was
  never affected; `invalidateNote` is a soft delete.)

  This is a documented failure class, not a hypothetical. mem0 removed its own CRUD
  step partly because "overwrites sometimes erased key information from the original
  fact", and Memory-R1 exists because vanilla LLMs mis-classify additive facts as
  contradictions. The risk scales inversely with model capability, and the notes
  reaching this step have already survived hash and vector dedup — the hardest
  subset, exactly where a cheap model is least reliable.

  Two guards, both default-on:

  - **`isPlausibleUpdateTarget`** — before overwriting, check the replacement text is
    plausibly _about_ the memory it replaces (cosine ≥ `crudUpdateMinSim`, default
    `0.35`). Both embeddings are already in hand, so this costs one dot product and
    no LLM call. On failure the fact is stored as a **new** memory instead: nothing
    is lost, and consolidation can merge a duplicate later — whereas it can never
    resurrect an overwritten note. Tunable via `AMEM_CRUD_UPDATE_MIN_SIM` or the
    `crudUpdateMinSim` plugin config; raise it for cheaper models.
  - **History snapshot** — an accepted overwrite now records the replaced text in the
    note's `evolution_history` (`action: "crud_update"`, new `oldContent` field), so
    even a false negative stays recoverable. Only the caller-scoped path pays for
    this; the dedup and merge paths pass no `callerAgentId` and are unchanged, so
    they take no extra read.

  The threshold is a heuristic, not a tuned constant — it sits just above the `0.3`
  bar the engine already uses for "related at all", because a legitimate update is
  often a correction ("drinks tea" → "switched to coffee") that is related but not
  near-identical. Set it to `0` to disable the check deliberately.

- [#71](https://github.com/heichaowo/amem/pull/71) [`78f2190`](https://github.com/heichaowo/amem/commit/78f21904bc646c215a87427dfe2e845a637c5369) Thanks [@heichaowo](https://github.com/heichaowo)! - Split the engine's LLM calls into a `fast` and an optional `strong` tier (Story 42, PR 1/2).

  Published results are consistent that memory quality is mostly architecture-bound:
  for fact extraction a cheap model scores within ~2 points of a strong one, and
  retrieval method moves accuracy far more than write strategy does. There is one
  exception — judging whether new information _contradicts_ what is stored, where
  the cheap/strong gap is large.

  So the calls now split by how hard they actually are. `fast` runs note
  construction, link judgement, neighbourhood refresh and the per-turn CRUD
  decision. `strong` runs only merge adjudication and EVOLVE/CONFLICT/EXPAND/NEW
  classification.

  **Configure nothing and nothing changes.** `strong` falls back to `fast` field by
  field, so the three useful shapes all work: set only `llmStrongModel` for "same
  endpoint, better model"; set all three `llmStrong*` fields to run the tiers on
  entirely different backends (a local Ollama for `fast`, a hosted API for
  `strong`); set none and the engine behaves exactly as before. There is
  deliberately no built-in strong default — inventing one would start spending an
  existing user's money without them asking.

  New config: `llmStrongProvider` / `llmStrongModel` / `llmStrongBaseURL` and
  `llmCrudRole`, plus `AMEM_LLM_STRONG_PROVIDER` / `AMEM_LLM_STRONG_MODEL` /
  `AMEM_LLM_STRONG_BASE_URL` / `AMEM_LLM_CRUD_ROLE`.

  The CRUD decision defaults to `fast` even though it is a contradiction judgement:
  it runs every turn, and its one destructive failure mode — overwriting the wrong
  memory — is already handled architecturally by the update guard rather than by
  model tier. `llmCrudRole: "strong"` moves it for operators who prefer that.

  SDK clients are now cached per base URL instead of as singletons, since the two
  tiers may point at different backends.

- [#72](https://github.com/heichaowo/amem/pull/72) [`a7e34f7`](https://github.com/heichaowo/amem/commit/a7e34f7579ff07eca92494846ff7833dfbb70c1b) Thanks [@heichaowo](https://github.com/heichaowo)! - Add a cold-layer contradiction sweep (Story 43).

  The per-turn CRUD decision runs on the fast model. That is safe — the update
  guard stops it writing to the wrong memory — but dull: it misses contradictions
  it should have caught, scoring around 8.7% at noticing a stored memory has
  quietly stopped being true. This sweep is the other half of that trade.

  `conflictSweep()` runs offline, in batches, on the `strong` tier. It hands the
  model a whole batch of memories at once rather than comparing them pairwise,
  because the contradictions that matter are usually _far apart_ in meaning — "is
  vegetarian" and "loved the steak" would never be paired by a similarity gate, and
  the existing consolidation's 0.75 cosine threshold structurally excludes exactly
  the class this exists to find.

  When a pair is found, BOTH notes are marked with a pointer to the other
  (`conflicts_with`) and the model's reason (`conflict_reason`). Those fields are
  what let a conflict be reviewed as **one decision** instead of two disconnected
  entries — the review batch now renders each pair side by side with timestamps,
  the reason, and a recommendation, so it is one glance and one tick.

  `AMEM_CONFLICT_MODE` chooses what happens next. `review` (default) marks and
  stops. `auto` also retires the older note of each pair, needing no human — but
  even a strong model is only around 55% accurate here, so roughly two in five
  retirements will silence a memory that was still true. The retirement is a soft
  delete and recoverable, but for a system answering in real time that only helps
  once somebody notices. The docs say so plainly, in a danger callout.

  Hallucinated, self-referential and duplicate pair indices are all dropped before
  they can reach a note.

- [#74](https://github.com/heichaowo/amem/pull/74) [`c4f3e91`](https://github.com/heichaowo/amem/commit/c4f3e91ac51f35c0c1e72781232c154b7ada7328) Thanks [@heichaowo](https://github.com/heichaowo)! - Add `subjects` — who a memory is about (Story 44).

  `agent_id` says whose memory _store_ a note lives in. It never said who the note
  is _about_. For a companion that meets several people those are different
  questions, and without the second one every player's memories land in the same
  pool and contaminate each other's retrieval.

  Every note now carries `subjects`, a list:

  - `[]` — a fact about the world, or about the character itself. Visible to everyone.
  - `["alex"]` — about one person. Surfaced only when scoped to them.
  - `["alex", "sam"]` — a shared experience. Surfaced for either of them.

  A list rather than a single value because shared experience is the normal case
  for a companion, not an edge case: "we beat the dragon together" belongs to both
  people, and splitting it into two near-identical notes would only give the
  deduplicator something to merge back. The three-way visibility rule then falls
  out of the shape, with no extra mode switch.

  `searchMemory(query, topK, agentId, { subject })` and the `memory_search` /
  `memory_add` tools expose it. Scoping is applied inside the vector-store query,
  so an out-of-scope memory is never fetched — and it is applied to BOTH retrieval
  paths, semantic and keyword, since scoping only the vector side would leak
  another person's memories through BM25.

  `subjects` defaults to empty, so existing memories are all world facts and stay
  visible exactly as before; omitting `subject` on a search is today's behaviour.

### Patch Changes

- [#73](https://github.com/heichaowo/amem/pull/73) [`61f46a8`](https://github.com/heichaowo/amem/commit/61f46a85b0434157b35391d2d6ff6d934908534b) Thanks [@heichaowo](https://github.com/heichaowo)! - Stop deciding which contradicted memory to retire by its write time.

  Story 43's `auto` mode retired "the older note of the pair", using the note's
  `timestamp`. That field records when a memory was **written down**, not when the
  fact became true, and the two clocks come apart constantly — "back in 2019 I was
  vegetarian", recorded today, is the newer row and the older fact. Retiring by
  write time gets that case exactly backwards: it silences the memory that is
  currently true and keeps the one that is stale.

  The batch scan now asks the model which side is **superseded**, judged from the
  wording ("used to", "moved last month", "switched to") — which is where the
  event-time evidence actually lives, and which the model is already reading. The
  prompt states explicitly that the notes are not in chronological order.

  When the model cannot tell, it answers `null` and **nothing is retired**; the pair
  is still flagged for review. A `superseded` value that names anything other than
  the two notes in the pair is treated as unknown rather than as a target, so a
  hallucinated index can never retire a memory the model was not discussing.

- [#64](https://github.com/heichaowo/amem/pull/64) [`634d280`](https://github.com/heichaowo/amem/commit/634d2806399fea8b6ae5afbbf608d1caf37d2a07) Thanks [@heichaowo](https://github.com/heichaowo)! - Harden LLM response parsing and add a request timeout (Story 40, mem0 取经).

  Three robustness fixes for the engine's LLM layer, all in `llm.ts`, prompted by
  reading how mem0 handles the same problems:

  - **Strip reasoning scaffolding before JSON.parse.** The engine accepts any
    OpenAI-compatible `baseURL`, so it can be pointed at reasoning/open-weight
    models (DeepSeek-R1, Qwen, LLaMA-3 via Ollama/vLLM) that wrap their output in
    `<think>…</think>` blocks and chat special tokens (`<|eot_id|>`, `<|im_end|>`,
    …). Those broke `JSON.parse`, and every JSON task silently fell back to its
    blank default on an otherwise-valid response — with nothing in the logs to say
    why. `stripReasoning()` now removes them first, in `stripFences` (covering the
    five object-JSON tasks) and on the CRUD array path. This was a latent silent
    degradation, not just a nicety.

  - **Tolerate a preamble before the JSON object.** `parseJsonLoose()` replaces the
    four direct `JSON.parse(stripFences(raw))` calls: on a parse failure it retries
    against the first `{…}` region, recovering the common "Sure! Here is the JSON:"
    preamble smaller models emit. It still throws when nothing parses, so every
    caller's existing try/catch → safe-default path is unchanged. The CRUD path
    already did array extraction and is untouched.

  - **Configurable client timeout.** The SDK clients were built with no timeout, so
    a slow or stuck endpoint (loaded vLLM, unreachable gateway) could hang the whole
    `addMemory` pipeline indefinitely. New `AMEM_LLM_TIMEOUT` env var (default
    30000 ms) and `LlmConfig.timeoutMs`, threaded into both client constructors.

  No behaviour change for a well-formed response from a normal model. New tests
  drive the real note-construction and CRUD functions with mocked SDKs; the
  reasoning-strip and preamble-recovery tests were verified to fail against mutated
  source (a no-op `stripReasoning`, a dropped brace fallback), so they are not
  vacuous.

  Deliberately NOT changed, after comparing with mem0: the CRUD integer-index
  referencing (amem's JS `undefined` + `if (target)` guard is already safer than
  mem0's unguarded index), the three-layer dedup (stronger than mem0 v3's single
  hash pass), and retry/fallback-on-error (mem0 has none either — a real runtime
  fallback is designed separately, with Story 39).

## 0.3.0

### Minor Changes

- [#45](https://github.com/heichaowo/amem/pull/45) [`398a59c`](https://github.com/heichaowo/amem/commit/398a59c9d6a2a931aadfa0db2e60baef4b6453ce) Thanks [@heichaowo](https://github.com/heichaowo)! - Add an OpenAI-compatible LLM provider. Set `AMEM_LLM_PROVIDER=openai` to route
  note construction, CRUD decisions, link judgment and memory evolution through the
  Chat Completions API instead of the Anthropic Messages API, with
  `AMEM_LLM_BASE_URL` pointing at any OpenAI-compatible endpoint — OpenAI, DeepSeek,
  OpenRouter, Groq, Together, or a local server (Ollama, vLLM, LM Studio). The
  default stays `anthropic`, so existing setups are unchanged.

  Reasoning models (`o1`, `o3`, `gpt-5`) are handled automatically, and keyless
  local servers work without an API key. In the plugin, the `openai` SDK is a
  runtime dependency kept out of the bundle, so the download size is unchanged for
  everyone on the default path.

### Patch Changes

- [#50](https://github.com/heichaowo/amem/pull/50) [`d07f16c`](https://github.com/heichaowo/amem/commit/d07f16c8f5766902ff29890a60c25c7e0a359363) Thanks [@heichaowo](https://github.com/heichaowo)! - Fix three issues in the OpenAI-compatible provider, found in pre-release review:

  - **`OPENAI_API_KEY` was ignored.** The client always passed an explicit key, so
    the SDK never read the standard `OPENAI_API_KEY` — a user who set it (but not
    `AMEM_LLM_API_KEY`) got 401 on every call. It now falls back to
    `OPENAI_API_KEY`, then to the keyless-local placeholder.
  - **`deepseek-reasoner` sent the wrong token parameter.** A broad
    `includes('reason')` match classified it as an OpenAI reasoning model and sent
    `max_completion_tokens`, which DeepSeek's API does not accept. Reasoning
    detection is now scoped to OpenAI's own `o*`/`gpt-5` names.
  - **`AMEM_LLM_PROVIDER` with surrounding whitespace** (e.g. `"openai "` from a
    `.env` file) silently routed to the Anthropic path. The value is now trimmed,
    and an unrecognised value logs a warning instead of failing invisibly.

## 0.2.0

### Minor Changes

- [`f48a266`](https://github.com/heichaowo/amem/commit/f48a266f85ed5f346c2acd3534f64f02f9f83b6a) Thanks [@heichaowo](https://github.com/heichaowo)! - First public release of the **amem** engine. Install it directly — `npm i @heichaowo/amem-core` —
  to build memory on top of the A-MEM engine: notes that construct, link, and
  evolve like a Zettelkasten, over Qdrant + local Transformers.js embeddings, with
  hybrid (BM25 + dense) retrieval and graph expansion. No Python.

  The public API is deliberate: memory operations (`addMemory`, `addEpisodic`,
  `searchMemory`, `consolidateMemories`, `scanLowQuality`, …), the storage context,
  the embedding-model lifecycle, and the domain types. Being `0.x`, the surface may
  still shift.

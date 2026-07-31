# Changelog

## 2.0.0

### Major Changes

- [#115](https://github.com/amemhq/amem/pull/115) [`1177e5d`](https://github.com/amemhq/amem/commit/1177e5d3c4e19e86ac4c8c592e9983da3fcb14bf) Thanks [@heichaowo](https://github.com/heichaowo)! - Stop feeding notes the query never hit into the ranking.

  `bm25Score` is a scorer, not a retriever: it returns every note in the store, and
  the ones sharing no term with the query come back at exactly 0, sorted among
  themselves in the order the store handed them over. `searchMemory` sliced the
  first `n` of that straight into the RRF fusion, so up to `n` notes selected by
  nothing at all competed with the dense results at the same rank weights.

  Measured on a 50-note store with a query that hit no term: BM25 returned all 50,
  none scoring above 0, and the first of them entered the fusion at 0.0163934 —
  identical to the weight of the top dense hit. Scroll order is stable, so it was
  the same notes on every such query. That is a systematic bias, not noise that
  averages away.

  Filtering to `score > 0` is exact rather than a heuristic here: the idf is the
  `+ 1` variant, which stays positive even for a term present in every note, so a
  real lexical match can never fall through it. When nothing matches, RRF now
  degenerates to the dense ranking, which is the right answer for a query with no
  lexical signal.

  This also makes `rrf: 0` mean what it says. Until now nearly every note carried a
  fused score whether or not any retriever had chosen it.

- [#112](https://github.com/amemhq/amem/pull/112) [`4a26a02`](https://github.com/amemhq/amem/commit/4a26a02cbbb913903849cf867293e9c1cad4b640) Thanks [@heichaowo](https://github.com/heichaowo)! - Default to `Xenova/bge-m3`. Existing stores keep the model they were built with.

  The old default caps at 128 tokens. Anything longer never reached the vector, so
  every memory past a couple of sentences was being retrieved on its opening clause
  — quietly, because a truncated encode returns a perfectly well-formed vector.
  bge-m3 reads 8192, needs no query prefix, is MIT, and its ONNX is maintained by
  the author of Transformers.js. `Conan-embedding-v1` scores 11 points higher on
  C-MTEB and is CC BY-NC; Qwen3-Embedding scores higher and needs an `Instruct:`
  prefix amem does not send. Neither is a default I want to ship.

  Nothing moves on upgrade. A collection is opened with the model recorded in its
  Qdrant metadata, and a store predating that field is inferred from its vector
  width — 384 could only have come from the old default, since picking anything else
  has always meant setting `AMEM_EMBED_MODEL`. The inference is repeated on every
  open rather than written back: a wrong record is permanent, and re-deriving it
  costs nothing. So the new default only ever applies to a store that does not exist
  yet, and moving an existing one is `amem-migrate` and nothing else.

  `AMEM_EMBED_MODEL` still wins over both, because someone who set it is migrating
  on purpose.

  **Breaking** in two places. A new store is 1024-dim instead of 384. And two
  collections open in one process that need different models is now
  `MixedEmbeddingModelsError` rather than a dimension error from whichever one lost
  — reachable in mode B, mid-migration, when one per-agent collection has moved and
  the others have not.

  Also here:

  - `AMEM_EMBED_DTYPE` defaults to `fp16` **for bge-m3 only** — 1.08 GB instead of
    2.16 GB. Not global: `multilingual-e5-large-instruct` and `Qwen3-Embedding-4B`
    publish fp32 and nothing else, and failing their load to save someone a
    gigabyte they did not ask about is not amem's call.
  - The mismatch errors were telling people to run `amem-migrate --to <name>`, which
    is not a flag. It parses `--to-collection`, so the argument was silently
    dropped; the derived target made it work anyway, and the missing
    `--from-collection` would have migrated the wrong store in mode B. Both errors
    now print the flag that exists, and the CLI repeats the collection flags it was
    given into every "now run this" line it prints.

- [#114](https://github.com/amemhq/amem/pull/114) [`37b9a42`](https://github.com/amemhq/amem/commit/37b9a42ffe8162972ed8a15ebb2d88542a723190) Thanks [@heichaowo](https://github.com/heichaowo)! - Say why each search result is in the list, and stop reporting link-expanded notes
  as 0% similar.

  Two-hop link expansion has worked since Story 18 and looked broken from outside.
  `similarity` was read out of a map built from the dense top-n, and an expanded
  note is by definition not in it — if it were, it would have been retrieved
  directly instead of expanded into. So every expanded note reported `0`, the plugin
  rendered `score: 0%`, and an agent running against a real store concluded
  expansion was not happening. The gate at the top of the walk had already computed
  the real cosine in order to threshold on it, and threw it away.

  The number was also mislabelled. It is a cosine similarity; the list is ordered by
  the RRF fusion of dense and BM25 with a heat/recency boost. Those disagree
  routinely, so a column that looks like it should decrease down the list does not,
  and there is no threshold to set on it because it is not what ranked anything.

  `SearchResult` gains `via: 'match' | 'link'`. Matches are the ranked slice; links
  are appended after them in discovery order and were never ranked at all. Without
  that distinction the tail of the list reads as low-scoring matches, which is the
  opposite of what it is — those are notes the graph vouched for.

  Note `rrf` is not zero for a link: `bm25Score` returns every note in the store,
  zero-scoring ones included, so nearly everything carries some fused score. That is
  exactly why `rrf` cannot answer "why is this row here" and `via` has to.

  The plugin now labels the column `similarity`, marks linked rows, and counts the
  two kinds separately in the header.

  **Breaking** only for direct `@amemhq/core` consumers that construct a
  `SearchResult` themselves; the field is additive for anyone reading one.

### Patch Changes

- [#103](https://github.com/amemhq/amem/pull/103) [`0f03bd3`](https://github.com/amemhq/amem/commit/0f03bd35c075b17b6d822c33a7fd71c41462fb2b) Thanks [@heichaowo](https://github.com/heichaowo)! - Give the plugin a catalog icon on ClawHub.

  ClawHub reads `icon` from `openclaw.plugin.json` — any HTTPS image URL — and shows
  it on the homepage and the plugin list. Ours has been the default placeholder since
  the listing existed.

  Serving a PNG from `amem.owo.lc` rather than the `logo.webp` already there:
  checked what the 18 code-plugins with icons actually use, and every one is a PNG
  or an SVG. None uses webp, so whether ClawHub's renderer handles it is untested,
  and a silently-broken icon is exactly the kind of thing nobody notices. 256×256 is
  108 KB, smaller than the webp it sits next to.

  ClawHub reads the manifest at publish time, so this appears on the next release
  rather than immediately.

- [#104](https://github.com/amemhq/amem/pull/104) [`a3c2ecf`](https://github.com/amemhq/amem/commit/a3c2ecf150aab272d881cf32b69d327544169cdb) Thanks [@heichaowo](https://github.com/heichaowo)! - Require an identity on `getNote`, `updateNoteContent` and `invalidateNote`.

  All three took an _optional_ caller id, and omitting it skipped the authorization
  check entirely. That put the safe behaviour behind remembering to ask for it, and
  made "no check here" invisible — an absent argument reads exactly like an
  oversight. A ClawHub scan flagged the shape; tracing it found no reachable path
  where an outside note id met an identity-less call, so it was a design weakness
  rather than a vulnerability. It is also the wrong foundation to keep building on.

  The id is now required. `SYSTEM_ACTOR` is what a call passes when it genuinely
  acts as the engine rather than on behalf of an agent — two places, both the fetch
  that `updateNoteContent` and `invalidateNote` perform in order to evaluate the
  write policy, where gating the read on the policy it exists to check would be
  circular. Every other call site already had a real agent id in scope and now
  passes it.

  **Breaking** for anyone calling these from `@amemhq/core` directly. The fix is to
  pass the identity you already have, or `SYSTEM_ACTOR` if you genuinely have none —
  and having to write that down is the point.

  One behaviour change falls out of this. The optional identity was carrying two
  meanings: "check authorization" and "this is a caller-scoped write, snapshot the
  replaced text into `evolution_history`". The dedup and merge paths passed nothing
  and so did neither. Now they pass a real identity, so they snapshot too — which is
  the better default: folding a near-duplicate and merging two notes both destroy
  text that had recovery value. It costs one point read on paths that were already
  making an LLM call.

  Also stops `amem-api` from ever exposing by-id access without deciding to. No
  route calls these functions today, but that was an accident of what had been
  built; a test now records it.

- [#111](https://github.com/amemhq/amem/pull/111) [`14f38f4`](https://github.com/amemhq/amem/commit/14f38f4582dcd8f36717cb0bc54c1420959dc3ed) Thanks [@heichaowo](https://github.com/heichaowo)! - No code change — CI skips the redundant matrix on the release PR, and the plugin
  manifest version is now asserted.

## 1.4.3

### Patch Changes

- [#97](https://github.com/amemhq/amem/pull/97) [`328b97e`](https://github.com/amemhq/amem/commit/328b97e5de4dffe3a3bc802f0d4b319fc71203c8) Thanks [@heichaowo](https://github.com/heichaowo)! - Record which embedding model built a collection, in Qdrant's collection metadata.

  Groundwork for changing the default embedding model without breaking existing
  installs. Today the engine only knows a collection's vector width; when the
  default changes, an existing 384-dimension collection would meet a 1024-dimension
  model and fail at startup. Knowing which model built it means the engine can keep
  using that one until the user migrates.

  Qdrant gained user-writable collection metadata in 1.16 (PR [#7123](https://github.com/amemhq/amem/issues/7123)), so this needs
  no sentinel point, no sidecar file and no collection-name convention — and no read
  path changes. `ensureCollection` already fetches the collection info it reads this
  from, so there is no extra round trip.

  Collections that predate the field are backfilled the first time they are opened:
  the width matched, so whatever is configured at that moment is provably what wrote
  those vectors. That stops being true once the default changes, which is why this
  lands first.

  Also catches a case nothing caught before: two different models of the _same_
  width. `EmbeddingModelMismatchError` is thrown rather than letting the store
  accumulate vectors from two geometries, which fails no check and simply retrieves
  worse.

  Writing the metadata is best-effort and deliberately separate from collection
  creation — an older Qdrant rejecting an unfamiliar field must never be the reason
  a collection cannot be created. Against Qdrant older than 1.16 this is a no-op and
  behaviour is unchanged.

- [#100](https://github.com/amemhq/amem/pull/100) [`9baba77`](https://github.com/amemhq/amem/commit/9baba77bbac7d714209ecfebf8d45a672b875543) Thanks [@heichaowo](https://github.com/heichaowo)! - Add `AMEM_EMBED_DTYPE` and `AMEM_EMBED_DEVICE`.

  Both are pass-through to Transformers.js and both default to unset, so an
  unconfigured install keeps exactly the behaviour it had.

  `AMEM_EMBED_DTYPE` decides which weights are downloaded. The library default on
  Node is `fp32`, which is the largest file a model publishes — `bge-m3` is 2.16 GB
  at fp32 against 1.08 GB at fp16. Changing it needs no migration, because
  quantization does not change the vector width.

  `AMEM_EMBED_DEVICE` decides where inference runs. amem has always run on CPU, and
  it turns out that was only because nothing ever passed a device:
  `onnxruntime-node`'s macOS arm64 binary links CoreML.framework and exports the
  CoreML provider, and Transformers.js accepts `coreml`, `dml`, `cuda` and `webgpu`
  on Node. Whether any of them is actually faster here is **unmeasured** — CoreML
  partitions a graph operator by operator and can lose to CPU — so this ships as an
  experiment to run, with no recommendation and no change of default.

  The extractor cache key now covers model, device and dtype together. It keyed on
  the model alone, so changing either of the new settings would have been ignored
  until the process restarted.

- [#102](https://github.com/amemhq/amem/pull/102) [`ad06fb8`](https://github.com/amemhq/amem/commit/ad06fb8151f08bec4e150cfb53d798dc9eb1230e) Thanks [@heichaowo](https://github.com/heichaowo)! - Fix what a pre-release review of the final v1 turned up.

  `EmbeddingDimensionMismatchError` told everyone to "point AMEM_COLLECTION at the
  new one". That is right for the default collection and wrong for a mode B one,
  whose name comes from the plugin's `collection` setting and is handed straight to
  `createStorageContext` — the env var is never consulted for it. A mode B operator
  following that instruction would repoint the _default_ store at their migrated
  collection and still be staring at the original error.

  `EmbeddingModelMismatchError` gave prose where its sibling gives a runnable
  command, and pointed at `docs/reference/embedding-models.md`, a repo path that is
  not in the published package. Both errors now share one tail, so they cannot drift
  apart again.

  The plugin checked only `EmbeddingDimensionMismatchError`, so the model mismatch —
  added in this same release — fell through to `logger.warn` and never reached the
  "memory is UNUSABLE" path. It does not stop writes, but it silently mixes two
  vector geometries, which is worse to find out about late than a hard failure.

  Docs: the collection-schema section named the wrong default model
  (`multilingual-e5-small` rather than `paraphrase-multilingual-MiniLM-L12-v2`),
  which could have led someone to set `AMEM_EMBED_MODEL` to a model their store was
  never built with. The dtype list was missing `uint8` and `bnb4`.

## 1.4.2

### Patch Changes

- [#96](https://github.com/amemhq/amem/pull/96) [`31b6fff`](https://github.com/amemhq/amem/commit/31b6fff762aef85f8990626a7cb7d0f03833ead6) Thanks [@heichaowo](https://github.com/heichaowo)! - Bump `@anthropic-ai/sdk` to 0.112.5.

  Routine: docs updates, a Bedrock `withOptions()` fix that does not apply here, and
  a new refusal category in the API types. Recorded because the plugin bundles the
  SDK, so the bump does reach users even though nothing about amem behaves
  differently.

- [#95](https://github.com/amemhq/amem/pull/95) [`7578c7a`](https://github.com/amemhq/amem/commit/7578c7ae65f23b22b3c6d2bf07c230fcb204a9a2) Thanks [@heichaowo](https://github.com/heichaowo)! - Pool embeddings the way the model expects, instead of always mean-pooling.

  `encode()` hardcoded `pooling: 'mean'`. That is correct for the default model and
  wrong for every BGE-, GTE- and Arctic-family model, which are trained for `cls` —
  so anyone who pointed `AMEM_EMBED_MODEL` at one of the models this project's own
  docs recommend was getting a degraded vector.

  It degrades rather than breaks, which is why it went unnoticed: both modes return
  a normalized vector of the right width, and search keeps working because notes and
  queries pass through the same function. It simply retrieves worse than the model
  can, with nothing to indicate it.

  The mode is now resolved from the model name, overridable with
  `AMEM_EMBED_POOLING`. A model that is not recognised falls back to `mean` — the
  behaviour of every previous release — so this can only improve an existing setup,
  never change one that was already right.

  Unlike the vector dimension, which amem measures with a probe encode, pooling
  cannot be detected at runtime: both modes look equally valid from the outside. So
  this is a lookup table, and each of its entries was read from that model's own
  `1_Pooling/config.json`.

## 1.4.1

### Patch Changes

- [#88](https://github.com/amemhq/amem/pull/88) [`d94ca7f`](https://github.com/amemhq/amem/commit/d94ca7ff7c99bfe782192b56240fcee860218f73) Thanks [@heichaowo](https://github.com/heichaowo)! - Fix the exports map and the plugin's install command.

  `@amemhq/core` had `types` as a flat sibling of `import`/`require` in its exports
  map. TypeScript adds `types` to the condition set for every caller and takes the
  first match, so a CJS consumer on `moduleResolution: node16` resolved the ESM
  `index.d.ts` and got TS1479. tsup was already emitting `index.d.cts`; the map
  just never pointed at it. Now nested per condition.

  The plugin README's recommended install line read
  `clawhub:@heichaowo/openclaw-amem`. ClawHub's identifier is the unscoped
  `openclaw-amem`, so that command never worked.

  `@types/uuid` moves to devDependencies — it is a deprecated stub (uuid ships its
  own types) and every `npm i openclaw-amem` printed a deprecation warning for it.

- [#85](https://github.com/amemhq/amem/pull/85) [`e968fcd`](https://github.com/amemhq/amem/commit/e968fcd176f1f321455b69cd93abbc542ae7a7d8) Thanks [@heichaowo](https://github.com/heichaowo)! - Rename the engine to `@amemhq/core`. The plugin keeps its name.

  `@heichaowo/amem-core` was a personal scope — it appears in other people's
  package.json, which is the wrong signal for something meant to be used as neutral
  infrastructure. The engine is now `@amemhq/core` and the service `@amemhq/api`.

  Unscoped `amem` is not an option: npm's publish-time similarity guard rejects it
  (E403, one edit from `amen`/`amemo`/`mem`), which is why the scope existed in the
  first place. Zep and Letta hit the same problem and solved it the same way —
  decorate the org (`@getzep`, `@letta-ai`) and scope the package.

  `openclaw-amem` stays unscoped: that is the convention for OpenClaw plugins, and
  it is the ClawHub package identity behind
  `openclaw plugins install clawhub:openclaw-amem`.

  `@heichaowo/amem-core` gets a deprecation notice pointing here. Nothing else
  changes — the plugin bundles the engine, so plugin users are unaffected.

## 1.4.0

### Minor Changes

- [#84](https://github.com/heichaowo/amem/pull/84) [`858984f`](https://github.com/heichaowo/amem/commit/858984f5e28b22377be9be8ab8168320647af437) Thanks [@heichaowo](https://github.com/heichaowo)! - Make the embedding model selectable, and ship the migration before changing it.

  The default model caps at 128 tokens, so anything longer never reaches the vector.
  Replacing it is worth doing — but a model change is a breaking change whenever the
  vector width differs, because Qdrant fixes a collection's size at creation. This
  release changes **no default**. It only builds the machinery, so the switch can
  happen later without breaking an existing install.

  - `AMEM_EMBED_MODEL` selects the model. Unset behaves exactly as before.
  - The vector width is **measured** — by encoding one short string — rather than
    read from a table. A table is silently wrong for any model not in it, and the
    collection would then be created at the wrong size.
  - `ensureCollection` now compares the model's width against the collection that
    already exists and throws `EmbeddingDimensionMismatchError` at **startup**, with
    the fix in the message. Previously a mismatch surfaced as a raw Qdrant error on
    the first write, long after the change that caused it. The plugin logs this one
    as an error rather than a warning, because memory is unusable until it is
    resolved.
  - `migrateCollection({ from, to })` backfills into a new collection and **never
    writes to the source**, which is what makes the switch reversible —
    `AMEM_COLLECTION` is read on every call, so going back is one variable. It
    defaults to a dry run, and refuses a target that already holds points.
  - Notes that never had `keywords`/`tags` extracted are re-run through the current
    pipeline during migration. A vector built from a note missing those fields is
    built from less text than the same note would produce today. Existing values are
    left alone: this fills gaps, it does not relabel.

  Re-embedding costs no LLM calls except for those gap-filling re-extractions —
  every field that feeds the vector is already in the payload.

- [#80](https://github.com/heichaowo/amem/pull/80) [`b7e3cb7`](https://github.com/heichaowo/amem/commit/b7e3cb7598df4e6a48dd8eda58ad6597d84163c3) Thanks [@heichaowo](https://github.com/heichaowo)! - Run the contradiction sweep nightly, and only re-read what changed (Story 43).

  `conflictSweep` shipped exported and tested but nothing called it, so the safety
  net for running the per-turn CRUD decision on the fast model was not actually
  deployed. It now runs after the daily consolidation, in its own try/catch so
  neither task can take the other down. `conflictSweep: false` turns it off.

  It is on by default because a net that is off by default is not a net — and it
  costs almost nothing, for two reasons. It runs on whatever tier is configured, so
  an install with no `strong` model keeps using the fast one and does not silently
  start spending more. And it only re-reads batches that gained a memory since the
  last run: notes carry `conflict_scanned_at`, and a batch every note has already
  been read in is skipped. On a 2,000-memory store the first night is roughly one
  call per 25 memories and every night after that is one or two.

  The tradeoff, stated rather than buried: each category is sorted newest-first, so
  a new memory is compared against the batch it lands in — its category's most
  recent — not against the entire history. A contradiction between two old memories
  that never shared a batch is not found. Clearing `conflict_scanned_at`, or passing
  `force`, does a full re-read.

  Also removes a hint in the quality review batch telling the reader to use
  `memory_quality_apply`. That tool has never existed, in any version.

### Patch Changes

- [#78](https://github.com/heichaowo/amem/pull/78) [`1108332`](https://github.com/heichaowo/amem/commit/1108332928d64e3f20952d34d0b59555c62f5bc4) Thanks [@heichaowo](https://github.com/heichaowo)! - Rename the plugin listing and refresh its description.

  The ClawHub listing read **"Memory (A-MEM v2)"**, which had three problems. It
  used `A-MEM` — the spelling reserved for the paper — as the product identity,
  while the brand everywhere else (npm packages, repo, docs site) is `amem`, so
  searching the name users see elsewhere matched nothing. The "v2" was internal
  history (the TypeScript rewrite that replaced a Python one) shown next to a
  version number of 1.3.0, so the page contradicted itself. And "Memory (" merely
  repeated the Memory category chip rendered directly above it.

  It is now **"amem — agentic memory"**.

  The description had also fallen behind. It led with implementation ("implementing
  A-MEM") rather than what the thing does, and described the 1.1.x feature set —
  missing per-agent access control and per-person memory separation, which are the
  things that now distinguish it. The one genuinely good line, "memories evolve,
  not just accumulate", is kept and moved to the front.

  Also adds `amem` to the npm keywords: the brand was the one term missing from
  them. `a-mem` stays, since that is how people look for the paper's implementation.

  Applied to all four surfaces that carry it: the plugin manifest (what ClawHub
  renders), package.json (npm), the registered plugin name in the source (what
  OpenClaw itself shows), and the plugin README (the npm landing page).

- [#82](https://github.com/heichaowo/amem/pull/82) [`84f4b5c`](https://github.com/heichaowo/amem/commit/84f4b5c647689cb227c47eaa6aff5b0741ac7f8a) Thanks [@heichaowo](https://github.com/heichaowo)! - Reposition the ClawHub listing around contradiction detection.

  Browsing the memory category shows ~25 plugins, and the previous name — "amem —
  agentic memory" — used the two most generic words available in a category whose
  own tag is #agent-memory. Six of the visible listings open with "long-term
  memory".

  Cards truncate at roughly 65-70 characters, so the opening line is the whole
  pitch. It previously read "Long-term memory for OpenClaw agents. Extracts facts
  instead of…" — indistinguishable from the rest of the page, with every
  differentiator cut off.

  Reading all 25 descriptions, nothing else in the category claims contradiction
  detection, per-person separation, or memories that rewrite themselves. The
  listing now leads with the first of those, which is both the most distinctive and
  the easiest to recognise as a real problem:

  Catches memories that contradict each other. Notes rewrite themselves as new
  ones arrive, link into a graph, and stay separated per agent and per person.

  The name is now just `amem`, matching the npm package, the repo and the docs
  site, and following the pattern of the other independent entries there (Soul,
  Lethe, Memex) rather than restating the category.

  Nothing here is a new claim: the nightly sweep is scheduled as of the previous
  release, and per-agent and per-subject scoping have shipped.

## 1.3.0

### Minor Changes

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

## 1.2.2

### Patch Changes

- [#57](https://github.com/heichaowo/amem/pull/57) [`eac161d`](https://github.com/heichaowo/amem/commit/eac161d313472639927b046d96c9474885b9b863) Thanks [@heichaowo](https://github.com/heichaowo)! - Replace the agent_end hook self-check with a deterministic config check. It used a
  10-minute timer to guess whether the hook was "blocked", which mis-fired on an idle
  gateway that had simply had no conversation, and only surfaced in the gateway log
  (seen via `openclaw completion --write-state`). The plugin now reads the actual flag —
  `plugins.entries.<id>.hooks.allowConversationAccess` — from the full OpenClaw config
  at startup, so it knows for certain whether automatic memory write-back is on: no
  timer, no heuristic, no idle false positives. When it is off, it logs once at startup
  and appends a clearer, actionable notice to memory_search results so the assistant
  relays it to the user. It stays silent if the config can't be read.

## 1.2.1

### Patch Changes

- [#51](https://github.com/heichaowo/amem/pull/51) [`79075a6`](https://github.com/heichaowo/amem/commit/79075a6f45c97bddce4ee3b3757558b7586f50b6) Thanks [@heichaowo](https://github.com/heichaowo)! - Declare the OpenAI-provider capability surface in the plugin manifest. `0.3.0`
  added an OpenAI-compatible LLM path (reading `AMEM_LLM_PROVIDER` and
  `OPENAI_API_KEY`, and able to reach `api.openai.com` or any compatible gateway),
  but `openclaw.plugin.json` still only declared the Anthropic surface. The two new
  env vars and an `openai` endpoint class are now declared, so the manifest matches
  what the code actually does — and ClawHub's scan can adjudicate the bundled
  `openai` SDK's env/network access against a declared capability instead of
  holding the release.

- [#53](https://github.com/heichaowo/amem/pull/53) [`51dca27`](https://github.com/heichaowo/amem/commit/51dca272bd28a32b3388e697566bb48bae2d35e4) Thanks [@heichaowo](https://github.com/heichaowo)! - Document the multi-provider LLM support prominently. The OpenAI-compatible
  provider was only described in the configuration reference and the README's
  security section; the plugin README's Requirements line and the docs
  getting-started page still framed the LLM as Anthropic-only. Both now point at
  a dedicated **LLM provider** section covering `AMEM_LLM_PROVIDER=anthropic|openai`
  and the OpenAI-compatible endpoints (OpenAI, DeepSeek, OpenRouter, Groq, Together,
  Ollama, vLLM, LM Studio).

## 1.2.0

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

## 1.1.5

### Patch Changes

- [#28](https://github.com/heichaowo/amem/pull/28) [`c8464be`](https://github.com/heichaowo/amem/commit/c8464bed94e86abf28d6969619e08156dcbdb43d) Thanks [@heichaowo](https://github.com/heichaowo)! - Security: the `memory_quality_scan` tool now treats its `outputPath` as a bare
  filename written under the review directory, instead of a full path it writes
  verbatim. `generateReviewBatch` previously used a caller-supplied `outputPath`
  directly, so a prompt-injected agent could pass an absolute path or a `../`
  traversal and overwrite an arbitrary file the process could write (CodeQL
  `js/path-injection`). An `outputPath` that carries any directory component is
  now rejected; a bare filename lands under `AMEM_REVIEW_DIR` (default: the
  current working directory). Set `AMEM_REVIEW_DIR` to choose the directory.

## 1.1.4

### Patch Changes

- [#25](https://github.com/heichaowo/amem/pull/25) [`ec149d9`](https://github.com/heichaowo/amem/commit/ec149d9c3ad07f4af7c6e3028f2739df98b20121) Thanks [@heichaowo](https://github.com/heichaowo)! - Fix a phantom `amem-core@0.1.0` dependency that broke installation from ClawHub.

  The engine is bundled into the plugin's `dist` by tsup, but `amem-core` was
  still declared as a `workspace:*` devDependency. On publish, pnpm rewrote that
  to `amem-core@0.1.0` — a private package that does not exist on npm. ClawHub
  extracts the tarball and runs a full `npm install`, which then 404s on it, so
  the plugin could not be installed at all.

  The engine is now resolved by a build alias to its source (see
  `tsup.config.ts`) instead of a package dependency, so it stays inlined in the
  bundle while no longer appearing anywhere in the published manifest.

- [`7967915`](https://github.com/heichaowo/amem/commit/7967915de59855a7993adab4e43e10203617e500) - Refresh the package description shown on npm and ClawHub — replace the stale "TypeScript rewrite" wording with a description of what the plugin actually does: an OpenClaw memory plugin implementing A-MEM, with evolving memory, graph linking, and hybrid retrieval.

## 1.1.3

### Patch Changes

- [`310ea62`](https://github.com/heichaowo/amem/commit/310ea62962c88c2ec471f9879329af845b461af6) - Fix the broken logo image in the README as shown on npm and ClawHub — serve it from `raw.githubusercontent.com` instead of the `amem.owo.lc` GitHub Pages custom domain, which did not render reliably on the registry pages.

## 1.1.2

### Patch Changes

- [`e300c80`](https://github.com/heichaowo/amem/commit/e300c803c11074e2d0d09516f734bac7306e43e9) - Declare the plugin's capabilities in `openclaw.plugin.json`: the eight `AMEM_*` environment variables it reads (`setup.providers[].envVars`) and its network endpoints (`providerEndpoints` — local Qdrant plus the LLM API). This is ClawHub's designed disclosure signal that the plugin's env + network access is intentional and purpose-aligned, addressing the advisory `suspicious.env_credential_access` audit finding (a heuristic false positive endemic to every configurable memory/LLM plugin). Also adds a **Security & data flow** section to the README documenting exactly what the plugin reads and where it sends memory data.

## 1.1.1

### Patch Changes

- 4422cd7: Keep `@anthropic-ai/sdk` and `uuid` external instead of inlining them into `dist` — they are already declared as dependencies and installed at runtime. This cuts the published bundle from ~252 KB to ~92 KB and stops registry static scanners from flagging the vendored SDK's env-reading helper (a false positive). Also adds the `license` field and a canonical `git+` repository URL to the manifest.

## 1.1.0

### Minor Changes

- f0ec301: Repackage as the `amem` pnpm monorepo and extract the memory engine into `amem-core` (bundled into the plugin, so there is no install or runtime change for users). New baseline `1.1.0` following the ClawHub 1.0.x line.

## v1.0.1

### Fixed

- **False-positive "agent_end hook has never fired" warning.** The hook-liveness
  signal (`hookEverFired` / plugin start time) was per-`register()`-call closure
  state. On a config hot-reload the gateway re-runs `register()` in the same
  process, leaving multiple coexisting plugin instances. `agent_end` would fire
  on a newer instance (marking _its_ flag), while a `memory_search` handler bound
  to a _stale_ instance read _its own_ `false` flag — appending the warning to
  results even though the hook was firing and memories were being written.

  The signal is now anchored on `globalThis` (`src/hook-liveness.ts`), shared by
  every instance and stable across hot-reloads and module re-evaluation. The
  genuine true-positive is preserved: when the hook is actually blocked
  (`allowConversationAccess` unset/false, or never registered anywhere), no
  instance marks it fired and the warning still surfaces after the 10-minute
  delay. Tool output shape and the warning text are unchanged.

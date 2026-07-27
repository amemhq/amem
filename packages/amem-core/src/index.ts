/**
 * amem — the A-MEM agentic memory engine (framework-agnostic).
 *
 * Qdrant + Transformers.js, no Python. Note construction, link generation,
 * memory evolution, and hybrid (BM25 + dense) retrieval with graph expansion.
 * Any host — the OpenClaw plugin, the amem-api service, a game agent — shares
 * this one engine.
 *
 * This is the deliberate public surface. The ranking primitives (BM25, RRF,
 * tokenisation), the LLM call helpers, the evolution throttle, the prompt
 * locale table and the low-level Qdrant point operations are all real but
 * internal; tests reach them through their source modules, not through here.
 */

// ── Configuration ─────────────────────────────────────────────────────────────
export { configure } from './config.js'

// ── Embedding & model lifecycle ───────────────────────────────────────────────
export { encode, loadModel, isModelLoaded } from './embedding.js'

// ── Memory operations ─────────────────────────────────────────────────────────
export {
  addMemory,
  addEpisodic,
  searchMemory,
  listMemories,
  mergeSimilarNotes,
  consolidateMemories,
  checkQuality,
  type SearchResult,
} from './memory.js'

// ── Quality ───────────────────────────────────────────────────────────────────
export { scanLowQuality, generateReviewBatch, type LowQualityItem, type LowQualityReason } from './quality.js'

// ── Storage ───────────────────────────────────────────────────────────────────
export {
  createStorageContext,
  ensureCollection,
  pingQdrant,
  listNotes,
  getNote,
  updateNote,
  deleteNote,
  invalidateNote,
  patchNotePayload,
  type StorageContext,
  type MemoryNote,
  type QueryResult,
  type EvolutionEntry,
  type AmemPluginConfig,
  type AgentAmemConfig,
} from './storage.js'

// ── Access control (Story 33 / 36) ───────────────────────────────────────────
// The two authorization rules. Consumers that mutate notes they did not fetch
// themselves (a service, a game brain) should gate on `canWrite`; anything that
// serves a note fetched by id — a REST get-by-id, a graph walk — on `canRead`.
export { canWrite, canRead } from './auth.js'

// ── Embedding model + migration ──────────────────────────────────────────────
// The model is selectable, and its vector width is measured rather than assumed.
// Changing it is breaking whenever the width differs, so migrateCollection does
// build-alongside → backfill → verify and never writes to the source.
export {
  getEmbeddingModel,
  getEmbeddingDim,
  getEmbeddingPooling,
  DEFAULT_EMBEDDING_MODEL,
  type PoolingMode,
} from './embedding.js'
export { EmbeddingDimensionMismatchError } from './storage.js'
export { migrateCollection, type MigrateResult } from './migrate.js'

// ── Story 43: cold-layer contradiction sweep ─────────────────────────────────
// Finds memories that contradict each other and marks the pair. Runs offline on
// the `strong` tier, because the per-turn cheap-model CRUD decision is safe but
// misses contradictions — this is what catches them.
export { conflictSweep, type ConflictMode, type ConflictSweepResult } from './memory.js'

// ── CRUD write safety (Story 41) ─────────────────────────────────────────────
// Before an LLM-chosen UPDATE overwrites a memory in place, check the
// replacement is plausibly about that memory — a mis-picked index is the one
// silent, unrecoverable failure in the write path.
export { isPlausibleUpdateTarget, resolveCrudUpdateMinSim, DEFAULT_CRUD_UPDATE_MIN_SIM } from './crud-guard.js'

// ── LLM (host-facing surface; the rest of the LLM layer is internal) ──────────
// `configureLlm` lets a host choose the provider/model/endpoint after import —
// env vars still take precedence, and there is no way to inject a key (Story 35).
export { llmCrudDecision, configureLlm, type MemoryOperation, type LlmConfig } from './llm.js'

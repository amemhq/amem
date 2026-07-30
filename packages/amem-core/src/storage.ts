/**
 * storage.ts — Qdrant vector storage for A-MEM
 * Uses native fetch (Node 18+) to avoid undici compatibility issues with Node v26
 * Collection: amem_notes, cosine, width set by the embedding model, with
 * agent_id isolation
 */

import { canWrite, canRead, SYSTEM_ACTOR } from './auth.js'
import {
  DEFAULT_EMBEDDING_MODEL,
  LEGACY_DEFAULT_DIM,
  LEGACY_DEFAULT_EMBEDDING_MODEL,
  getEmbeddingDim,
  getEmbeddingModel,
  getPinnedEmbeddingModel,
  pinEmbeddingModel,
} from './embedding.js'

// ── Types ─────────────────────────────────────────────────────────────────────

// ── Story 32: Per-agent config types ──────────────────────────────────────────

/** Per-agent override config. If collection is set, mode B (isolated collection) is used. */
export interface AgentAmemConfig {
  agentId?: string
  collection?: string
}

/** Top-level plugin config shape (superset — existing fields preserved). */
export interface AmemPluginConfig {
  agentId?: string
  collection?: string
  topK?: number
  /** Per-agent overrides keyed by agentId */
  agents?: Record<string, AgentAmemConfig>
  // ── Story 35: LLM settings, so a host can pick the model without env vars ────
  // Env vars still win over all three. There is deliberately no key field — see
  // the precedence note in llm.ts.
  llmProvider?: string
  llmModel?: string
  llmBaseURL?: string
  // ── Story 42: the optional `strong` tier ────────────────────────────────────
  // Each falls back to its `fast` counterpart individually, so setting only
  // `llmStrongModel` keeps the same provider/endpoint. Unset entirely = strong
  // is fast, i.e. today's single-model behaviour.
  llmStrongProvider?: string
  llmStrongModel?: string
  llmStrongBaseURL?: string
  /** Which tier the agent_end CRUD decision runs on: `fast` (default) or `strong`. */
  llmCrudRole?: 'fast' | 'strong'
  /** Story 43: run the nightly contradiction sweep. Default true. */
  conflictSweep?: boolean
  // ── Story 41: CRUD write safety ─────────────────────────────────────────────
  /** Similarity floor for accepting an LLM-chosen UPDATE target. Raise it for
   * cheaper models — a rejected update is stored as a new memory, never lost. */
  crudUpdateMinSim?: number
}

/** One entry in a note's evolution history (Story 13-B) */
export interface EvolutionEntry {
  triggeredBy: string // ID of the new note that caused this evolution
  triggeredAt: string // ISO timestamp
  oldContext: string
  newContext: string
  oldTags: string[]
  newTags: string[]
  action?: 'update_neighbor' | 'strengthen' | 'consolidate' | 'crud_update'
  /** Story 41: the content this entry replaced, so an overwrite stays recoverable. */
  oldContent?: string
  suggestedConnections?: string[]
  tagsUpdated?: string[]
}

export interface MemoryNote {
  id: string
  content: string
  keywords: string[]
  tags: string[]
  context: string
  links: string[] // linked note IDs
  embedding: number[]
  timestamp: string
  agent_id: string // "main" | "subagent-xxx" | "shared"
  hash: string // md5(content), for exact-match dedup
  // ── Story 13-A: retrieval heat tracking ──────────────────────────────────
  retrieval_count: number // times this note has been returned by queryByEmbedding
  last_accessed: string // ISO timestamp of most recent retrieval
  // ── Story 13-B: evolution history ────────────────────────────────────────
  evolution_history: EvolutionEntry[] // log of tag/context changes
  // ── Story 13-E: coarse category ──────────────────────────────────────────
  category: string // e.g. "Technical" | "Business" | … | "General"
  is_active: boolean
  // ── Story 26A: knowledge type classification ──────────────────────────────
  note_type: 'memory' | 'knowledge' // memory: episodic; knowledge: durable reference
  // ── Story 26B: topic tags for knowledge notes ─────────────────────────────────────────
  topics: string[] // subject tags, e.g. ["TypeScript", "Qdrant"]; empty for memory notes
  // ── Story 29: dedup pending merge flag ──────────────────────────────────────
  pending_merge: boolean // true when similarity 0.72-0.85 — candidate for future merge
  // ── Story 30: evolution mechanism ──────────────────────────────────────────
  evolution_type?: 'EVOLVE' | 'CONFLICT' | 'EXPAND' | 'NEW'
  conflict: boolean
  // ── Story 43: which note it conflicts with, and why ─────────────────────────
  // `conflict` alone is a bare boolean — it cannot say WHO the note contradicts,
  // so a reviewer has to reconstruct the pair by hand. These make a conflict
  // renderable as ONE decision instead of two disconnected entries.
  conflicts_with?: string[]
  conflict_reason?: string
  /**
   * Story 43: when this note was last included in a contradiction scan.
   * Absent = never scanned. Lets the sweep skip batches it has already judged,
   * which is what makes a daily run cost one or two calls instead of re-reading
   * the whole store every night.
   */
  conflict_scanned_at?: string
  // ── Story 44: who this memory is ABOUT ──────────────────────────────────────
  // Distinct from `agent_id`/`owner`, which say whose STORE it lives in. A
  // companion meeting several players needs both: one memory store, many people
  // it holds memories about.
  //
  //   []       a fact about the world, or about the agent itself — always visible
  //   [a]      about one person — surfaced only when that person is present
  //   [a, b]   a shared experience — surfaced for either of them
  //
  // An array rather than a single value because shared experience is the normal
  // case for a companion ("we fought the dragon together"), not an edge case.
  // Defaulting to [] keeps every pre-existing memory a world fact, so behaviour
  // is unchanged until subjects are actually used.
  subjects: string[]
  // ── Story 31: quality scoring ──────────────────────────────────────────────
  ephemeral: boolean // true when content contains temporal signal words
  low_quality: boolean // true when content is too short or otherwise low-quality
  // ── Story 32: per-agent ownership and access control ─────────────────────
  owner: string // agent_id of the writer
  readers: string[] // ["*"] = all agents; [agentId] = owner-only
  writers: string[] // default [owner]; enforcement TODO in Story 33
}

export interface QueryResult {
  note: MemoryNote
  score: number
}

// ── Config ────────────────────────────────────────────────────────────────────
const QDRANT_URL = 'http://localhost:6333'
/** The collection this process reads and writes unless told otherwise. */
export const getCollection = () => process.env.AMEM_COLLECTION || 'amem_notes'
/**
 * Raised when the configured model's vector width does not match the collection
 * that already exists. Its own class so the plugin can log it loudly instead of
 * as one more startup warning — this one needs the operator to act.
 */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    readonly collection: string,
    readonly collectionDim: number,
    readonly modelDim: number,
    readonly model: string
  ) {
    super(
      `Collection "${collection}" stores ${collectionDim}-dimension vectors, but ` +
        `the embedding model "${model}" produces ${modelDim}. Qdrant fixes a ` +
        `collection's vector size at creation and cannot change it, so writes and ` +
        `searches would both fail.\n` +
        `Either set AMEM_EMBED_MODEL back to the model this collection was built ` +
        `with, or ${migrationHint(collection, model)}`
    )
    this.name = 'EmbeddingDimensionMismatchError'
  }
}

/**
 * The tail both mismatch errors share: the one command that fixes it.
 *
 * `--from-collection` is always passed, even though it defaults to
 * AMEM_COLLECTION. A mode B collection is named by the plugin's `collection`
 * setting (or an `agents.<id>.collection` override) and handed straight to
 * `createStorageContext`, which never consults the env var — so the default would
 * migrate the wrong store and leave the operator looking at the same error.
 */
function migrationHint(collection: string, targetModel: string): string {
  return (
    `migrate onto it:\n\n` +
    `  AMEM_EMBED_MODEL=${targetModel} \\\n` +
    `    npx --package=@amemhq/core amem-migrate --from-collection ${collection}\n\n` +
    `That only reports; it takes --apply to write anything, and "${collection}" is ` +
    `read either way. The new store ends up behind the name you already use, so ` +
    `there is nothing to change in your config afterwards. ` +
    `See https://amem.owo.lc/reference/embedding-models.`
  )
}

/**
 * Which embedding model built a collection, and what the process wants to use.
 *
 * Vector width is the only thing Qdrant can check for us, and two models of the
 * same width are indistinguishable to it. This is the case that check misses.
 */
export class EmbeddingModelMismatchError extends Error {
  constructor(
    readonly collection: string,
    readonly collectionModel: string,
    readonly configuredModel: string
  ) {
    super(
      `Collection "${collection}" was built with the embedding model ` +
        `"${collectionModel}", but this process is configured for ` +
        `"${configuredModel}". Both produce vectors of the same width, so nothing ` +
        `would fail — searches would just quietly compare vectors from two ` +
        `different models.\n` +
        `Either set AMEM_EMBED_MODEL back to "${collectionModel}", or ` +
        migrationHint(collection, configuredModel)
    )
    this.name = 'EmbeddingModelMismatchError'
  }
}

/**
 * Two collections open in one process that need two different models.
 *
 * Only reachable in mode B, and normally only mid-migration: per-agent
 * collections built before 2.0.0 all resolve to the same old model, until one of
 * them is migrated and the others are not. One process embeds with one model, so
 * this has to stop rather than pick a winner — picking would write vectors of the
 * wrong width into whichever collection lost.
 */
export class MixedEmbeddingModelsError extends Error {
  constructor(
    readonly collection: string,
    readonly wanted: string,
    readonly inUse: string
  ) {
    super(
      `Collection "${collection}" was built with "${wanted}", but this process is ` +
        `already embedding with "${inUse}" for another collection. One process can ` +
        `only use one model.\n` +
        `Migrate the remaining collections so they all agree:\n\n` +
        `  npx --package=@amemhq/core amem-migrate --from-collection ${collection}\n\n` +
        `Or set AMEM_EMBED_MODEL to pin every collection to one model, which is only ` +
        `correct if they really were all built with it.`
    )
    this.name = 'MixedEmbeddingModelsError'
  }
}

/** What `GET /collections/{name}` gives us that we act on. */
type CollectionInfo = {
  config?: {
    params?: { vectors?: { size?: number } }
    /** Qdrant >= 1.16. Absent on older servers and on collections predating it. */
    metadata?: { embedding_model?: string }
  }
}

/**
 * Record which model built a collection, best-effort.
 *
 * Deliberately not part of the create call: an older Qdrant rejects a request
 * body it does not recognise, and failing to note the model must never be the
 * reason a collection cannot be created. Collection metadata landed in Qdrant
 * 1.16 (PR #7123); against anything older this is a no-op and the engine behaves
 * exactly as it did before.
 */
async function recordCollectionModel(collection: string, model: string): Promise<void> {
  try {
    await qdrant('PATCH', `/collections/${collection}`, { metadata: { embedding_model: model } })
  } catch {
    // Older Qdrant, or a permissions setup that forbids PATCH. Falling back to
    // the dimension check alone is exactly the previous behaviour.
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function qdrant(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = (await res.json()) as { status: string; result?: unknown; error?: string }
  if (!res.ok || (data.status && data.status !== 'ok' && data.status !== 'acknowledged')) {
    throw new Error(`Qdrant ${method} ${path} failed: ${data.error || JSON.stringify(data)}`)
  }
  return data.result
}

/**
 * Ask Qdrant whether it can serve, right now.
 *
 * `ensureCollection()` cannot answer this: it latches `_collectionReady` and
 * short-circuits on every later call, so once it has succeeded it keeps
 * reporting success long after Qdrant has gone away. `/readyz` answers in plain
 * text, so it deliberately bypasses the JSON-parsing `qdrant()` helper above.
 */
export async function pingQdrant(): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/readyz`)
  if (!res.ok) throw new Error(`Qdrant GET /readyz failed: ${res.status}`)
}

// ── Collection init ───────────────────────────────────────────────────────────
let _collectionReady = false
/** Track ready state per named collection (for mode B isolated collections). */
const _collectionReadyMap = new Map<string, boolean>()

/** Reset the collection-ready flag. Used in tests after dropping the collection. */
export function resetCollectionReady(): void {
  _collectionReady = false
  _collectionReadyMap.clear()
  // The pin is a commitment to the collections this process has opened. Once
  // those are gone, so is it — otherwise one test's store decides the next one's
  // model.
  pinEmbeddingModel(null)
}

/**
 * Ensure the given Qdrant collection exists with the correct schema.
 * If collectionName is omitted, uses process.env.AMEM_COLLECTION (default: amem_notes).
 * Mode B agents pass their dedicated collection name here.
 */
export async function ensureCollection(collectionName?: string): Promise<void> {
  const col = collectionName || getCollection()
  if (collectionName) {
    if (_collectionReadyMap.get(col)) return
  } else {
    if (_collectionReady) return
  }
  const markReady = () => {
    if (collectionName) _collectionReadyMap.set(col, true)
    else _collectionReady = true
  }
  let existing: CollectionInfo | null = null
  try {
    existing = (await qdrant('GET', `/collections/${col}`)) as CollectionInfo
  } catch {
    // Collection does not exist — create it below
  }

  if (existing) {
    const collectionDim = existing.config?.params?.vectors?.size
    const recorded = existing.config?.metadata?.embedding_model
    const explicit = process.env.AMEM_EMBED_MODEL?.trim()

    // Settle which model this collection needs BEFORE measuring anything.
    // Measuring loads the model, and on the path where this collection turns out
    // to predate the current default that would mean downloading a gigabyte of
    // weights only to conclude they are the wrong ones.
    //
    // Skipped entirely when AMEM_EMBED_MODEL is set: someone who set it is
    // migrating deliberately, and quietly overriding them with the collection's
    // own model would make the setting look broken. The checks below still catch
    // it if they are wrong.
    // No record, and the width of the only default this project shipped before
    // the field existed. Nothing else could plausibly have built it: choosing a
    // different model has always meant setting the env var, and it is unset here.
    const inferLegacy = !explicit && recorded === undefined && collectionDim === LEGACY_DEFAULT_DIM

    if (!explicit) {
      const wanted =
        // The collection says what built it, which outranks whatever the shipped
        // default happens to be today. This is what keeps changing the default
        // from breaking every install that already has data.
        typeof recorded === 'string' ? recorded : inferLegacy ? LEGACY_DEFAULT_EMBEDDING_MODEL : DEFAULT_EMBEDDING_MODEL

      const inUse = getPinnedEmbeddingModel()
      if (inUse !== null && inUse !== wanted) throw new MixedEmbeddingModelsError(col, wanted, inUse)
      // Pinned even when it equals the default, so the next collection through
      // here has something to conflict with.
      pinEmbeddingModel(wanted)

      if (wanted === LEGACY_DEFAULT_EMBEDDING_MODEL) {
        // Every startup, by design. This is a store that still works, so nothing
        // forces the issue — but it is silently truncating and the only way the
        // operator finds out is being told.
        console.warn(
          `[amem] "${col}" is on ${LEGACY_DEFAULT_EMBEDDING_MODEL} (${LEGACY_DEFAULT_DIM}-dim).\n` +
            `[amem] ${DEFAULT_EMBEDDING_MODEL} reads 8192 tokens where that one stops at 128, so ` +
            `anything longer is being truncated before it reaches the vector.\n` +
            `[amem] To move: npx --package=@amemhq/core amem-migrate --from-collection ${col}`
        )
      }
    }

    // Check the dimension NOW rather than letting the first upsert fail. Qdrant
    // rejects a wrong-width vector at insert time, which surfaces as a raw
    // storage error in the middle of a working session — long after the change
    // that caused it, and nowhere near the setting to blame.
    if (typeof collectionDim === 'number') {
      const modelDim = await getEmbeddingDim()
      if (collectionDim !== modelDim) {
        throw new EmbeddingDimensionMismatchError(col, collectionDim, modelDim, getEmbeddingModel())
      }
    }

    const current = getEmbeddingModel()
    if (typeof recorded === 'string' && recorded !== current) {
      // Same width, different model — only reachable when AMEM_EMBED_MODEL was
      // set, since otherwise the pin above made them equal. The dimension check
      // cannot see this and nothing downstream would: both models produce
      // well-formed vectors of the right size, so the store silently ends up
      // holding two incompatible geometries and retrieval quietly degrades.
      throw new EmbeddingModelMismatchError(col, recorded, current)
    }
    if (recorded === undefined && !inferLegacy) {
      // Predates the field. The dimension matched and the model was configured
      // rather than guessed, so it is provably what wrote these vectors — record
      // it while that is still true.
      //
      // Not when it was inferred: writing a guess into the metadata makes it
      // permanent, and a store that had genuinely been on some other 384-dim
      // model would be mislabelled with nothing left to tell from. Inference is
      // cheap to repeat on every open; a wrong record is forever.
      await recordCollectionModel(col, current)
    }

    markReady()
    return
  }

  try {
    // Measured, not looked up: a hardcoded table would be silently wrong for any
    // model not in it, and the collection would be created at the wrong width.
    const size = await getEmbeddingDim()
    await qdrant('PUT', `/collections/${col}`, {
      vectors: { size, distance: 'Cosine' },
    })
  } catch (err) {
    // If another concurrent call already created it, that's fine
    if (!(err instanceof Error) || !err.message.includes('already exists')) throw err
  }
  const created = getEmbeddingModel()
  await recordCollectionModel(col, created)
  // Same commitment the existing-collection path makes, for the same reason: a
  // second collection opened later must conflict rather than silently repoint
  // this one at a different model.
  if (!process.env.AMEM_EMBED_MODEL?.trim()) pinEmbeddingModel(created)
  // Index agent_id for fast filtering
  await qdrant('PUT', `/collections/${col}/index`, {
    field_name: 'agent_id',
    field_schema: 'keyword',
  })
  // Index hash for exact-match dedup
  await qdrant('PUT', `/collections/${col}/index`, {
    field_name: 'hash',
    field_schema: 'keyword',
  })
  // Story 26B: Index topics for knowledge note filtering
  await qdrant('PUT', `/collections/${col}/index`, {
    field_name: 'topics',
    field_schema: 'keyword',
  })
  // Story 44: index subjects so "memories about this person" is an index lookup.
  await qdrant('PUT', `/collections/${col}/index`, {
    field_name: 'subjects',
    field_schema: 'keyword',
  })
  markReady()
}

// ── Raw access for migration ──────────────────────────────────────────────────
// These deliberately bypass ensureCollection. A migration reads a collection
// whose vectors were written by the OLD model, so the dimension check that
// protects normal operation would reject exactly the read the migration needs.

/** Scroll every point in a collection, no filter, no readiness check. */
export async function scrollAllRaw(
  collection: string,
  limit = 10000
): Promise<Array<{ id: string; payload: Record<string, unknown>; vector: number[] }>> {
  const out: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }> = []
  let offset: unknown = undefined
  for (;;) {
    const body: Record<string, unknown> = { with_payload: true, with_vector: true, limit }
    if (offset !== undefined && offset !== null) body.offset = offset
    const res = (await qdrant('POST', `/collections/${collection}/points/scroll`, body)) as {
      points: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }>
      next_page_offset?: unknown
    }
    out.push(...res.points)
    offset = res.next_page_offset
    if (offset === undefined || offset === null || res.points.length === 0) break
  }
  return out
}

/** How many points a collection holds. Used to verify a backfill. */
export async function countPointsRaw(collection: string): Promise<number> {
  const res = (await qdrant('POST', `/collections/${collection}/points/count`, { exact: true })) as {
    count: number
  }
  return res.count
}

/** The vector width a collection was created with, or null if it does not exist. */
export async function collectionDimRaw(collection: string): Promise<number | null> {
  try {
    const info = (await qdrant('GET', `/collections/${collection}`)) as {
      config?: { params?: { vectors?: { size?: number } } }
    }
    return info.config?.params?.vectors?.size ?? null
  } catch {
    return null
  }
}

/** Create a collection at an explicit width, with the same payload indexes as ensureCollection. */
export async function createCollectionRaw(collection: string, size: number): Promise<void> {
  await qdrant('PUT', `/collections/${collection}`, { vectors: { size, distance: 'Cosine' } })
  // The migration target is built by the model configured right now — the same
  // one that produced `size`. Record it so the new collection self-describes from
  // the moment it exists, rather than on whatever later run first opens it.
  await recordCollectionModel(collection, getEmbeddingModel())
  for (const field_name of ['agent_id', 'hash', 'topics', 'subjects']) {
    await qdrant('PUT', `/collections/${collection}/index`, { field_name, field_schema: 'keyword' })
  }
}

/** Upsert prepared points into a collection. */
export async function upsertPointsRaw(
  collection: string,
  points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>
): Promise<void> {
  await qdrant('PUT', `/collections/${collection}/points?wait=true`, { points })
}

/**
 * Just the ids in a collection. `scrollAllRaw` pulls payloads and vectors too,
 * which is the whole store over the wire — a resumed migration only needs to know
 * what it already wrote.
 */
export async function scrollIdsRaw(collection: string, limit = 10000): Promise<Set<string>> {
  const ids = new Set<string>()
  let offset: unknown = undefined
  for (;;) {
    const body: Record<string, unknown> = { with_payload: false, with_vector: false, limit }
    if (offset !== undefined && offset !== null) body.offset = offset
    const res = (await qdrant('POST', `/collections/${collection}/points/scroll`, body)) as {
      points: Array<{ id: string }>
      next_page_offset?: unknown
    }
    for (const p of res.points) ids.add(String(p.id))
    offset = res.next_page_offset
    if (offset === undefined || offset === null || res.points.length === 0) break
  }
  return ids
}

/** Drop a collection. Only the migration cutover uses this. */
export async function deleteCollectionRaw(collection: string): Promise<void> {
  await qdrant('DELETE', `/collections/${collection}`)
}

/** Which collection an alias points at, or null if the name is not an alias. */
export async function resolveAliasRaw(alias: string): Promise<string | null> {
  try {
    const res = (await qdrant('GET', `/aliases`)) as {
      aliases: Array<{ alias_name: string; collection_name: string }>
    }
    return res.aliases.find((a) => a.alias_name === alias)?.collection_name ?? null
  } catch {
    return null
  }
}

/** Create an alias for a name nothing currently holds. */
export async function createAliasRaw(alias: string, collection: string): Promise<void> {
  await qdrant('POST', `/collections/aliases`, {
    actions: [{ create_alias: { collection_name: collection, alias_name: alias } }],
  })
}

/**
 * Point `alias` at `collection`, replacing whatever it pointed at.
 *
 * Both actions go in one request because Qdrant applies them atomically — a
 * separate delete and create would leave a window where the name resolves to
 * nothing, and that name is what every reader is configured to use.
 */
export async function setAliasRaw(alias: string, collection: string): Promise<void> {
  await qdrant('POST', `/collections/aliases`, {
    actions: [
      { delete_alias: { alias_name: alias } },
      { create_alias: { collection_name: collection, alias_name: alias } },
    ],
  })
}

// ── Payload mapping ───────────────────────────────────────────────────────────
export function noteToPoint(note: MemoryNote) {
  return {
    id: note.id,
    vector: note.embedding,
    payload: {
      content: note.content,
      keywords: note.keywords,
      tags: note.tags,
      context: note.context,
      links: note.links,
      timestamp: note.timestamp,
      agent_id: note.agent_id,
      hash: note.hash,
      // 13-A
      retrieval_count: note.retrieval_count ?? 0,
      last_accessed: note.last_accessed || note.timestamp,
      // 13-B: stored as JSON string (Qdrant payload can't handle nested array-of-objects)
      evolution_history: JSON.stringify(note.evolution_history ?? []),
      // 13-E
      category: note.category || 'General',
      is_active: note.is_active !== false,
      // 26B
      topics: note.topics ?? [],
      // 26A
      note_type: note.note_type || 'memory',
      // 29
      pending_merge: note.pending_merge ?? false,
      // 30
      evolution_type: note.evolution_type || '',
      conflict: note.conflict ?? false,
      conflicts_with: note.conflicts_with ?? [],
      conflict_reason: note.conflict_reason ?? '',
      conflict_scanned_at: note.conflict_scanned_at ?? '',
      subjects: note.subjects ?? [],
      // 31
      ephemeral: note.ephemeral ?? false,
      low_quality: note.low_quality ?? false,
      // 32
      owner: note.owner || note.agent_id,
      readers: note.readers ?? [note.agent_id],
      writers: note.writers ?? [note.agent_id],
    },
  }
}

export function pointToNote(point: { id: string; payload: Record<string, unknown>; vector?: number[] }): MemoryNote {
  const p = point.payload
  const timestamp = (p.timestamp as string) || ''

  // 13-B: deserialize evolution_history from JSON string
  let evolutionHistory: EvolutionEntry[] = []
  try {
    const raw = p.evolution_history
    if (typeof raw === 'string' && raw.length > 0) {
      evolutionHistory = JSON.parse(raw) as EvolutionEntry[]
    } else if (Array.isArray(raw)) {
      // handle legacy case where it was stored as array
      evolutionHistory = raw as EvolutionEntry[]
    }
  } catch {
    evolutionHistory = []
  }

  return {
    id: String(point.id),
    content: (p.content as string) || '',
    keywords: (p.keywords as string[]) || [],
    tags: (p.tags as string[]) || [],
    context: (p.context as string) || '',
    links: (p.links as string[]) || [],
    timestamp,
    agent_id: (p.agent_id as string) || 'main',
    embedding: point.vector || [],
    hash: (p.hash as string) || '',
    // 13-A
    retrieval_count: typeof p.retrieval_count === 'number' ? p.retrieval_count : 0,
    last_accessed: (p.last_accessed as string) || timestamp,
    // 13-B
    evolution_history: evolutionHistory,
    // 13-E
    category: (p.category as string) || 'General',
    is_active: p.is_active !== false,
    // 26A
    note_type: ((p.note_type as string) === 'knowledge' ? 'knowledge' : 'memory') as 'memory' | 'knowledge',
    // 26B
    topics: Array.isArray(p.topics) ? (p.topics as string[]) : [],
    // 29
    pending_merge: p.pending_merge === true,
    // 30
    evolution_type:
      typeof p.evolution_type === 'string' && ['EVOLVE', 'CONFLICT', 'EXPAND', 'NEW'].includes(p.evolution_type)
        ? (p.evolution_type as 'EVOLVE' | 'CONFLICT' | 'EXPAND' | 'NEW')
        : undefined,
    conflict: p.conflict === true,
    conflicts_with: Array.isArray(p.conflicts_with)
      ? (p.conflicts_with as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
    conflict_reason: typeof p.conflict_reason === 'string' ? p.conflict_reason : '',
    conflict_scanned_at: typeof p.conflict_scanned_at === 'string' ? p.conflict_scanned_at : '',
    subjects: Array.isArray(p.subjects)
      ? (p.subjects as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
    // 31
    ephemeral: p.ephemeral === true,
    low_quality: p.low_quality === true,
    // 32
    owner: (p.owner as string) || (p.agent_id as string) || 'main',
    readers: Array.isArray(p.readers) ? (p.readers as string[]) : [(p.agent_id as string) || 'main'],
    writers: Array.isArray(p.writers) ? (p.writers as string[]) : [(p.agent_id as string) || 'main'],
  }
}

// ── Agent filter ──────────────────────────────────────────────────────────────
function agentFilter(agentId: string, subject?: string) {
  const must: unknown[] = [
    {
      should: [
        { key: 'agent_id', match: { value: agentId } },
        { key: 'agent_id', match: { value: 'shared' } },
      ],
    },
  ]

  // Story 44: scope to one person when asked. A memory is in scope if it names
  // them, OR if it names nobody — an empty `subjects` is a fact about the world
  // or about the agent itself, which stays relevant whoever is present. A shared
  // experience names several people and so surfaces for each of them.
  //
  // Omitting `subject` means "no person scoping", which is what every existing
  // caller does and what keeps behaviour unchanged.
  if (subject !== undefined) {
    must.push({
      should: [{ key: 'subjects', match: { value: subject } }, { is_empty: { key: 'subjects' } }],
    })
  }

  return {
    must,
    must_not: [{ key: 'is_active', match: { value: false } }],
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Core CRUD implementation scoped to a specific collection and agent filter mode.
 * collectionName: which Qdrant collection to operate on.
 * modeBIsolated: if true, skip the "also include shared" filter in agentFilter
 *   (mode B collections are already per-agent, so no cross-agent filter needed).
 */
function makeCrud(collectionName: string, modeBIsolated = false) {
  const col = collectionName

  function scopedAgentFilter(agentId: string, subject?: string) {
    if (modeBIsolated) {
      // Mode B: the collection is already agent-isolated, so no agent clause is
      // needed — but subject scoping still applies. Mode B separates AGENTS;
      // `subjects` separates the PEOPLE one agent holds memories about, and a
      // single agent in its own collection still meets several of them.
      const must: unknown[] = []
      if (subject !== undefined) {
        must.push({
          should: [{ key: 'subjects', match: { value: subject } }, { is_empty: { key: 'subjects' } }],
        })
      }
      return {
        ...(must.length > 0 && { must }),
        must_not: [{ key: 'is_active', match: { value: false } }],
      }
    }
    return agentFilter(agentId, subject)
  }

  return {
    async addNote(note: MemoryNote): Promise<void> {
      await ensureCollection(col)
      await qdrant('PUT', `/collections/${col}/points?wait=true`, {
        points: [noteToPoint(note)],
      })
    },

    /**
     * Story 36: this is the one read that bypasses the agent filter — it fetches
     * straight by UUID. An unreadable note comes back as `null`, indistinguishable
     * from missing, so nothing leaks and callers already handle it.
     *
     * `reader` is required. It used to be optional, and omitting it skipped the
     * check — which meant the safe behaviour was the one you had to remember to
     * ask for. Pass `SYSTEM_ACTOR` to read as the engine itself; that reads as a
     * deliberate act at the call site, where an absent argument did not.
     */
    async getNote(id: string, reader: string): Promise<MemoryNote | null> {
      await ensureCollection(col)
      try {
        const result = (await qdrant('POST', `/collections/${col}/points`, {
          ids: [id],
          with_payload: true,
          with_vector: true,
        })) as Array<{ id: string; payload: Record<string, unknown>; vector: number[] }>
        if (!result.length) return null
        const note = pointToNote(result[0])
        if (reader !== SYSTEM_ACTOR && !canRead(note, reader)) return null
        return note
      } catch {
        return null
      }
    },

    async updateNote(note: MemoryNote): Promise<void> {
      await ensureCollection(col)
      await qdrant('PUT', `/collections/${col}/points?wait=true`, {
        points: [noteToPoint(note)],
      })
    },

    async findByHash(hash: string, agentId: string): Promise<MemoryNote | null> {
      await ensureCollection(col)
      const body = {
        filter: {
          must: [
            { key: 'hash', match: { value: hash } },
            { key: 'is_active', match: { value: true } },
            ...(modeBIsolated
              ? []
              : [
                  {
                    should: [
                      { key: 'agent_id', match: { value: agentId } },
                      { key: 'agent_id', match: { value: 'shared' } },
                    ],
                  },
                ]),
          ],
        },
        with_payload: true,
        with_vector: true,
        limit: 1,
      }
      const result = (await qdrant('POST', `/collections/${col}/points/scroll`, body)) as {
        points: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }>
      }
      if (!result.points.length) return null
      return pointToNote(result.points[0])
    },

    /**
     * Story 33: enforces the writers policy. Returns false — without writing —
     * when the caller may not write. This fetch-then-check path exists for callers
     * that only have an id (the plugin's CRUD hook); callers already holding the
     * note can check `canWrite` themselves and skip a round trip.
     *
     * `caller` is required. Pass `SYSTEM_ACTOR` for the engine's own maintenance
     * writes. The self-read below is a genuine `SYSTEM_ACTOR` case: it fetches the
     * note in order to decide whether the caller may write it, and gating that
     * fetch on the same policy it exists to evaluate would be circular.
     */
    async updateNoteContent(
      id: string,
      content: string,
      embedding: number[],
      hash: string,
      caller: string
    ): Promise<boolean> {
      await ensureCollection(col)
      let existing: MemoryNote | null = null
      if (caller !== SYSTEM_ACTOR) {
        existing = await this.getNote(id, SYSTEM_ACTOR)
        if (existing && !canWrite(existing, caller)) return false
      }
      await qdrant('PUT', `/collections/${col}/points/vectors?wait=true`, {
        points: [{ id, vector: embedding }],
      })
      const payload: Record<string, unknown> = { content, hash }
      // Story 41: this overwrite is destructive. Keep the replaced text so a
      // mis-targeted UPDATE stays recoverable — the guard has false negatives,
      // and this is the last line before content is gone for good.
      //
      // This used to happen only on the caller-scoped CRUD path, because the
      // dedup and merge paths passed no identity and so never triggered the
      // fetch. That was an artifact of the optional parameter rather than a
      // decision: folding a near-duplicate and merging two notes both destroy
      // text that had recovery value too. Now every non-system write snapshots,
      // at the cost of one point read on paths that were already making an LLM
      // call.
      if (existing) {
        const history: EvolutionEntry[] = [
          ...(existing.evolution_history ?? []),
          {
            triggeredBy: '',
            triggeredAt: new Date().toISOString(),
            oldContext: existing.context,
            newContext: existing.context,
            oldTags: existing.tags,
            newTags: existing.tags,
            action: 'crud_update',
            oldContent: existing.content,
          },
        ]
        payload.evolution_history = JSON.stringify(history)
      }
      await qdrant('POST', `/collections/${col}/points/payload?wait=true`, {
        payload,
        points: [id],
      })
      return true
    },

    async queryByEmbedding(
      embedding: number[],
      topK: number,
      agentId: string,
      scoreThreshold = 0.0,
      subject?: string
    ): Promise<QueryResult[]> {
      await ensureCollection(col)
      const result = (await qdrant('POST', `/collections/${col}/points/search`, {
        vector: embedding,
        limit: topK,
        with_payload: true,
        with_vector: true,
        score_threshold: scoreThreshold,
        filter: scopedAgentFilter(agentId, subject),
      })) as Array<{ id: string; score: number; payload: Record<string, unknown>; vector: number[] }>

      const queryResults = result.map((r) => ({
        note: pointToNote(r),
        score: r.score,
      }))

      if (queryResults.length > 0) {
        const now = new Date().toISOString()
        const ids = queryResults.map((r) => r.note.id)
        const patches = queryResults.map((r) => ({
          id: r.note.id,
          retrieval_count: (r.note.retrieval_count || 0) + 1,
        }))
        Promise.all([
          qdrant('POST', `/collections/${col}/points/payload?wait=false`, {
            payload: { last_accessed: now },
            points: ids,
          }),
          ...patches.map((p) =>
            qdrant('POST', `/collections/${col}/points/payload?wait=false`, {
              payload: { retrieval_count: p.retrieval_count },
              points: [p.id],
            })
          ),
        ]).catch((err: unknown) => {
          console.error(`[amem] retrieval tracking patch failed: ${(err as Error).message}`)
        })
        for (const r of queryResults) {
          r.note.retrieval_count = (r.note.retrieval_count || 0) + 1
          r.note.last_accessed = now
        }
      }

      return queryResults
    },

    async listNotes(agentId?: string, subject?: string): Promise<MemoryNote[]> {
      await ensureCollection(col)
      const body: Record<string, unknown> = {
        with_payload: true,
        with_vector: true,
        limit: 10000,
      }
      if (agentId) body.filter = scopedAgentFilter(agentId, subject)

      const result = (await qdrant('POST', `/collections/${col}/points/scroll`, body)) as {
        points: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }>
      }
      return result.points.map(pointToNote)
    },

    async deleteNote(id: string): Promise<void> {
      await ensureCollection(col)
      await qdrant('POST', `/collections/${col}/points/delete`, {
        points: [id],
      })
    },

    /** Story 33: see `updateNoteContent` — returns false, unwritten, when denied. */
    async invalidateNote(id: string, caller: string): Promise<boolean> {
      await ensureCollection(col)
      if (caller !== SYSTEM_ACTOR) {
        const existing = await this.getNote(id, SYSTEM_ACTOR)
        if (existing && !canWrite(existing, caller)) return false
      }
      await qdrant('POST', `/collections/${col}/points/payload?wait=true`, {
        payload: { is_active: false },
        points: [id],
      })
      return true
    },

    async getNotesByDatePrefix(datePrefix: string, agentId: string): Promise<MemoryNote[]> {
      await ensureCollection(col)
      const filterClauses: unknown[] = [{ key: 'is_active', match: { value: true } }]
      if (!modeBIsolated) {
        filterClauses.push({
          should: [
            { key: 'agent_id', match: { value: agentId } },
            { key: 'agent_id', match: { value: 'shared' } },
          ],
        })
      }
      const body: Record<string, unknown> = {
        filter: { must: filterClauses },
        with_payload: true,
        with_vector: true,
        limit: 10000,
      }
      const result = (await qdrant('POST', `/collections/${col}/points/scroll`, body)) as {
        points: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }>
      }
      return result.points.map(pointToNote).filter((n) => n.timestamp.startsWith(datePrefix))
    },

    async countNotes(agentId?: string): Promise<number> {
      await ensureCollection(col)
      const body: Record<string, unknown> = { exact: true }
      if (agentId) body.filter = scopedAgentFilter(agentId)
      const result = (await qdrant('POST', `/collections/${col}/points/count`, body)) as { count: number }
      return result.count
    },

    async updateNoteLinks(id: string, links: string[]): Promise<void> {
      await ensureCollection(col)
      await qdrant('POST', `/collections/${col}/points/payload?wait=true`, {
        payload: { links },
        points: [id],
      })
    },

    async patchNotePayload(id: string, fields: Record<string, unknown>): Promise<void> {
      await ensureCollection(col)
      await qdrant('POST', `/collections/${col}/points/payload?wait=true`, {
        payload: fields,
        points: [id],
      })
    },

    async replaceLinkReferences(oldId: string, newId: string, agentId: string): Promise<void> {
      const notes = await this.listNotes(agentId)
      for (const note of notes) {
        // Story 33: listNotes also returns other agents' shared notes. Rewriting
        // their links is a mutation we may not be authorized to make; leaving the
        // stale link is harmless (it points at an invalidated note, which queries
        // already filter out).
        if (!canWrite(note, agentId)) continue
        if (note.links.includes(oldId)) {
          const newLinks = note.links.map((linkId) => (linkId === oldId ? newId : linkId))
          const filteredLinks = newLinks.filter((linkId) => linkId !== note.id)
          const uniqueLinks = Array.from(new Set(filteredLinks))
          await this.updateNoteLinks(note.id, uniqueLinks)
        }
      }
    },
  }
}

export type StorageContext = ReturnType<typeof makeCrud>

/**
 * Create a StorageContext scoped to a specific collection (mode B) or the default collection (mode A).
 * Mode A (same collection): pass collectionName = undefined → uses AMEM_COLLECTION env var.
 * Mode B (isolated collection): pass collectionName = 'amem_notes_<agentId>' and modeBIsolated = true.
 */
export function createStorageContext(collectionName?: string, modeBIsolated = false): StorageContext {
  return makeCrud(collectionName || getCollection(), modeBIsolated)
}

// ── Legacy top-level exports (backwards compat, use default collection) ────────

export async function addNote(note: MemoryNote): Promise<void> {
  return makeCrud(getCollection()).addNote(note)
}

export async function getNote(id: string, reader: string): Promise<MemoryNote | null> {
  return makeCrud(getCollection()).getNote(id, reader)
}

export async function updateNote(note: MemoryNote): Promise<void> {
  return makeCrud(getCollection()).updateNote(note)
}

export async function findByHash(hash: string, agentId: string): Promise<MemoryNote | null> {
  return makeCrud(getCollection()).findByHash(hash, agentId)
}

export async function updateNoteContent(
  id: string,
  content: string,
  embedding: number[],
  hash: string,
  caller: string
): Promise<boolean> {
  return makeCrud(getCollection()).updateNoteContent(id, content, embedding, hash, caller)
}

export async function queryByEmbedding(
  embedding: number[],
  topK: number,
  agentId: string,
  scoreThreshold = 0.0,
  subject?: string
): Promise<QueryResult[]> {
  return makeCrud(getCollection()).queryByEmbedding(embedding, topK, agentId, scoreThreshold, subject)
}

export async function listNotes(agentId?: string, subject?: string): Promise<MemoryNote[]> {
  return makeCrud(getCollection()).listNotes(agentId, subject)
}

export async function deleteNote(id: string): Promise<void> {
  return makeCrud(getCollection()).deleteNote(id)
}

export async function invalidateNote(id: string, caller: string): Promise<boolean> {
  return makeCrud(getCollection()).invalidateNote(id, caller)
}

export async function getNotesByDatePrefix(datePrefix: string, agentId: string): Promise<MemoryNote[]> {
  return makeCrud(getCollection()).getNotesByDatePrefix(datePrefix, agentId)
}

export async function countNotes(agentId?: string): Promise<number> {
  return makeCrud(getCollection()).countNotes(agentId)
}

export async function updateNoteLinks(id: string, links: string[]): Promise<void> {
  return makeCrud(getCollection()).updateNoteLinks(id, links)
}

export async function patchNotePayload(id: string, fields: Record<string, unknown>): Promise<void> {
  return makeCrud(getCollection()).patchNotePayload(id, fields)
}

export async function replaceLinkReferences(oldId: string, newId: string, agentId: string): Promise<void> {
  return makeCrud(getCollection()).replaceLinkReferences(oldId, newId, agentId)
}

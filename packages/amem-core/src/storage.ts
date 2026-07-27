/**
 * storage.ts — Qdrant vector storage for A-MEM
 * Uses native fetch (Node 18+) to avoid undici compatibility issues with Node v26
 * Collection: amem_notes, 384-dim cosine, with agent_id isolation
 */

import { canWrite, canRead } from './auth.js'
import { getEmbeddingDim, getEmbeddingModel } from './embedding.js'

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
const getCollection = () => process.env.AMEM_COLLECTION || 'amem_notes'
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
        `with, or migrate: build a new collection with the new model, backfill it, ` +
        `then point AMEM_COLLECTION at it. See docs/reference/embedding-models.md.`
    )
    this.name = 'EmbeddingDimensionMismatchError'
  }
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
        `Either set AMEM_EMBED_MODEL back to "${collectionModel}", or migrate to a ` +
        `new collection built with "${configuredModel}". ` +
        `See docs/reference/embedding-models.md.`
    )
    this.name = 'EmbeddingModelMismatchError'
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
    // Check the dimension NOW rather than letting the first upsert fail. Qdrant
    // rejects a wrong-width vector at insert time, which surfaces as a raw
    // storage error in the middle of a working session — long after the change
    // that caused it, and nowhere near the setting to blame.
    const collectionDim = existing.config?.params?.vectors?.size
    if (typeof collectionDim === 'number') {
      const modelDim = await getEmbeddingDim()
      if (collectionDim !== modelDim) {
        throw new EmbeddingDimensionMismatchError(col, collectionDim, modelDim, getEmbeddingModel())
      }
    }

    const recorded = existing.config?.metadata?.embedding_model
    const current = getEmbeddingModel()
    if (typeof recorded === 'string' && recorded !== current) {
      // Same width, different model. The dimension check above cannot see this,
      // and nothing downstream would: both models produce well-formed vectors of
      // the right size, so the store silently ends up holding two incompatible
      // geometries and retrieval quietly degrades.
      throw new EmbeddingModelMismatchError(col, recorded, current)
    }
    if (recorded === undefined) {
      // Predates this field. The dimension matched, so whatever is configured now
      // is what has been writing these vectors — record it while that is still
      // provable. Once the default model changes, it no longer is.
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
  await recordCollectionModel(col, getEmbeddingModel())
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
     * straight by UUID. Pass `readerAgentId` to enforce `readers`; an unreadable
     * note comes back as `null` (indistinguishable from missing, so nothing leaks,
     * and callers already handle null). Omitting it skips the check, preserving
     * behaviour for internal callers that only ever hold their own ids.
     */
    async getNote(id: string, readerAgentId?: string): Promise<MemoryNote | null> {
      await ensureCollection(col)
      try {
        const result = (await qdrant('POST', `/collections/${col}/points`, {
          ids: [id],
          with_payload: true,
          with_vector: true,
        })) as Array<{ id: string; payload: Record<string, unknown>; vector: number[] }>
        if (!result.length) return null
        const note = pointToNote(result[0])
        if (readerAgentId !== undefined && !canRead(note, readerAgentId)) return null
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
     * Story 33: pass `callerAgentId` to enforce the writers policy. Callers that
     * hold the note already should prefer checking `canWrite` themselves; this
     * fetch-then-check path exists for callers that only have an id (the plugin's
     * CRUD hook). Returns false — without writing — when the caller may not write.
     * Omitting `callerAgentId` skips the check, preserving existing behaviour for
     * internal callers that are already scoped to their own notes.
     */
    async updateNoteContent(
      id: string,
      content: string,
      embedding: number[],
      hash: string,
      callerAgentId?: string
    ): Promise<boolean> {
      await ensureCollection(col)
      let existing: MemoryNote | null = null
      if (callerAgentId !== undefined) {
        existing = await this.getNote(id)
        if (existing && !canWrite(existing, callerAgentId)) return false
      }
      await qdrant('PUT', `/collections/${col}/points/vectors?wait=true`, {
        points: [{ id, vector: embedding }],
      })
      const payload: Record<string, unknown> = { content, hash }
      // Story 41: this overwrite is destructive. Keep the replaced text so a
      // mis-targeted UPDATE stays recoverable — the guard has false negatives,
      // and this is the last line before content is gone for good. Only done
      // when we already fetched the note (the caller-scoped CRUD path); the
      // dedup and merge paths pass no callerAgentId and are unchanged, so they
      // pay no extra read.
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
    async invalidateNote(id: string, callerAgentId?: string): Promise<boolean> {
      await ensureCollection(col)
      if (callerAgentId !== undefined) {
        const existing = await this.getNote(id)
        if (existing && !canWrite(existing, callerAgentId)) return false
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

export async function getNote(id: string, readerAgentId?: string): Promise<MemoryNote | null> {
  return makeCrud(getCollection()).getNote(id, readerAgentId)
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
  callerAgentId?: string
): Promise<boolean> {
  return makeCrud(getCollection()).updateNoteContent(id, content, embedding, hash, callerAgentId)
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

export async function invalidateNote(id: string, callerAgentId?: string): Promise<boolean> {
  return makeCrud(getCollection()).invalidateNote(id, callerAgentId)
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

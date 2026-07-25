/**
 * memory.ts — A-MEM core logic: addMemory, searchMemory, listMemories
 * Full TypeScript port of amem_client.py
 */

import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { encode, cosineSimilarity } from './embedding.js'
import { createStorageContext, type MemoryNote, type StorageContext } from './storage.js'
import { canWrite } from './auth.js'
import {
  llmConstructNote,
  llmShouldLink,
  llmEvolveNote,
  llmShouldMerge,
  llmEvolutionJudge,
  llmConflictScan,
} from './llm.js'
import { shouldRunEvolution } from './evo-counter.js'
import { getDataDir } from './config.js'
import { Jieba } from '@node-rs/jieba'

/**
 * Strip line breaks from an identifier before it reaches a log line. Agent ids
 * come from session/config input and these logs go to a plain console, so a
 * crafted id could otherwise forge extra log entries (CodeQL: js/log-injection).
 */
const logSafe = (id: string): string => id.replace(/[\r\n]/g, '')

// ── BM25 helpers ──────────────────────────────────────────────────────────────

// Lazy-initialized Jieba instance (Story 21: Chinese word segmentation)
let _jieba: Jieba | null = null
function getJieba(): Jieba {
  if (!_jieba) _jieba = new Jieba()
  return _jieba
}

/**
 * Tokenize text for BM25 indexing.
 * Story 21: Chinese text is segmented with Jieba (HMM mode) before indexing.
 * Non-Chinese text falls back to whitespace/word-boundary splitting.
 * Mixed text (e.g. "检索Qdrant结果") is handled correctly — Jieba preserves
 * ASCII tokens as-is while segmenting CJK spans.
 */
export function simpleTokenize(text: string): string[] {
  const hasChinese = /[\u4e00-\u9fff]/.test(text)
  if (hasChinese) {
    // Jieba cut with HMM=true for unknown word recognition
    return getJieba()
      .cut(text, true)
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length > 0 && /[\w\u4e00-\u9fff]/.test(t))
  }
  return Array.from(text.toLowerCase().matchAll(/[\w]+/g)).map((m) => m[0])
}

export interface BM25State {
  ids: string[]
  corpus: string[][]
  idf: Map<string, number>
  avgdl: number
}

export function buildBM25(notes: MemoryNote[]): BM25State {
  const ids = notes.map((n) => n.id)
  const corpus = notes.map((n) => {
    const text = [n.content, ...n.keywords, ...n.tags].join(' ')
    return simpleTokenize(text)
  })

  // IDF
  const df = new Map<string, number>()
  for (const tokens of corpus) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = corpus.length
  const idf = new Map<string, number>()
  df.forEach((freq, term) => {
    idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1))
  })

  const avgdl = corpus.reduce((s, t) => s + t.length, 0) / Math.max(N, 1)
  return { ids, corpus, idf, avgdl }
}

export function bm25Score(state: BM25State, queryTokens: string[], k1 = 1.5, b = 0.75): [string, number][] {
  const scores: [string, number][] = state.ids.map((id, i) => {
    const doc = state.corpus[i]
    const dl = doc.length
    const tf = new Map<string, number>()
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)

    let score = 0
    for (const t of queryTokens) {
      const f = tf.get(t) ?? 0
      if (f === 0) continue
      const idfVal = state.idf.get(t) ?? 0
      score += idfVal * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / state.avgdl))))
    }
    return [id, score]
  })
  return scores.sort((a, b) => b[1] - a[1])
}

// ── RRF merge ─────────────────────────────────────────────────────────────────
export function rrfMerge(embIds: string[], bm25Ids: string[], k = 60): [string, number][] {
  const scores = new Map<string, number>()
  embIds.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)))
  bm25Ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)))
  return Array.from(scores.entries()).sort((a, b) => b[1] - a[1])
}

// ── Build embedding text (same as Python) ─────────────────────────────────────
function buildEmbedText(note: Pick<MemoryNote, 'content' | 'keywords' | 'tags' | 'context'>): string {
  let text = note.content
  if (note.keywords.length) text += ' ' + note.keywords.join(' ')
  if (note.tags.length) text += ' ' + note.tags.join(' ')
  if (note.context) text += ' ' + note.context
  return text
}

// ── Story 31: Quality gate ────────────────────────────────────────────────────
const EPHEMERAL_SIGNALS = ['待跑', '等确认', '昨日', '明天完成']

export interface QualityCheckResult {
  ok: boolean
  ephemeral: boolean
  reason?: string
}

export function checkQuality(content: string): QualityCheckResult {
  const trimmed = content.trim()
  if (trimmed.length < 10) {
    return { ok: false, ephemeral: false, reason: `内容过短（${trimmed.length} 字，最少 10 字）` }
  }
  const ephemeral = EPHEMERAL_SIGNALS.some((w) => trimmed.includes(w))
  return { ok: true, ephemeral }
}

// ── Story 32: default storage context helper ──────────────────────────────────
/** Returns the default storage context (mode A: shared collection, agent filter). */
function defaultCtx(): StorageContext {
  return createStorageContext()
}

// ── addMemory ─────────────────────────────────────────────────────────────────
export async function addMemory(
  content: string,
  agentId = 'main',
  opts?: {
    scope?: 'private' | 'shared'
    storageCtx?: StorageContext
  }
): Promise<string> {
  const scope = opts?.scope ?? 'private'
  const ctx = opts?.storageCtx ?? defaultCtx()

  // ── Story 31: Quality gate ──────────────────────────────────────────────────
  const quality = checkQuality(content)
  if (!quality.ok) {
    throw new Error(`[quality] 写入拒绝: ${quality.reason}`)
  }

  // ── Story 32: effective agent_id for the stored note ─────────────────────────
  // shared scope writes agent_id='shared'; private scope writes the real agentId
  const effectiveNoteAgentId = scope === 'shared' ? 'shared' : agentId

  // ── Layer 1: Exact hash dedup (before LLM & embedding, cheapest check) ──────
  const hash = createHash('md5').update(content).digest('hex')
  const existingByHash = await ctx.findByHash(hash, agentId)
  if (existingByHash) {
    console.log(`[add] dedup: exact hash match, skipping (id=${existingByHash.id.slice(0, 8)})`)
    return existingByHash.id
  }

  console.log('[add] Constructing note...')

  // Step 1: Note Construction
  const { keywords, tags, context, category, note_type, topics } = await llmConstructNote(content)
  console.log(`  keywords: ${keywords.join(', ')}`)
  console.log(`  tags: ${tags.join(', ')}`)
  console.log(`  context: ${context}`)
  console.log(`  category: ${category}`)
  console.log(`  note_type: ${note_type}`)
  console.log(`  topics: ${topics.join(', ')}`)

  const fieldsText = buildEmbedText({ content, keywords, tags, context })
  const embedding = await encode(fieldsText)

  // ── Layer 2: High-similarity vector dedup (UPDATE instead of INSERT) ─────────
  const topMatch = await ctx.queryByEmbedding(embedding, 1, agentId, 0.0)
  if (topMatch.length > 0 && topMatch[0].score >= 0.85) {
    // Story 33: the query also returns SHARED notes owned by other agents. Only
    // fold into the match when we may write it; otherwise fall through and insert
    // our own note rather than overwriting someone else's memory.
    if (canWrite(topMatch[0].note, agentId)) {
      console.log(`[add] dedup: high-sim match (sim=${topMatch[0].score.toFixed(3)}), updating existing`)
      await ctx.updateNoteContent(topMatch[0].note.id, content, embedding, hash)
      return topMatch[0].note.id
    }
    console.log(
      `[add] dedup: high-sim match ${topMatch[0].note.id.slice(0, 8)} is not writable by ${logSafe(agentId)} — inserting a new note instead`
    )
  }

  // ── Layer 2b: Pending merge flag for borderline similarity (0.72-0.85) ──────
  const pendingMerge = topMatch.length > 0 && topMatch[0].score >= 0.72 && topMatch[0].score < 0.85
  if (pendingMerge) {
    console.log(`[add] dedup: borderline sim (sim=${topMatch[0].score.toFixed(3)}), marking pending_merge=true`)
  }

  // ── Story 32: ownership and access control fields ─────────────────────────
  const readers: string[] = scope === 'shared' ? ['*'] : [agentId]
  const writers: string[] = [agentId]

  const note: MemoryNote = {
    id: uuidv4(),
    content,
    timestamp: new Date().toISOString(),
    keywords,
    tags,
    context,
    embedding,
    links: [],
    agent_id: effectiveNoteAgentId,
    hash,
    // 13-A
    retrieval_count: 0,
    last_accessed: new Date().toISOString(),
    // 13-B
    evolution_history: [],
    // 13-E
    category,
    is_active: true,
    // 26A
    note_type,
    // 26B
    topics,
    // 29
    pending_merge: pendingMerge,
    // 30
    conflict: false,
    // 31
    ephemeral: quality.ephemeral,
    low_quality: false,
    // 32
    owner: agentId,
    readers,
    writers,
  }

  // Save first
  await ctx.addNote(note)
  console.log(`  saved note ${note.id}`)

  // Step 2: Link Generation
  try {
    const total = await ctx.countNotes(agentId)
    if (total > 1) {
      const candidates = await ctx.queryByEmbedding(embedding, 6, agentId, 0.0)

      const linkedIds: string[] = []
      const linkedContents: string[] = []

      for (const { note: cand, score } of candidates) {
        if (cand.id === note.id) continue
        if (score < 0.3) continue

        console.log(`  candidate ${cand.id.slice(0, 8)}... sim=${score.toFixed(3)}, asking LLM...`)
        const shouldLink = await llmShouldLink(content, cand.content)
        if (shouldLink) {
          linkedIds.push(cand.id)
          linkedContents.push(cand.content)
          console.log(`    → linked!`)
        }
      }

      if (linkedIds.length > 0) {
        note.links = linkedIds
        await ctx.updateNote(note)

        // Bidirectional links — Story 33: only write the back-link into notes we
        // may write. A linked note can be another agent's shared note; the forward
        // link on our own note still stands.
        for (const lid of linkedIds) {
          const linked = await ctx.getNote(lid)
          if (linked && !linked.links.includes(note.id)) {
            if (!canWrite(linked, agentId)) {
              console.log(`[link] back-link into ${lid.slice(0, 8)} skipped — not writable by ${logSafe(agentId)}`)
              continue
            }
            linked.links.push(note.id)
            await ctx.updateNote(linked)
          }
        }

        // Step 3: Memory Evolution (up to 3) — gated by evo_threshold (Story 13-C)
        if (shouldRunEvolution()) {
          console.log(`  [evo] threshold reached, running evolution for ${Math.min(linkedIds.length, 3)} linked notes`)
          for (const lid of linkedIds.slice(0, 3)) {
            const linked = await ctx.getNote(lid)
            if (!linked) continue
            // Story 33: evolution rewrites the linked note's tags/context/embedding.
            // Skip notes we may not write (e.g. another agent's shared note) — this
            // one check covers every mutation the evolution of `linked` would make.
            if (!canWrite(linked, agentId)) {
              console.log(`  [evo] skipping ${lid.slice(0, 8)} — not writable by ${logSafe(agentId)}`)
              continue
            }

            // Gather link contents and IDs — Story 36: `linked` may be a shared
            // note whose links name its owner's private notes. Reading by id
            // bypasses the agent filter, so pass the caller; unreadable
            // neighbours come back null and never reach the LLM prompt.
            const linkedNotes: Array<{ id: string; content: string }> = []
            for (const llid of linked.links.slice(0, 5)) {
              if (llid === note.id) continue
              const ln = await ctx.getNote(llid, agentId)
              if (ln) linkedNotes.push({ id: ln.id, content: ln.content })
            }
            linkedNotes.push({ id: note.id, content }) // new note exactly once

            const oldTags = [...linked.tags]
            const oldContext = linked.context

            const {
              tags: newTags,
              context: newContext,
              shouldStrengthen,
              suggestedConnections,
              tagsToUpdate,
            } = await llmEvolveNote(linked.content, linkedNotes)

            let evolved = false

            // Standard update_neighbor action
            if (newTags !== null || newContext !== null) {
              if (newTags !== null) linked.tags = newTags
              if (newContext !== null) linked.context = newContext

              linked.evolution_history = linked.evolution_history || []
              linked.evolution_history.push({
                triggeredBy: note.id,
                triggeredAt: new Date().toISOString(),
                oldContext,
                newContext: newContext ?? oldContext,
                oldTags,
                newTags: newTags ?? oldTags,
                action: 'update_neighbor',
              })
              evolved = true
            }

            let noteChanged = false
            let noteTagsChanged = false

            // Strengthen action
            if (shouldStrengthen && suggestedConnections.length > 0) {
              // 1. 双向链接绑定
              for (const targetId of suggestedConnections) {
                if (!note.links.includes(targetId)) {
                  note.links.push(targetId)
                  noteChanged = true
                }
                // Story 36: targetId comes from the LLM's suggestedConnections —
                // an arbitrary id, not something the agent filter vetted.
                const target = await ctx.getNote(targetId, agentId)
                if (target && !target.links.includes(note.id)) {
                  // Story 33: strengthen reaches notes via the link neighbourhood,
                  // which can include notes this agent may not write.
                  if (canWrite(target, agentId)) {
                    target.links.push(note.id)
                    await ctx.updateNote(target)
                  } else {
                    console.log(`  [evo] strengthen back-link into ${targetId.slice(0, 8)} skipped — not writable`)
                  }
                }
              }
              // 2. 更新新写入 memory 的 note.tags
              if (tagsToUpdate.length > 0) {
                note.tags = tagsToUpdate
                noteChanged = true
                noteTagsChanged = true
              }

              // 3. 记录 strengthen 操作到被加强的邻居 (linked) 的 evolution_history 中
              linked.evolution_history = linked.evolution_history || []
              linked.evolution_history.push({
                triggeredBy: note.id,
                triggeredAt: new Date().toISOString(),
                oldContext: linked.context,
                newContext: linked.context,
                oldTags: [...linked.tags],
                newTags: [...linked.tags],
                action: 'strengthen',
                suggestedConnections,
                tagsUpdated: tagsToUpdate,
              })
              evolved = true
            }

            if (noteChanged) {
              if (noteTagsChanged) {
                note.embedding = await encode(buildEmbedText(note))
              }
              await ctx.updateNote(note)
            }

            if (evolved) {
              // Re-compute embedding after evolution
              if (newTags !== null || newContext !== null) {
                linked.embedding = await encode(buildEmbedText(linked))
              }
              await ctx.updateNote(linked)
              console.log(`  evolved/strengthened note ${lid.slice(0, 8)}...`)
            }
          }
        } else {
          console.log(`  [evo] threshold not reached, skipping evolution this round`)
        }
      }
    }
  } catch (e) {
    console.error(`[warn] Link/Evolution phase failed: ${(e as Error).message}`)
  }

  console.log(`[done] Note added: ${note.id}`)
  return note.id
}

// ── addEpisodic ───────────────────────────────────────────────────────────────
/**
 * The cheap write path: quality gate → embed the raw content → store.
 *
 * Deliberately skips LLM note construction, similarity dedup, link generation
 * and evolution, so a real-time caller (a game brain logging events tick by
 * tick) never pays for an LLM round-trip. Cost is one embed + one upsert.
 *
 * Episodic notes are an **append-only, faithful event log**: the same content
 * written twice is two events, so there is no hash or vector dedup here.
 * Evolution rewrites a note's context over time — precisely what you do not
 * want for "remember the time the ender dragon killed us". The offline
 * consolidation pass distils these raw events into long-term, linked notes.
 */
export async function addEpisodic(
  content: string,
  agentId = 'main',
  opts?: {
    scope?: 'private' | 'shared'
    storageCtx?: StorageContext
  }
): Promise<string> {
  const scope = opts?.scope ?? 'private'
  const ctx = opts?.storageCtx ?? defaultCtx()

  const quality = checkQuality(content)
  if (!quality.ok) {
    throw new Error(`[quality] 写入拒绝: ${quality.reason}`)
  }

  // No note construction, so keywords/tags/context/topics stay empty and the
  // embedding covers the raw content alone.
  const embedding = await encode(content)
  const now = new Date().toISOString()

  const note: MemoryNote = {
    id: uuidv4(),
    content,
    timestamp: now,
    keywords: [],
    tags: [],
    context: '',
    embedding,
    links: [],
    agent_id: scope === 'shared' ? 'shared' : agentId,
    hash: createHash('md5').update(content).digest('hex'),
    retrieval_count: 0,
    last_accessed: now,
    evolution_history: [],
    category: 'General',
    is_active: true,
    note_type: 'memory',
    topics: [],
    pending_merge: false,
    conflict: false,
    ephemeral: quality.ephemeral,
    low_quality: false,
    owner: agentId,
    readers: scope === 'shared' ? ['*'] : [agentId],
    writers: [agentId],
  }

  await ctx.addNote(note)
  return note.id
}

// ── searchMemory ──────────────────────────────────────────────────────────────
export interface SearchResult {
  id: string
  content: string
  context: string
  tags: string[]
  keywords: string[]
  links: string[]
  timestamp: string
  similarity: number
  rrf: number
  // Story 26B
  topics: string[]
  note_type: 'memory' | 'knowledge'
}

export async function searchMemory(
  query: string,
  topK = 5,
  agentId = 'main',
  opts?: {
    useBfs?: boolean
    // Story 22: BFS relevance gate — linked notes with cos-sim below this threshold
    // are skipped to reduce noise. Set to 0 to disable (admit all linked notes).
    bfsSimThreshold?: number
    // Story 26B: if set, only return knowledge notes that contain ALL of these topics
    topicsFilter?: string[]
    // Story 32: optional storage context for mode B isolation
    storageCtx?: StorageContext
  }
): Promise<SearchResult[]> {
  const useBfs = opts?.useBfs !== false // default true
  const bfsSimThreshold = opts?.bfsSimThreshold ?? 0.25 // Story 22 default
  const ctx = opts?.storageCtx ?? defaultCtx()
  const total = await ctx.countNotes(agentId)
  if (total === 0) return []

  // Embedding retrieval
  const queryEmbedding = await encode(query)
  const n = Math.min(Math.max(topK * 4, 20), total)
  const embResults = await ctx.queryByEmbedding(queryEmbedding, n, agentId, 0.0)

  // BM25 retrieval
  const allNotes = await ctx.listNotes(agentId)
  const bm25State = buildBM25(allNotes)
  const queryTokens = simpleTokenize(query)
  const bm25Ranked = bm25Score(bm25State, queryTokens).slice(0, n)

  // RRF fusion with retrieval_count heat boost (Story 13-A)
  const merged = rrfMerge(
    embResults.map((r) => r.note.id),
    bm25Ranked.map((r) => r[0])
  )

  // Story 23: heat boost with time decay
  // Older frequently-retrieved notes should not permanently outrank fresher ones.
  // Score = RRF × (1 + 0.05 × ln(1 + retrieval_count) / (age_days + 1))
  // age_days is measured from last_accessed so re-retrieval resets the clock.
  const now = Date.now()
  const noteMap = new Map(allNotes.map((n) => [n.id, n]))
  const boostedMerged: [string, number][] = merged.map(([id, rrfScore]) => {
    const note = noteMap.get(id)
    if (!note) return [id, rrfScore]
    // Story 26A: knowledge notes are timeless — skip time decay boost
    if (note.note_type === 'knowledge') return [id, rrfScore]
    const lastAccessed = new Date(note.last_accessed || note.timestamp).getTime()
    const ageDays = (now - lastAccessed) / 86_400_000
    const recencyBoost = 1 + (0.05 * Math.log(1 + (note.retrieval_count || 0))) / (ageDays + 1)
    return [id, rrfScore * recencyBoost]
  })
  boostedMerged.sort((a, b) => b[1] - a[1])

  const topIds = boostedMerged.slice(0, topK).map(([id]) => id)

  // Story 18: 2-hop BFS link expansion (can be disabled via opts.useBfs=false for ablation)
  // Walk the link graph up to 2 hops from each top result to surface
  // contextually related notes that scored too low for direct retrieval.
  const BFS_MAX_HOPS = 2
  const BFS_MAX_EXPAND = 8 // max extra notes to add via BFS (cap to avoid bloat)
  const visitedIds = new Set<string>(topIds)
  const bfsQueue: Array<{ id: string; hop: number }> = useBfs ? topIds.map((id) => ({ id, hop: 0 })) : []
  const bfsExtra: string[] = [] // IDs discovered via BFS, in discovery order

  while (bfsQueue.length > 0 && bfsExtra.length < BFS_MAX_EXPAND) {
    const item = bfsQueue.shift()!
    if (item.hop >= BFS_MAX_HOPS) continue
    const note = noteMap.get(item.id)
    if (!note) continue
    for (const linkedId of note.links) {
      if (visitedIds.has(linkedId)) continue
      visitedIds.add(linkedId)
      // Only include active notes (is_active !== false)
      const linked = noteMap.get(linkedId)
      if (!linked || linked.is_active === false) continue
      // Story 22: relevance gate — skip BFS nodes too far from the query
      if (bfsSimThreshold > 0 && linked.embedding) {
        const sim = cosineSimilarity(queryEmbedding, linked.embedding)
        if (sim < bfsSimThreshold) continue
      }
      bfsExtra.push(linkedId)
      bfsQueue.push({ id: linkedId, hop: item.hop + 1 })
      if (bfsExtra.length >= BFS_MAX_EXPAND) break
    }
  }

  // Story 26B: apply topicsFilter — keep only knowledge notes that contain ALL requested topics
  const topicsFilter = opts?.topicsFilter
  const filteredTopIds =
    topicsFilter && topicsFilter.length > 0
      ? topIds.filter((id) => {
          const note = noteMap.get(id)
          if (!note) return false
          if (note.note_type !== 'knowledge') return true // pass-through non-knowledge notes
          return topicsFilter.every((t) => note.topics.map((s) => s.toLowerCase()).includes(t.toLowerCase()))
        })
      : topIds

  // Build result map
  const embSimMap = new Map(embResults.map((r) => [r.note.id, r.score]))
  const rrfMap = new Map(boostedMerged.map(([id, score]) => [id, score]))

  const results: SearchResult[] = []
  for (const id of [...filteredTopIds, ...bfsExtra]) {
    const note = noteMap.get(id)
    if (!note) continue
    results.push({
      id: note.id,
      content: note.content,
      context: note.context,
      tags: note.tags,
      keywords: note.keywords,
      links: note.links,
      timestamp: note.timestamp,
      similarity: embSimMap.get(id) ?? 0,
      rrf: rrfMap.get(id) ?? 0,
      topics: note.topics ?? [],
      note_type: note.note_type ?? 'memory',
    })
  }

  return results
}

// ── listMemories ──────────────────────────────────────────────────────────────
export async function listMemories(agentId = 'main', storageCtx?: StorageContext): Promise<{ count: number }> {
  const ctx = storageCtx ?? defaultCtx()
  const count = await ctx.countNotes(agentId)
  return { count }
}

// ── mergeSimilarNotes ──────────────────────────────────────────────────────────

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Merge semantically similar notes written today.
 * Called asynchronously from agent_end hook; failures are silent.
 * Returns the number of notes merged (deleted).
 *
 * Story 30: pending_merge=true notes are routed through LLM evolution judgment
 * (EVOLVE/CONFLICT/EXPAND/NEW) instead of simple merge.
 * Story 32: shared notes (agent_id='shared') are never merged/consolidated.
 */
export async function mergeSimilarNotes(agentId: string, storageCtx?: StorageContext): Promise<number> {
  const ctx = storageCtx ?? defaultCtx()
  const today = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
  const allNotes = await ctx.getNotesByDatePrefix(today, agentId)

  // Story 32: only process private notes — skip shared entries entirely
  const notes = allNotes.filter((n) => n.agent_id !== 'shared')

  // ── Story 30: Evolution processing for pending_merge notes ────────────────
  const pendingNotes = notes.filter((n) => n.pending_merge === true)
  let evolvedCount = 0

  for (const pendingNote of pendingNotes) {
    // Find the closest non-pending neighbor
    let bestSim = -1
    let bestNeighbor: MemoryNote | null = null
    for (const other of notes) {
      if (other.id === pendingNote.id) continue
      if (other.pending_merge) continue
      if (!other.embedding.length || !pendingNote.embedding.length) continue
      const sim = cosineSimilarity(pendingNote.embedding, other.embedding)
      if (sim > bestSim) {
        bestSim = sim
        bestNeighbor = other
      }
    }

    if (!bestNeighbor) {
      await ctx.patchNotePayload(pendingNote.id, { pending_merge: false })
      continue
    }

    const judgment = await llmEvolutionJudge(bestNeighbor.content, pendingNote.content)
    console.log(
      `[merge] evolution judgment: ${pendingNote.id.slice(0, 8)} → ${bestNeighbor.id.slice(0, 8)}: ${judgment.type}`
    )

    if (judgment.type === 'EVOLVE') {
      const oldHistory = bestNeighbor.evolution_history || []
      oldHistory.push({
        triggeredBy: pendingNote.id,
        triggeredAt: new Date().toISOString(),
        oldContext: bestNeighbor.context,
        newContext: bestNeighbor.context,
        oldTags: [...bestNeighbor.tags],
        newTags: [...bestNeighbor.tags],
        action: 'consolidate',
      })
      const mergedContent = judgment.mergedContent || pendingNote.content
      const newEmbedding = await encode(buildEmbedText({ ...bestNeighbor, content: mergedContent }))
      const newHash = createHash('md5').update(mergedContent).digest('hex')
      await ctx.updateNoteContent(bestNeighbor.id, mergedContent, newEmbedding, newHash)
      await ctx.patchNotePayload(bestNeighbor.id, {
        evolution_history: JSON.stringify(oldHistory),
        evolution_type: 'EVOLVE',
      })
      await ctx.deleteNote(pendingNote.id)
      evolvedCount++
    } else if (judgment.type === 'CONFLICT') {
      await ctx.patchNotePayload(pendingNote.id, { pending_merge: false, conflict: true, evolution_type: 'CONFLICT' })
      await ctx.patchNotePayload(bestNeighbor.id, { conflict: true, evolution_type: 'CONFLICT' })
    } else if (judgment.type === 'EXPAND') {
      const oldHistory = bestNeighbor.evolution_history || []
      oldHistory.push({
        triggeredBy: pendingNote.id,
        triggeredAt: new Date().toISOString(),
        oldContext: bestNeighbor.context,
        newContext: bestNeighbor.context,
        oldTags: [...bestNeighbor.tags],
        newTags: [...bestNeighbor.tags],
        action: 'consolidate',
      })
      const mergedContent = judgment.mergedContent || `${bestNeighbor.content}；${pendingNote.content}`
      const newEmbedding = await encode(buildEmbedText({ ...bestNeighbor, content: mergedContent }))
      const newHash = createHash('md5').update(mergedContent).digest('hex')
      await ctx.updateNoteContent(bestNeighbor.id, mergedContent, newEmbedding, newHash)
      await ctx.patchNotePayload(bestNeighbor.id, {
        evolution_history: JSON.stringify(oldHistory),
        evolution_type: 'EXPAND',
      })
      await ctx.deleteNote(pendingNote.id)
      evolvedCount++
    } else {
      // NEW — just clear pending_merge
      await ctx.patchNotePayload(pendingNote.id, { pending_merge: false, evolution_type: 'NEW' })
    }

    await sleep(200)
  }

  // ── Original merge logic for non-pending notes ────────────────────────────
  // Not enough notes to bother
  if (notes.length < 5) return evolvedCount

  // Build list of (i, j) candidate pairs with sim >= 0.80
  // Exclude pending_merge notes (already handled above)
  const pendingIds = new Set(pendingNotes.map((n) => n.id))

  interface SimPair {
    i: number
    j: number
    sim: number
  }

  const pairs: SimPair[] = []
  for (let i = 0; i < notes.length; i++) {
    if (pendingIds.has(notes[i].id)) continue
    for (let j = i + 1; j < notes.length; j++) {
      if (pendingIds.has(notes[j].id)) continue
      if (!notes[i].embedding.length || !notes[j].embedding.length) continue
      const sim = cosineSimilarity(notes[i].embedding, notes[j].embedding)
      if (sim >= 0.8) {
        pairs.push({ i, j, sim })
      }
    }
  }

  if (pairs.length === 0) return evolvedCount

  // Sort by similarity descending, take top 10
  pairs.sort((a, b) => b.sim - a.sim)
  const topPairs = pairs.slice(0, 10)

  // Track deleted IDs to skip stale pairs
  const deletedIds = new Set<string>()
  let mergedCount = 0

  for (const { i, j } of topPairs) {
    const noteA = notes[i]
    const noteB = notes[j]

    // Skip if either has already been deleted
    if (deletedIds.has(noteA.id) || deletedIds.has(noteB.id)) continue

    const result = await llmShouldMerge(noteA.content, noteB.content)

    if (result.shouldMerge && result.merged) {
      // Keep the longer note (more complete), update its content, delete the other
      const [keepNote, dropNote] = noteA.content.length >= noteB.content.length ? [noteA, noteB] : [noteB, noteA]

      const newEmbedding = await encode(result.merged)
      const newHash = createHash('md5').update(result.merged).digest('hex')
      await ctx.updateNoteContent(keepNote.id, result.merged, newEmbedding, newHash)
      await ctx.deleteNote(dropNote.id)
      deletedIds.add(dropNote.id)
      mergedCount++
    }

    // Rate-limit: 200ms between LLM calls
    await sleep(200)
  }

  return evolvedCount + mergedCount
}

/**
 * Consolidate semantically similar memories.
 * Performs deep deduplication by category and similarity score.
 * Story 32: shared notes (agent_id='shared') are skipped entirely.
 */
export async function consolidateMemories(agentId: string, logger?: any, storageCtx?: StorageContext): Promise<number> {
  const ctx = storageCtx ?? defaultCtx()
  const log = {
    info: (msg: string) => (logger ? logger.info(msg) : console.log(msg)),
    warn: (msg: string) => (logger ? logger.warn(msg) : console.warn(msg)),
    error: (msg: string) => (logger ? logger.error(msg) : console.error(msg)),
  }

  log.info(`[Consolidation] Starting consolidation for agentId: ${agentId}`)

  // 1. 加载记忆：获取所有活动（is_active: true）记忆条目
  const rawNotes = await ctx.listNotes(agentId)
  // Story 32: skip shared notes — they are read-only for non-owners
  const allNotes = rawNotes.filter((n) => n.agent_id !== 'shared')
  log.info(
    `[Consolidation] Loaded ${allNotes.length} active private notes (${rawNotes.length - allNotes.length} shared skipped).`
  )

  // 2. 分类分组：根据 category 字段将记忆分组
  // Story 26A: skip knowledge notes — they are durable and should not be merged
  const groups = new Map<string, MemoryNote[]>()
  for (const note of allNotes) {
    if (note.note_type === 'knowledge') continue
    const category = note.category || 'General'
    if (!groups.has(category)) {
      groups.set(category, [])
    }
    groups.get(category)!.push(note)
  }

  // 3. 两两比对：在每个分类分组内计算余弦相似度
  interface CandidatePair {
    noteA: MemoryNote
    noteB: MemoryNote
    similarity: number
  }
  const candidates: CandidatePair[] = []

  for (const [category, groupNotes] of groups.entries()) {
    log.info(`[Consolidation] Category "${category}" has ${groupNotes.length} notes.`)
    for (let i = 0; i < groupNotes.length; i++) {
      for (let j = i + 1; j < groupNotes.length; j++) {
        const noteA = groupNotes[i]
        const noteB = groupNotes[j]
        if (!noteA.embedding.length || !noteB.embedding.length) continue
        const sim = cosineSimilarity(noteA.embedding, noteB.embedding)
        if (sim >= 0.75) {
          candidates.push({ noteA, noteB, similarity: sim })
        }
      }
    }
  }

  // 4. 筛选候选对：按相似度从高到低排序，限制最多 15 对
  candidates.sort((a, b) => b.similarity - a.similarity)
  const topPairs = candidates.slice(0, 15)
  log.info(
    `[Consolidation] Found ${candidates.length} candidate pairs with similarity >= 0.75. Processing top ${topPairs.length}.`
  )

  const processedIds = new Set<string>()
  let mergedCount = 0

  // Helper: append log to log file
  function logMergeToFile(keepId: string, dropId: string, mergedContent: string) {
    const logDir = path.join(getDataDir(), 'logs')
    const logFile = path.join(logDir, 'amem-consolidate.log')
    const timestamp = new Date().toISOString()
    const logMsg = `[${timestamp}] Consolidated: KeepNote ${keepId} and DropNote ${dropId}. Merged length: ${mergedContent.length} chars.\n`

    try {
      fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(logFile, logMsg, 'utf8')
    } catch (err) {
      log.error(`[Consolidation] Failed to write log: ${(err as Error).message}`)
    }
  }

  // 5. LLM 融合决策与信息继承
  for (const { noteA, noteB, similarity } of topPairs) {
    if (processedIds.has(noteA.id) || processedIds.has(noteB.id)) {
      log.info(
        `[Consolidation] Skipping pair (${noteA.id.slice(0, 8)}, ${noteB.id.slice(0, 8)}) as one or both already merged.`
      )
      continue
    }

    log.info(
      `[Consolidation] Evaluating pair (${noteA.id.slice(0, 8)}, ${noteB.id.slice(0, 8)}) with sim ${similarity.toFixed(4)}...`
    )
    const mergeDecision = await llmShouldMerge(noteA.content, noteB.content)

    if (mergeDecision.shouldMerge && mergeDecision.merged) {
      log.info(`  -> LLM decision: MERGE!`)

      // 比较两条记忆的长度，将较长的保留作为主节点 (KeepNote)
      const [keepNote, dropNote] = noteA.content.length >= noteB.content.length ? [noteA, noteB] : [noteB, noteA]

      log.info(
        `  -> KeepNote: ${keepNote.id.slice(0, 8)} (len: ${keepNote.content.length}), DropNote: ${dropNote.id.slice(0, 8)} (len: ${dropNote.content.length})`
      )

      const oldContext = keepNote.context
      const oldTags = [...keepNote.tags]

      // 内容更新
      keepNote.content = mergeDecision.merged

      // 元数据继承：
      // - 合并 tags 与 keywords（合并后去重）
      keepNote.tags = Array.from(new Set([...keepNote.tags, ...dropNote.tags]))
      keepNote.keywords = Array.from(new Set([...keepNote.keywords, ...dropNote.keywords]))

      // - 合并 links 链接数组（去重且排除自身 and DropNote）
      keepNote.links = Array.from(new Set([...keepNote.links, ...dropNote.links])).filter(
        (id) => id !== keepNote.id && id !== dropNote.id
      )

      // - retrieval_count 累加
      keepNote.retrieval_count = (keepNote.retrieval_count || 0) + (dropNote.retrieval_count || 0)

      // - last_accessed 取最新的时间戳
      const keepAccessTime = new Date(keepNote.last_accessed || keepNote.timestamp).getTime()
      const dropAccessTime = new Date(dropNote.last_accessed || dropNote.timestamp).getTime()
      keepNote.last_accessed =
        keepAccessTime >= dropAccessTime
          ? keepNote.last_accessed || keepNote.timestamp
          : dropNote.last_accessed || dropNote.timestamp

      // 重算 embedding 与 MD5 hash
      const embedText = buildEmbedText(keepNote)
      keepNote.embedding = await encode(embedText)
      keepNote.hash = createHash('md5').update(keepNote.content).digest('hex')

      // 将 DropNote 的合并事件记录在 KeepNote 的 evolution_history 中
      keepNote.evolution_history = keepNote.evolution_history || []
      keepNote.evolution_history.push({
        triggeredBy: dropNote.id,
        triggeredAt: new Date().toISOString(),
        oldContext,
        newContext: keepNote.context,
        oldTags,
        newTags: keepNote.tags,
        action: 'consolidate',
      })

      // 更新 KeepNote
      await ctx.updateNote(keepNote)

      // 软删除 DropNote
      await ctx.invalidateNote(dropNote.id)

      // 级联更新 links
      await ctx.replaceLinkReferences(dropNote.id, keepNote.id, agentId)

      // 写入日志
      logMergeToFile(keepNote.id, dropNote.id, keepNote.content)

      processedIds.add(keepNote.id)
      processedIds.add(dropNote.id)
      mergedCount++
    } else {
      log.info(`  -> LLM decision: DO NOT MERGE.`)
    }

    // Rate limit sleep
    await sleep(200)
  }

  log.info(`[Consolidation] Completed consolidation run. Merged ${mergedCount} pairs.`)
  return mergedCount
}

// ── Story 43: cold-layer contradiction sweep ──────────────────────────────────

/**
 * How a detected contradiction is handled.
 *
 * `review` (default) marks both notes and leaves the decision to a human — the
 * safe option, because even a strong model is only around 55% accurate at
 * spotting implicit contradictions.
 *
 * `auto` additionally retires the older note of each pair. It needs no human,
 * but at that accuracy roughly two in five retirements will silence a memory
 * that was still true. The retirement is a soft delete, so it is recoverable —
 * but for a system answering in real time, "recoverable" only helps once someone
 * notices. Documented as such; opt in deliberately.
 */
export type ConflictMode = 'review' | 'auto'

function resolveConflictMode(override?: ConflictMode): ConflictMode {
  const raw = (process.env.AMEM_CONFLICT_MODE || override || 'review').trim().toLowerCase()
  return raw === 'auto' ? 'auto' : 'review'
}

/** How many notes go to the model in one scan. Bounds cost and prompt size. */
const CONFLICT_BATCH_SIZE = 25

export interface ConflictSweepResult {
  scanned: number
  pairsFound: number
  retired: number
}

/**
 * Find memories that contradict each other and mark them.
 *
 * This is the cold half of the tiering split. The per-turn CRUD decision runs on
 * a cheap model, which is safe (the update guard stops it writing to the wrong
 * note) but dull — it misses contradictions it should have caught. This sweep is
 * what catches them: it runs offline, in batches, on the strong tier, and it
 * sees far more context than any single turn does.
 *
 * Batches by category and hands each batch to the model whole, rather than
 * pairing by similarity — see llmConflictScan for why that distinction is the
 * entire point.
 */
export async function conflictSweep(
  agentId: string,
  opts?: { mode?: ConflictMode; storageCtx?: StorageContext; logger?: { info: (m: string) => void } }
): Promise<ConflictSweepResult> {
  const ctx = opts?.storageCtx ?? defaultCtx()
  const mode = resolveConflictMode(opts?.mode)
  const log = opts?.logger?.info ?? ((m: string) => console.log(m))

  const raw = await ctx.listNotes(agentId)
  // Only this agent's own episodic notes: shared notes belong to someone else,
  // and knowledge notes are durable reference rather than claims about a person.
  const notes = raw.filter((n) => n.agent_id !== 'shared' && n.note_type !== 'knowledge' && n.is_active !== false)

  const groups = new Map<string, MemoryNote[]>()
  for (const n of notes) {
    const c = n.category || 'General'
    if (!groups.has(c)) groups.set(c, [])
    groups.get(c)!.push(n)
  }

  let pairsFound = 0
  let retired = 0

  for (const [category, groupNotes] of groups.entries()) {
    for (let start = 0; start < groupNotes.length; start += CONFLICT_BATCH_SIZE) {
      const batch = groupNotes.slice(start, start + CONFLICT_BATCH_SIZE)
      if (batch.length < 2) continue

      const pairs = await llmConflictScan(batch.map((n) => n.content))
      for (const { a, b, reason, supersededIndex } of pairs) {
        const noteA = batch[a]
        const noteB = batch[b]
        if (!noteA || !noteB) continue
        pairsFound++

        // Mark BOTH sides, each pointing at the other, so the pair can be shown
        // as one decision instead of two disconnected review entries.
        await ctx.patchNotePayload(noteA.id, {
          conflict: true,
          evolution_type: 'CONFLICT',
          conflicts_with: Array.from(new Set([...(noteA.conflicts_with ?? []), noteB.id])),
          conflict_reason: reason,
        })
        await ctx.patchNotePayload(noteB.id, {
          conflict: true,
          evolution_type: 'CONFLICT',
          conflicts_with: Array.from(new Set([...(noteB.conflicts_with ?? []), noteA.id])),
          conflict_reason: reason,
        })
        log(`[conflict] ${category}: ${noteA.id.slice(0, 8)} ↔ ${noteB.id.slice(0, 8)} — ${reason}`)

        if (mode === 'auto') {
          // Retire the side the MODEL judged superseded — never the older-by-
          // wall-clock one. A note records when it was WRITTEN, not when the fact
          // became true, and the two come apart constantly: "back in 2019 I was
          // vegetarian", written today, is the newer row and the older fact.
          // Retiring by ingestion time would then silence the CURRENT memory.
          const superseded = supersededIndex === a ? noteA : supersededIndex === b ? noteB : null
          if (!superseded) {
            // The model could not tell. Marking already happened above, so the
            // conflict is visible for review — but nothing gets retired on a
            // guess. This is the safe half of auto mode, not a failure.
            log(`[conflict] auto: no superseded side identified — marked only, nothing retired`)
          } else {
            const ok = await ctx.invalidateNote(superseded.id, agentId)
            if (ok) {
              retired++
              log(`[conflict] auto-retired the superseded note ${superseded.id.slice(0, 8)}`)
            }
          }
        }
      }
    }
  }

  log(`[conflict] scanned ${notes.length} notes, found ${pairsFound} pair(s), retired ${retired}`)
  return { scanned: notes.length, pairsFound, retired }
}

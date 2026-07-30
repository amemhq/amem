/**
 * Story 50 — identity is required, and `SYSTEM_ACTOR` is how a call says it has
 * none.
 *
 * These three functions used to take an *optional* identity, and omitting it
 * skipped the authorization check entirely. The safe behaviour was the one you
 * had to remember to ask for, and "no check here" looked identical to an
 * oversight. Against a real Qdrant because the check sits between the fetch and
 * the return, and a mocked store would just replay whatever the mock decided.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'

const DIM = 8

vi.mock('../../src/embedding.js', () => ({
  encode: async (t: string) => {
    const v = new Array(DIM).fill(0)
    for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) + 1
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / n)
  },
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  getEmbeddingDim: async () => DIM,
  getEmbeddingModel: () => 'test/fake-encoder',
  getEmbeddingPooling: () => 'mean',
  // This test pins getEmbeddingModel to a constant, so model resolution has
  // nothing to resolve. Stubbed as no-ops rather than omitted: ensureCollection
  // calls both, and a missing export is a hard mock error.
  pinEmbeddingModel: () => {},
  getPinnedEmbeddingModel: () => null,
}))

import { createStorageContext, type MemoryNote } from '../../src/storage.js'
import { SYSTEM_ACTOR } from '../../src/auth.js'

const QDRANT = 'http://localhost:6333'
const collection = `amem_sysactor_${process.pid}`

const privateNote = (id: string, owner: string): MemoryNote => {
  const now = new Date().toISOString()
  return {
    id,
    content: `${owner}'s private note`,
    keywords: [],
    tags: [],
    context: '',
    embedding: new Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    links: [],
    timestamp: now,
    agent_id: owner,
    hash: id,
    retrieval_count: 0,
    last_accessed: now,
    evolution_history: [],
    category: 'General',
    is_active: true,
    note_type: 'memory',
    topics: [],
    pending_merge: false,
    conflict: false,
    subjects: [],
    ephemeral: false,
    low_quality: false,
    owner,
    readers: [owner],
    writers: [owner],
  }
}

const ID = `00000000-0000-4000-8000-${String(process.pid).padStart(12, '7')}`

afterAll(async () => {
  await fetch(`${QDRANT}/collections/${collection}`, { method: 'DELETE' })
})

describe('SYSTEM_ACTOR (integration — requires Qdrant on :6333)', () => {
  it('reads a note nobody else may read, and refuses the same note to a stranger', async () => {
    const ctx = createStorageContext(collection)
    await ctx.addNote(privateNote(ID, 'alice'))

    // The engine acting as itself: consolidation and the write-policy fetch both
    // need this, and neither has an agent on whose behalf it acts.
    const asSystem = await ctx.getNote(ID, SYSTEM_ACTOR)
    expect(asSystem?.content).toBe("alice's private note")

    // A real identity is still checked. If the sentinel were simply "any string
    // bypasses", this would also come back — which is exactly the old behaviour
    // with extra steps.
    expect(await ctx.getNote(ID, 'mallory')).toBeNull()

    // And the owner reads their own note normally.
    expect((await ctx.getNote(ID, 'alice'))?.content).toBe("alice's private note")
  })

  it('refuses a write from a stranger and allows one as the system', async () => {
    const ctx = createStorageContext(collection)
    const id = `00000000-0000-4000-8000-${String(process.pid).padStart(12, '8')}`
    await ctx.addNote(privateNote(id, 'alice'))

    const vec = new Array(DIM).fill(0).map((_, i) => (i === 1 ? 1 : 0))
    expect(await ctx.updateNoteContent(id, 'rewritten by mallory', vec, 'h1', 'mallory')).toBe(false)
    expect((await ctx.getNote(id, SYSTEM_ACTOR))?.content).toBe("alice's private note")

    // Maintenance writes are the reason the sentinel exists at all.
    expect(await ctx.updateNoteContent(id, 'rewritten by the engine', vec, 'h2', SYSTEM_ACTOR)).toBe(true)
    expect((await ctx.getNote(id, SYSTEM_ACTOR))?.content).toBe('rewritten by the engine')
  })

  it('applies the same rule to invalidateNote', async () => {
    const ctx = createStorageContext(collection)
    const id = `00000000-0000-4000-8000-${String(process.pid).padStart(12, '9')}`
    await ctx.addNote(privateNote(id, 'alice'))

    expect(await ctx.invalidateNote(id, 'mallory')).toBe(false)
    expect((await ctx.getNote(id, SYSTEM_ACTOR))?.is_active).toBe(true)

    expect(await ctx.invalidateNote(id, 'alice')).toBe(true)
    expect((await ctx.getNote(id, SYSTEM_ACTOR))?.is_active).toBe(false)
  })
})

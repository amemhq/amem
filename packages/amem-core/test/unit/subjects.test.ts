/**
 * Story 44 — "who is this memory about", separate from "whose store is it in".
 *
 * The visibility rule falls out of the array shape:
 *   []      world fact / about the agent itself  → always in scope
 *   [a]     about one person                     → in scope only for them
 *   [a, b]  a shared experience                  → in scope for either
 *
 * The filter is asserted as the exact object handed to Qdrant, because that is
 * where the isolation actually happens — a post-filter in JS would be a
 * different (and leakier) design. The live syntax was verified against a real
 * Qdrant before this was written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/llm.js', () => ({
  llmConstructNote: vi.fn(async () => ({
    keywords: [],
    tags: [],
    context: '',
    category: 'General',
    note_type: 'memory',
    topics: [],
    confidence: 'high',
  })),
  llmShouldLink: vi.fn(async () => false),
  llmEvolveNote: vi.fn(),
  llmShouldMerge: vi.fn(),
  llmEvolutionJudge: vi.fn(),
  llmConflictScan: vi.fn(async () => []),
}))
vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(async () => [1, 0]),
  cosineSimilarity: () => 0,
}))

import { addMemory, searchMemory } from '../../src/memory.js'
import type { MemoryNote, StorageContext } from '../../src/storage.js'

function makeCtx() {
  const added: MemoryNote[] = []
  const ctx = {
    findByHash: vi.fn(async () => null),
    countNotes: vi.fn(async () => 3),
    queryByEmbedding: vi.fn(async () => []),
    listNotes: vi.fn(async () => []),
    addNote: vi.fn(async (n: MemoryNote) => {
      added.push(n)
    }),
    updateNote: vi.fn(async () => {}),
    updateNoteContent: vi.fn(async () => true),
    getNote: vi.fn(async () => null),
  } as unknown as StorageContext
  return { ctx, added }
}

beforeEach(() => vi.clearAllMocks())

describe('writing a memory about someone', () => {
  it('records the people it is about', async () => {
    const { ctx, added } = makeCtx()
    await addMemory('alex prefers mining at night', 'main', { subjects: ['alex'], storageCtx: ctx })
    expect(added[0].subjects).toEqual(['alex'])
  })

  it('records several people for a shared experience', async () => {
    const { ctx, added } = makeCtx()
    await addMemory('we beat the ender dragon together', 'main', { subjects: ['alex', 'sam'], storageCtx: ctx })
    expect(added[0].subjects).toEqual(['alex', 'sam'])
  })

  it('defaults to nobody — a world fact — so existing behaviour is unchanged', async () => {
    const { ctx, added } = makeCtx()
    await addMemory('the server spawn is in a desert', 'main', { storageCtx: ctx })
    expect(added[0].subjects).toEqual([])
  })
})

describe('retrieval scoping', () => {
  it('scopes BOTH retrieval paths, not just the vector one', async () => {
    // searchMemory reads twice: queryByEmbedding for vectors, and listNotes for
    // BM25 + the BFS neighbourhood map. Scoping only the first would leak another
    // person's memories through keyword search — the Story 36 mistake repeated.
    const { ctx } = makeCtx()
    await searchMemory('mining', 5, 'main', { subject: 'alex', storageCtx: ctx })

    expect(vi.mocked(ctx.queryByEmbedding).mock.calls[0][4]).toBe('alex')
    expect(vi.mocked(ctx.listNotes).mock.calls[0][1]).toBe('alex')
  })

  it('passes no subject when none is asked for', async () => {
    const { ctx } = makeCtx()
    await searchMemory('mining', 5, 'main', { storageCtx: ctx })

    expect(vi.mocked(ctx.queryByEmbedding).mock.calls[0][4]).toBeUndefined()
    expect(vi.mocked(ctx.listNotes).mock.calls[0][1]).toBeUndefined()
  })
})

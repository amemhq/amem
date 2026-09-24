import { describe, it, expect, vi, beforeEach } from 'vitest'

const { shouldLink } = vi.hoisted(() => ({ shouldLink: vi.fn(async () => false) }))

vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(async () => [1, 0, 0]),
  cosineSimilarity: () => 0,
}))
vi.mock('../../src/llm.js', () => ({
  llmConstructNote: vi.fn(async () => ({
    keywords: ['k'],
    tags: ['t'],
    context: 'c',
    category: 'General',
    note_type: 'memory',
    topics: [],
    confidence: 'high',
  })),
  llmShouldLink: shouldLink,
  llmEvolveNote: vi.fn(),
  llmShouldMerge: vi.fn(),
  llmEvolutionJudge: vi.fn(),
  llmCrudDecision: vi.fn(),
}))

import { addMemory } from '../../src/memory.js'
import type { MemoryNote, StorageContext } from '../../src/storage.js'

const CONTENT = 'a sufficiently long synthetic memory note for testing'

function candidate(id: string): { note: MemoryNote; score: number } {
  return { note: { id, content: `synthetic neighbour ${id}` } as MemoryNote, score: 0.6 }
}

function makeCtx() {
  return {
    findByHash: vi.fn(async () => null),
    // First call is the dedup probe (nothing close), second the link candidates.
    queryByEmbedding: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate('a'), candidate('b'), candidate('c')]),
    addNote: vi.fn(async () => {}),
    countNotes: vi.fn(async () => 10),
    updateNote: vi.fn(async () => {}),
    getNote: vi.fn(async () => null),
  } as unknown as StorageContext & { addNote: ReturnType<typeof vi.fn> }
}

beforeEach(() => shouldLink.mockClear())

describe('addMemory with a deadline', () => {
  it('asks about every candidate link when there is no deadline', async () => {
    const ctx = makeCtx()
    await addMemory(CONTENT, 'main', { storageCtx: ctx })
    expect(shouldLink).toHaveBeenCalledTimes(3)
  })

  it('stores the note but stops linking once the time is gone', async () => {
    const ctx = makeCtx()
    await addMemory(CONTENT, 'main', { storageCtx: ctx, deadline: Date.now() + 1000 })
    expect(ctx.addNote).toHaveBeenCalledTimes(1)
    expect(shouldLink).not.toHaveBeenCalled()
  })
})

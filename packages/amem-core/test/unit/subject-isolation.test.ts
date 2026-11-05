/**
 * Notes about different people stay apart in every write path: dedup, linking and the
 * nightly merge, consolidation and conflict passes. Synthetic notes and a mock storage
 * context; nothing touches a real Qdrant or a real memory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { shouldLink, shouldMerge, evolutionJudge, conflictScan, evolveNote } = vi.hoisted(() => ({
  evolveNote: vi.fn(),
  shouldLink: vi.fn(),
  shouldMerge: vi.fn(),
  evolutionJudge: vi.fn(),
  conflictScan: vi.fn(),
}))

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
  llmShouldLink: shouldLink,
  llmEvolveNote: evolveNote,
  llmShouldMerge: shouldMerge,
  llmEvolutionJudge: evolutionJudge,
  llmConflictScan: conflictScan,
}))
vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(async () => [1, 0]),
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
}))

// Evolution is normally gated behind a write counter; force it on.
vi.mock('../../src/evo-counter.js', () => ({
  shouldRunEvolution: () => true,
  getEvoCount: () => 20,
  incrementEvoCount: vi.fn(() => 20),
}))

import { addMemory, mergeSimilarNotes, consolidateMemories, conflictSweep } from '../../src/memory.js'
import type { MemoryNote, StorageContext } from '../../src/storage.js'

const CONTENT = 'User prefers the hard difficulty setting'

function note(id: string, subjects: string[], over: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id,
    subjects,
    content: `synthetic note ${id}`,
    timestamp: '2026-09-24T10:00:00.000Z',
    keywords: [],
    tags: [],
    context: '',
    embedding: [1, 0],
    links: [],
    agent_id: 'main',
    hash: id,
    retrieval_count: 0,
    last_accessed: '2026-09-24T10:00:00.000Z',
    evolution_history: [],
    category: 'Personal',
    is_active: true,
    note_type: 'memory',
    topics: [],
    pending_merge: false,
    conflict: false,
    ephemeral: false,
    low_quality: false,
    owner: 'main',
    readers: ['main'],
    writers: ['main'],
    ...over,
  } as MemoryNote
}

/** A queryByEmbedding that, like the real one, returns at most topK hits. */
const topKOf = (hits: Array<{ note: MemoryNote; score: number }>) =>
  vi.fn(async (_embedding: number[], topK: number) => hits.slice(0, topK))

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    findByHash: vi.fn(async () => null),
    countNotes: vi.fn(async () => 3),
    queryByEmbedding: vi.fn(async () => []),
    listNotes: vi.fn(async () => []),
    addNote: vi.fn(async () => {}),
    updateNote: vi.fn(async () => {}),
    updateNoteContent: vi.fn(async () => true),
    getNote: vi.fn(async () => null),
    getNotesByDatePrefix: vi.fn(async () => []),
    patchNotePayload: vi.fn(async () => {}),
    deleteNote: vi.fn(async () => {}),
    invalidateNote: vi.fn(async () => true),
    ...over,
  } as unknown as StorageContext & Record<string, ReturnType<typeof vi.fn>>
}

beforeEach(() => {
  for (const f of [shouldLink, shouldMerge, evolutionJudge, conflictScan, evolveNote]) f.mockReset()
  shouldLink.mockResolvedValue(false)
  conflictScan.mockResolvedValue([])
})

describe('addMemory dedup', () => {
  it("does not treat another person's note with the same text as a duplicate", async () => {
    const ctx = makeCtx({ findByHash: vi.fn(async () => note('alice', ['telegram:111'])) })
    await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })
    expect(ctx.addNote).toHaveBeenCalledTimes(1)
  })

  it('still dedups on an identical hash with the same subjects', async () => {
    const ctx = makeCtx({ findByHash: vi.fn(async () => note('bob', ['telegram:222'])) })
    expect(await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })).toBe('bob')
    expect(ctx.addNote).not.toHaveBeenCalled()
  })

  it('never folds into a note tagged for someone else', async () => {
    const ctx = makeCtx({
      queryByEmbedding: vi.fn(async () => [{ note: note('alice', ['telegram:111']), score: 0.95 }]),
    })
    await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })
    expect(ctx.updateNoteContent).not.toHaveBeenCalled()
    expect(ctx.addNote).toHaveBeenCalledTimes(1)
  })

  it('never folds a speaker fact into an untagged note, nor an untagged one into a tagged note', async () => {
    const world = makeCtx({ queryByEmbedding: vi.fn(async () => [{ note: note('w', []), score: 0.95 }]) })
    await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: world })
    expect(world.updateNoteContent).not.toHaveBeenCalled()

    const tagged = makeCtx({
      queryByEmbedding: vi.fn(async () => [{ note: note('t', ['telegram:222']), score: 0.95 }]),
    })
    await addMemory(CONTENT, 'main', { storageCtx: tagged })
    expect(tagged.updateNoteContent).not.toHaveBeenCalled()
  })

  it('folds into a close match with the same subjects, even when a closer one belongs to someone else', async () => {
    const ctx = makeCtx({
      queryByEmbedding: topKOf([
        { note: note('alice', ['telegram:111']), score: 0.99 },
        { note: note('bob', ['telegram:222']), score: 0.9 },
      ]),
    })
    expect(await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })).toBe('bob')
    expect(vi.mocked(ctx.updateNoteContent).mock.calls[0][0]).toBe('bob')
  })

  it("scopes the dedup probe to the note's subject", async () => {
    const ctx = makeCtx()
    await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })
    expect(vi.mocked(ctx.queryByEmbedding).mock.calls[0][4]).toBe('telegram:222')
  })

  it('does not link to, or evolve, a note about someone else', async () => {
    const ctx = makeCtx({
      queryByEmbedding: vi.fn(async () => [{ note: note('alice', ['telegram:111']), score: 0.5 }]),
    })
    await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })
    expect(shouldLink).not.toHaveBeenCalled()
  })
})

describe('evolution and strengthening', () => {
  const people = (id: string, subjects: string[], over: Partial<MemoryNote> = {}) => note(id, subjects, over)

  it('does not evolve a linked note whose subjects differ from the new note', async () => {
    const cand = people('cand', ['telegram:222'])
    // The note read back by id differs from the one the query returned.
    const ctx = makeCtx({
      queryByEmbedding: topKOf([{ note: cand, score: 0.5 }]),
      getNote: vi.fn(async () => people('cand', ['telegram:111'])),
    })
    shouldLink.mockResolvedValue(true)
    await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })
    expect(evolveNote).not.toHaveBeenCalled()
  })

  it("keeps another person's notes out of the evolution prompt", async () => {
    const cand = people('cand', ['telegram:222'], { links: ['other', 'mine'] })
    const byId: Record<string, MemoryNote> = {
      cand,
      other: people('other', ['telegram:111']),
      mine: people('mine', ['telegram:222']),
    }
    const ctx = makeCtx({
      queryByEmbedding: topKOf([{ note: cand, score: 0.5 }]),
      getNote: vi.fn(async (id: string) => byId[id] ?? null),
    })
    shouldLink.mockResolvedValue(true)
    evolveNote.mockResolvedValue({
      tags: null,
      context: null,
      shouldStrengthen: false,
      suggestedConnections: [],
      tagsToUpdate: [],
    })
    await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })
    const ids = (evolveNote.mock.calls[0][1] as Array<{ id: string }>).map((n) => n.id)
    expect(ids).toContain('mine')
    expect(ids).not.toContain('other')
  })

  it('does not link to a suggested neighbour about someone else, nor add a back-link', async () => {
    const cand = people('cand', ['telegram:222'])
    const stranger = people('stranger', ['telegram:111'])
    const friend = people('friend', ['telegram:222'])
    const byId: Record<string, MemoryNote> = { cand, stranger, friend }
    const ctx = makeCtx({
      queryByEmbedding: topKOf([{ note: cand, score: 0.5 }]),
      getNote: vi.fn(async (id: string) => byId[id] ?? null),
    })
    shouldLink.mockResolvedValue(true)
    evolveNote.mockResolvedValue({
      tags: null,
      context: null,
      shouldStrengthen: true,
      suggestedConnections: ['stranger', 'friend'],
      tagsToUpdate: [],
    })
    const id = await addMemory(CONTENT, 'main', { subjects: ['telegram:222'], storageCtx: ctx })
    expect(stranger.links).not.toContain(id)
    expect(friend.links).toContain(id)
    const added = vi.mocked(ctx.addNote).mock.calls[0][0] as MemoryNote
    expect(added.links).toContain('friend')
    expect(added.links).not.toContain('stranger')
  })
})

describe('nightly passes', () => {
  it('mergeSimilarNotes does not merge a pending note into a neighbour about someone else', async () => {
    const ctx = makeCtx({
      getNotesByDatePrefix: vi.fn(async () => [
        note('p', ['telegram:222'], { pending_merge: true }),
        note('q', ['telegram:111']),
      ]),
    })
    await mergeSimilarNotes('main', ctx, '2026-09-24')
    expect(evolutionJudge).not.toHaveBeenCalled()
    expect(ctx.updateNoteContent).not.toHaveBeenCalled()
    expect(ctx.deleteNote).not.toHaveBeenCalled()
  })

  it('mergeSimilarNotes does not pair notes about different people', async () => {
    const people = ['telegram:111', 'telegram:222']
    const ctx = makeCtx({
      getNotesByDatePrefix: vi.fn(async () => [0, 1, 2, 3, 4, 5].map((i) => note(`n${i}`, [people[i % 2]]))),
    })
    shouldMerge.mockResolvedValue({ shouldMerge: false })
    await mergeSimilarNotes('main', ctx, '2026-09-24')
    // Within one person the pairs are still visited, across people never.
    expect(shouldMerge).toHaveBeenCalled()
    for (const [a, b] of shouldMerge.mock.calls) {
      expect(Number(a.slice(-1)) % 2).toBe(Number(b.slice(-1)) % 2)
    }
  })

  it('consolidateMemories does not compare notes about different people', async () => {
    const ctx = makeCtx({ listNotes: vi.fn(async () => [note('a', ['telegram:111']), note('b', ['telegram:222'])]) })
    await consolidateMemories('main', undefined, ctx)
    expect(shouldMerge).not.toHaveBeenCalled()
  })

  it('consolidateMemories still compares notes with the same subjects', async () => {
    shouldMerge.mockResolvedValue({ shouldMerge: false })
    const ctx = makeCtx({ listNotes: vi.fn(async () => [note('a', ['telegram:111']), note('b', ['telegram:111'])]) })
    await consolidateMemories('main', undefined, ctx)
    expect(shouldMerge).toHaveBeenCalledTimes(1)
  })

  it('conflictSweep does not batch notes about different people', async () => {
    const ctx = makeCtx({ listNotes: vi.fn(async () => [note('a', ['telegram:111']), note('b', ['telegram:222'])]) })
    await conflictSweep('main', { storageCtx: ctx, mode: 'auto' })
    expect(conflictScan).not.toHaveBeenCalled()
    expect(ctx.invalidateNote).not.toHaveBeenCalled()
  })

  it('conflictSweep still batches notes with the same subjects', async () => {
    const ctx = makeCtx({ listNotes: vi.fn(async () => [note('a', ['telegram:111']), note('b', ['telegram:111'])]) })
    await conflictSweep('main', { storageCtx: ctx })
    expect(conflictScan).toHaveBeenCalledTimes(1)
  })
})

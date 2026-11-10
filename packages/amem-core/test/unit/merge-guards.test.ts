/**
 * The nightly merge retires a note only after the text merged out of it is written. A write
 * the store refuses, because the target note is gone or not the caller's, must not be
 * followed by the retirement, or both notes are lost. Synthetic notes and a mock context only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/llm.js', () => ({
  llmConstructNote: vi.fn(),
  llmShouldLink: vi.fn(),
  llmEvolveNote: vi.fn(),
  llmShouldMerge: vi.fn(async () => ({ shouldMerge: true, merged: 'merged text' })),
  llmEvolutionJudge: vi.fn(async () => ({ type: 'EVOLVE', mergedContent: 'merged text' })),
  llmConflictScan: vi.fn(),
}))
vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(async () => [1, 0]),
  // Only notes with the same embedding are similar.
  cosineSimilarity: (a: number[], b: number[]) => (a.every((x, i) => x === b[i]) ? 1 : 0),
}))

import { mergeSimilarNotes } from '../../src/memory.js'
import type { MemoryNote, StorageContext } from '../../src/storage.js'

function note(id: string, embedding: number[], over: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id,
    content: `synthetic note ${id}`,
    timestamp: '2026-11-04T00:00:00.000Z',
    keywords: [],
    tags: [],
    context: '',
    embedding,
    links: [],
    agent_id: 'main',
    hash: id,
    retrieval_count: 0,
    last_accessed: '2026-11-04T00:00:00.000Z',
    is_active: true,
    owner: 'main',
    readers: ['main'],
    writers: ['main'],
    evolution_history: [],
    category: 'General',
    note_type: 'memory',
    topics: [],
    pending_merge: false,
    conflict: false,
    subjects: [],
    ephemeral: false,
    low_quality: false,
    ...over,
  }
}

function makeCtx(notes: MemoryNote[], updated: boolean) {
  return {
    getNotesByDatePrefix: vi.fn(async () => notes),
    updateNoteContent: vi.fn(async () => updated),
    patchNotePayload: vi.fn(async () => {}),
    getNote: vi.fn(async () => null),
    invalidateNote: vi.fn(async () => true),
    replaceLinkReferences: vi.fn(async () => {}),
  } as unknown as StorageContext &
    Record<'updateNoteContent' | 'patchNotePayload' | 'invalidateNote', ReturnType<typeof vi.fn>>
}

beforeEach(() => vi.clearAllMocks())

describe('a pending note merged into its neighbour', () => {
  const notes = () => [note('pending', [1, 0], { pending_merge: true }), note('neighbour', [1, 0])]

  it('is retired once the merged text is written', async () => {
    const ctx = makeCtx(notes(), true)
    await mergeSimilarNotes('main', ctx, '2026-11-04')
    expect(ctx.invalidateNote).toHaveBeenCalledWith('pending', 'main')
  })

  it('stays when the write is refused', async () => {
    const ctx = makeCtx(notes(), false)
    await mergeSimilarNotes('main', ctx, '2026-11-04')
    expect(ctx.invalidateNote).not.toHaveBeenCalled()
    expect(ctx.patchNotePayload).not.toHaveBeenCalled()
  })
})

describe('the shorter of two similar notes', () => {
  const notes = () => [
    note('a', [1, 0], { content: 'the longer synthetic note of the pair' }),
    note('b', [1, 0], { content: 'the shorter one' }),
    note('c', [0, 1]),
    note('d', [0, 2]),
    note('e', [0, 3]),
  ]

  it('is retired once the merged text is written into the longer one', async () => {
    const ctx = makeCtx(notes(), true)
    await mergeSimilarNotes('main', ctx, '2026-11-04')
    expect(ctx.updateNoteContent).toHaveBeenCalledWith('a', 'merged text', [1, 0], expect.any(String), 'main')
    expect(ctx.invalidateNote).toHaveBeenCalledWith('b', 'main')
  })

  it('stays when the write is refused', async () => {
    const ctx = makeCtx(notes(), false)
    await mergeSimilarNotes('main', ctx, '2026-11-04')
    expect(ctx.invalidateNote).not.toHaveBeenCalled()
  })
})

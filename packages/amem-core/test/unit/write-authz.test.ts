/**
 * Story 33 — the audited write paths must refuse to mutate a note the caller is
 * not a writer of. Every case here uses synthetic notes and an injected mock
 * StorageContext; nothing touches a real Qdrant or a real memory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fakeEncode } = vi.hoisted(() => ({
  fakeEncode: (t: string) => Array.from({ length: 8 }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 7) / 7),
}))

vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(async (t: string) => fakeEncode(t)),
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
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
  llmShouldLink: vi.fn(async () => false),
  llmEvolveNote: vi.fn(),
  llmShouldMerge: vi.fn(),
  llmEvolutionJudge: vi.fn(),
  llmCrudDecision: vi.fn(),
}))

import { addMemory } from '../../src/memory.js'
import type { MemoryNote, StorageContext } from '../../src/storage.js'

const CONTENT = 'a sufficiently long synthetic memory note for testing'

/** A note owned by someone else, shared for reading but not writable by us. */
function foreignSharedNote(): MemoryNote {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    content: 'another agent shared memory',
    timestamp: new Date().toISOString(),
    keywords: [],
    tags: [],
    context: '',
    embedding: fakeEncode('another agent shared memory'),
    links: [],
    agent_id: 'shared',
    hash: 'deadbeef',
    retrieval_count: 0,
    last_accessed: new Date().toISOString(),
    is_active: true,
    owner: 'agentA',
    readers: ['*'],
    writers: ['agentA'],
    evolution_history: [],
    category: 'General',
    note_type: 'memory',
    topics: [],
    pending_merge: false,
    conflict: false,
    subjects: [],
    ephemeral: false,
    low_quality: false,
  }
}

function makeCtx(topMatch: { note: MemoryNote; score: number } | null) {
  const added: MemoryNote[] = []
  const ctx = {
    findByHash: vi.fn(async () => null),
    queryByEmbedding: vi.fn(async () => (topMatch ? [topMatch] : [])),
    addNote: vi.fn(async (n: MemoryNote) => {
      added.push(n)
    }),
    updateNoteContent: vi.fn(async () => true),
    updateNote: vi.fn(async () => {}),
    getNote: vi.fn(async () => topMatch?.note ?? null),
  } as unknown as StorageContext
  return { ctx, added }
}

beforeEach(() => vi.clearAllMocks())

describe('gap A — high-similarity dedup must not overwrite an unowned note', () => {
  it('inserts its own note instead of updating another agent’s shared note', async () => {
    const { ctx, added } = makeCtx({ note: foreignSharedNote(), score: 0.93 })

    const id = await addMemory(CONTENT, 'agentB', { storageCtx: ctx })

    // The foreign note is untouched...
    expect(ctx.updateNoteContent).not.toHaveBeenCalled()
    // ...and agentB gets its own note instead.
    expect(added).toHaveLength(1)
    expect(added[0].owner).toBe('agentB')
    expect(id).toBe(added[0].id)
    expect(id).not.toBe(foreignSharedNote().id)
  })

  it('still folds into a match the caller DOES own (no regression)', async () => {
    const own = { ...foreignSharedNote(), agent_id: 'agentB', owner: 'agentB', writers: ['agentB'] }
    const { ctx, added } = makeCtx({ note: own, score: 0.93 })

    const id = await addMemory(CONTENT, 'agentB', { storageCtx: ctx })

    expect(ctx.updateNoteContent).toHaveBeenCalledOnce()
    expect(id).toBe(own.id)
    expect(added).toHaveLength(0)
  })

  it('folds into a shared note that explicitly authorizes the caller', async () => {
    const authorized = { ...foreignSharedNote(), writers: ['agentA', 'agentB'] }
    const { ctx } = makeCtx({ note: authorized, score: 0.93 })

    const id = await addMemory(CONTENT, 'agentB', { storageCtx: ctx })

    expect(ctx.updateNoteContent).toHaveBeenCalledOnce()
    expect(id).toBe(authorized.id)
  })
})

describe('gap F — bidirectional back-link must not be written into an unowned note', () => {
  it('does not push our id into another agent’s shared note', async () => {
    const foreign = foreignSharedNote()
    // Below the 0.85 dedup bar so we reach the linking step, above the 0.3 link bar.
    const { ctx } = makeCtx({ note: foreign, score: 0.5 })
    const llm = await import('../../src/llm.js')
    vi.mocked(llm.llmShouldLink).mockResolvedValue(true)

    await addMemory(CONTENT, 'agentB', { storageCtx: ctx })

    // updateNote may be called for our OWN new note, but never for the foreign one.
    const wroteForeign = vi
      .mocked(ctx.updateNote)
      .mock.calls.some((c) => (c[0] as MemoryNote | undefined)?.id === foreign.id)
    expect(wroteForeign).toBe(false)
    expect(foreign.links).not.toContain(added0(ctx))
  })
})

/** id of the note this ctx recorded via addNote, if any. */
function added0(ctx: StorageContext): string | undefined {
  const call = vi.mocked(ctx.addNote).mock.calls[0]
  return (call?.[0] as MemoryNote | undefined)?.id
}

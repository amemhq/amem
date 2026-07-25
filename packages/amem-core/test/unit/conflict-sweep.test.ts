/**
 * Story 43 — the cold-layer sweep. Synthetic notes + an injected mock storage
 * context; nothing touches a real Qdrant or a real memory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { conflictScan } = vi.hoisted(() => ({ conflictScan: vi.fn() }))

vi.mock('../../src/llm.js', () => ({
  llmConstructNote: vi.fn(),
  llmShouldLink: vi.fn(),
  llmEvolveNote: vi.fn(),
  llmShouldMerge: vi.fn(),
  llmEvolutionJudge: vi.fn(),
  llmConflictScan: conflictScan,
}))
vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(),
  cosineSimilarity: () => 0,
}))

import { conflictSweep } from '../../src/memory.js'
import type { MemoryNote, StorageContext } from '../../src/storage.js'

function note(over: Partial<MemoryNote> & Pick<MemoryNote, 'id' | 'content' | 'timestamp'>): MemoryNote {
  return {
    keywords: [],
    tags: [],
    context: '',
    embedding: [],
    links: [],
    agent_id: 'main',
    hash: over.id,
    retrieval_count: 0,
    last_accessed: over.timestamp,
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

const OLD = note({ id: 'aaa', content: 'user is vegetarian', timestamp: '2026-01-01T00:00:00.000Z' })
const NEW = note({ id: 'bbb', content: 'user loved the steak', timestamp: '2026-06-01T00:00:00.000Z' })

function makeCtx(notes: MemoryNote[]) {
  return {
    listNotes: vi.fn(async () => notes),
    patchNotePayload: vi.fn(async () => {}),
    invalidateNote: vi.fn(async () => true),
  } as unknown as StorageContext
}

beforeEach(() => {
  conflictScan.mockReset()
  vi.unstubAllEnvs()
})
afterEach(() => vi.unstubAllEnvs())

describe('conflictSweep — review mode (default)', () => {
  it('marks BOTH notes, each pointing at the other, and retires nothing', async () => {
    conflictScan.mockResolvedValue([{ a: 0, b: 1, reason: 'diet' }])
    const ctx = makeCtx([OLD, NEW])

    const res = await conflictSweep('main', { storageCtx: ctx })

    expect(res).toMatchObject({ pairsFound: 1, retired: 0 })
    expect(ctx.invalidateNote).not.toHaveBeenCalled()

    const patches = vi.mocked(ctx.patchNotePayload).mock.calls
    expect(patches).toHaveLength(2)
    const byId = Object.fromEntries(patches.map((c) => [c[0], c[1] as Record<string, unknown>]))
    expect(byId['aaa']).toMatchObject({ conflict: true, conflicts_with: ['bbb'], conflict_reason: 'diet' })
    expect(byId['bbb']).toMatchObject({ conflict: true, conflicts_with: ['aaa'], conflict_reason: 'diet' })
  })

  it('does nothing when the model finds no contradiction', async () => {
    conflictScan.mockResolvedValue([])
    const ctx = makeCtx([OLD, NEW])

    const res = await conflictSweep('main', { storageCtx: ctx })

    expect(res.pairsFound).toBe(0)
    expect(ctx.patchNotePayload).not.toHaveBeenCalled()
  })
})

describe('conflictSweep — auto mode', () => {
  it('retires the side the MODEL named as superseded', async () => {
    conflictScan.mockResolvedValue([{ a: 0, b: 1, reason: 'diet', supersededIndex: 0 }])
    const ctx = makeCtx([OLD, NEW])

    const res = await conflictSweep('main', { mode: 'auto', storageCtx: ctx })

    expect(res.retired).toBe(1)
    expect(ctx.invalidateNote).toHaveBeenCalledOnce()
    expect(vi.mocked(ctx.invalidateNote).mock.calls[0][0]).toBe('aaa') // the one the model named
  })

  it('still marks both notes in auto mode, so the decision stays auditable', async () => {
    conflictScan.mockResolvedValue([{ a: 0, b: 1, reason: 'diet', supersededIndex: 0 }])
    const ctx = makeCtx([OLD, NEW])

    await conflictSweep('main', { mode: 'auto', storageCtx: ctx })
    expect(ctx.patchNotePayload).toHaveBeenCalledTimes(2)
  })

  it('is opt-in: AMEM_CONFLICT_MODE selects it, and anything else means review', async () => {
    conflictScan.mockResolvedValue([{ a: 0, b: 1, reason: 'd', supersededIndex: 0 }])

    vi.stubEnv('AMEM_CONFLICT_MODE', 'auto')
    const ctxAuto = makeCtx([OLD, NEW])
    expect((await conflictSweep('main', { storageCtx: ctxAuto })).retired).toBe(1)

    vi.stubEnv('AMEM_CONFLICT_MODE', 'something-else')
    const ctxSafe = makeCtx([OLD, NEW])
    expect((await conflictSweep('main', { storageCtx: ctxSafe })).retired).toBe(0)
  })
})

describe('conflictSweep — what it refuses to scan', () => {
  it("skips other agents' shared notes, knowledge notes, and already-retired ones", async () => {
    const shared = note({ id: 'sh', content: 's', timestamp: '2026-02-01T00:00:00.000Z', agent_id: 'shared' })
    const knowledge = note({ id: 'kn', content: 'k', timestamp: '2026-02-01T00:00:00.000Z', note_type: 'knowledge' })
    const retired = note({ id: 'rt', content: 'r', timestamp: '2026-02-01T00:00:00.000Z', is_active: false })
    conflictScan.mockResolvedValue([])
    const ctx = makeCtx([OLD, NEW, shared, knowledge, retired])

    const res = await conflictSweep('main', { storageCtx: ctx })

    expect(res.scanned).toBe(2)
    expect(conflictScan.mock.calls[0][0]).toEqual([OLD.content, NEW.content])
  })

  it('does not call the model for a category with only one note', async () => {
    const lone = note({ id: 'x', content: 'alone', timestamp: '2026-02-01T00:00:00.000Z', category: 'Technical' })
    conflictScan.mockResolvedValue([])
    const ctx = makeCtx([OLD, NEW, lone])

    await conflictSweep('main', { storageCtx: ctx })

    // Personal has two notes; Technical has one and is skipped entirely.
    expect(conflictScan).toHaveBeenCalledOnce()
  })
})

describe('conflictSweep — the wall clock is not evidence', () => {
  it('retires nothing when the model cannot tell which side is superseded', async () => {
    // The safe half of auto mode. The pair is still marked for review; it is the
    // RETIREMENT that is withheld, because a guess here silences a true memory.
    conflictScan.mockResolvedValue([{ a: 0, b: 1, reason: 'diet', supersededIndex: null }])
    const ctx = makeCtx([OLD, NEW])

    const res = await conflictSweep('main', { mode: 'auto', storageCtx: ctx })

    expect(res.pairsFound).toBe(1)
    expect(res.retired).toBe(0)
    expect(ctx.invalidateNote).not.toHaveBeenCalled()
    expect(ctx.patchNotePayload).toHaveBeenCalledTimes(2) // still visible for review
  })

  it('retires the note written LATER when that is the one the model calls superseded', async () => {
    // The case an ingestion-time heuristic gets exactly backwards: a memory about
    // the past ("back in 2019 I was vegetarian") recorded today is the NEWER row
    // and the OLDER fact. Retiring by timestamp would silence the current one.
    conflictScan.mockResolvedValue([{ a: 0, b: 1, reason: 'diet', supersededIndex: 1 }])
    const ctx = makeCtx([OLD, NEW])

    const res = await conflictSweep('main', { mode: 'auto', storageCtx: ctx })

    expect(res.retired).toBe(1)
    expect(vi.mocked(ctx.invalidateNote).mock.calls[0][0]).toBe('bbb') // the LATER-written note
  })
})

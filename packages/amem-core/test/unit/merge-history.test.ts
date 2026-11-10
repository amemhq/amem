/**
 * The nightly merge and consolidation keep the text they replace. After a merge, the text
 * of every note that took part is either in a note that still exists, active or retired,
 * or in an `oldContent` entry of some note's history. The store below keeps state the way
 * Qdrant does for these calls: `updateNoteContent` appends the replaced text to the
 * history, and a payload patch replaces a field. Synthetic notes only.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const { judge, shouldMerge } = vi.hoisted(() => ({ judge: vi.fn(), shouldMerge: vi.fn() }))
vi.mock('../../src/llm.js', () => ({
  llmConstructNote: vi.fn(),
  llmShouldLink: vi.fn(),
  llmEvolveNote: vi.fn(),
  llmShouldMerge: shouldMerge,
  llmEvolutionJudge: judge,
  llmConflictScan: vi.fn(),
}))
vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(async () => [1, 0]),
  // Only notes with the same embedding are similar.
  cosineSimilarity: (a: number[], b: number[]) => (a.every((x, i) => x === b[i]) ? 1 : 0),
}))

import { mergeSimilarNotes, consolidateMemories } from '../../src/memory.js'
import { configure } from '../../src/config.js'
import type { EvolutionEntry, MemoryNote, StorageContext } from '../../src/storage.js'

function note(id: string, content: string, embedding: number[], over: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id,
    content,
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

function store(notes: MemoryNote[]) {
  const byId = new Map(notes.map((n) => [n.id, structuredClone(n)]))
  const active = async () => [...byId.values()].filter((n) => n.is_active).map((n) => structuredClone(n))
  const ctx = {
    getNotesByDatePrefix: vi.fn(active),
    listNotes: vi.fn(active),
    getNote: vi.fn(async (id: string) => (byId.has(id) ? structuredClone(byId.get(id)!) : null)),
    updateNoteContent: vi.fn(async (id: string, content: string) => {
      const n = byId.get(id)!
      const entry: EvolutionEntry = {
        triggeredBy: '',
        triggeredAt: '2026-11-04T02:30:00.000Z',
        oldContext: n.context,
        newContext: n.context,
        oldTags: n.tags,
        newTags: n.tags,
        action: 'crud_update',
        oldContent: n.content,
      }
      n.evolution_history = [...n.evolution_history, entry]
      n.content = content
      return true
    }),
    patchNotePayload: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      const n = byId.get(id)! as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(fields)) n[k] = k === 'evolution_history' ? JSON.parse(v as string) : v
    }),
    // A whole-point write, like noteToPoint: it carries only what the note object holds.
    updateNote: vi.fn(async (n: MemoryNote) => {
      byId.set(n.id, structuredClone(n))
    }),
    invalidateNote: vi.fn(async (id: string) => {
      byId.get(id)!.is_active = false
      return true
    }),
    deleteNote: vi.fn(async (id: string) => {
      byId.delete(id)
    }),
    replaceLinkReferences: vi.fn(async () => {}),
  }
  return { ctx: ctx as unknown as StorageContext & typeof ctx, byId }
}

/** The text is still somewhere in the store: as a note's content, or as an old content. */
function recoverable(byId: Map<string, MemoryNote>, text: string): boolean {
  for (const n of byId.values()) {
    if (n.content === text) return true
    if (n.evolution_history.some((e) => e.oldContent === text)) return true
  }
  return false
}

beforeAll(() => {
  // consolidateMemories appends to <dataDir>/logs/amem-consolidate.log.
  configure({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'amem-merge-history-')) })
})

beforeEach(() => {
  vi.clearAllMocks()
  shouldMerge.mockResolvedValue({ shouldMerge: true, merged: 'merged text' })
})

describe.each(['EVOLVE', 'EXPAND'])('a pending note merged into its neighbour by %s', (type) => {
  const notes = () => [
    note('pending', 'pending text', [1, 0], { pending_merge: true }),
    note('neighbour', 'neighbour text', [1, 0]),
  ]

  it('keeps the text of both notes', async () => {
    judge.mockResolvedValue({ type, mergedContent: 'merged text' })
    const { ctx, byId } = store(notes())
    await mergeSimilarNotes('main', ctx, '2026-11-04')

    expect(byId.get('neighbour')!.content).toBe('merged text')
    expect(recoverable(byId, 'neighbour text')).toBe(true)
    expect(recoverable(byId, 'pending text')).toBe(true)
    expect(ctx.deleteNote).not.toHaveBeenCalled()
    expect(byId.get('pending')!.is_active).toBe(false)
    expect(ctx.replaceLinkReferences).toHaveBeenCalledWith('pending', 'neighbour', 'main')
  })

  it('records the merge after the replaced text, not over it', async () => {
    judge.mockResolvedValue({ type, mergedContent: 'merged text' })
    const { ctx, byId } = store(notes())
    await mergeSimilarNotes('main', ctx, '2026-11-04')

    const history = byId.get('neighbour')!.evolution_history
    expect(history.map((e) => e.action)).toEqual(['crud_update', 'consolidate'])
    expect(history[1].triggeredBy).toBe('pending')
  })

  it('puts the replaced text into the merge entry when the note cannot be read back', async () => {
    judge.mockResolvedValue({ type, mergedContent: 'merged text' })
    const { ctx, byId } = store(notes())
    ctx.getNote.mockResolvedValue(null)
    await mergeSimilarNotes('main', ctx, '2026-11-04')

    const history = byId.get('neighbour')!.evolution_history
    expect(history.map((e) => e.action)).toEqual(['consolidate'])
    expect(history[0].oldContent).toBe('neighbour text')
  })
})

describe('the shorter of two similar notes', () => {
  it('is retired, and the text of both notes is kept', async () => {
    const { ctx, byId } = store([
      note('a', 'the longer synthetic note of the pair', [1, 0]),
      note('b', 'the shorter one', [1, 0]),
      note('c', 'synthetic c', [0, 1]),
      note('d', 'synthetic d', [0, 2]),
      note('e', 'synthetic e', [0, 3]),
    ])
    await mergeSimilarNotes('main', ctx, '2026-11-04')

    expect(byId.get('a')!.content).toBe('merged text')
    expect(byId.get('b')!.is_active).toBe(false)
    expect(recoverable(byId, 'the longer synthetic note of the pair')).toBe(true)
    expect(recoverable(byId, 'the shorter one')).toBe(true)
    expect(ctx.deleteNote).not.toHaveBeenCalled()
    expect(ctx.replaceLinkReferences).toHaveBeenCalledWith('b', 'a', 'main')
  })
})

describe('consolidation', () => {
  it('keeps the text of the note it rewrites', async () => {
    const { ctx, byId } = store([
      note('keep', 'the longer synthetic note of the pair', [1, 0]),
      note('drop', 'the shorter one', [1, 0]),
    ])
    await consolidateMemories('main', { info: () => {}, warn: () => {}, error: () => {} }, ctx)

    expect(byId.get('keep')!.content).toBe('merged text')
    expect(byId.get('drop')!.is_active).toBe(false)
    expect(recoverable(byId, 'the longer synthetic note of the pair')).toBe(true)
    expect(recoverable(byId, 'the shorter one')).toBe(true)
  })
})

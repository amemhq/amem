/**
 * Retiring a note records who did it, when and why; restoring clears that; listRetired finds
 * retired notes; revertNote puts back the text a rewrite replaced. Synthetic notes, a stubbed
 * Qdrant for the storage half and a stateful fake store for the revert half.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/embedding.js')>()),
  getEmbeddingDim: vi.fn(async () => 2),
  encode: vi.fn(async () => [0, 1]),
}))

import { createStorageContext, pointToNote, type MemoryNote, type StorageContext } from '../../src/storage.js'
import { revertNote } from '../../src/memory.js'

const MODEL = 'test/model'
const ID = '11111111-1111-4111-8111-111111111111'

type Call = { method: string; path: string; body: Record<string, any> }
let calls: Call[]
let points: Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }>

const reply = (result: unknown) => new Response(JSON.stringify({ status: 'ok', result }), { status: 200 })

beforeEach(() => {
  vi.stubEnv('AMEM_EMBED_MODEL', MODEL)
  calls = []
  points = [
    {
      id: ID,
      payload: { content: 'a note agentA owns', owner: 'agentA', writers: ['agentA'], readers: ['*'], is_active: false },
      vector: [1, 0],
    },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const path = new URL(url).pathname
      const method = init?.method ?? 'GET'
      if (method === 'GET' && /^\/collections\/[^/]+$/.test(path)) {
        return reply({ config: { params: { vectors: { size: 2 } }, metadata: { embedding_model: MODEL } } })
      }
      const body = init?.body ? JSON.parse(init.body) : {}
      calls.push({ method, path, body })
      if (method === 'POST' && path.endsWith('/points')) return reply(points)
      if (method === 'POST' && path.endsWith('/points/scroll')) return reply({ points })
      return reply({})
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

let n = 0
const ctx = () => createStorageContext(`retire_audit_${++n}`, false)
const payloadWrites = () => calls.filter((c) => c.path.endsWith('/points/payload')).map((c) => c.body.payload)

describe('invalidateNote', () => {
  it('records the path, the time and the reason with is_active', async () => {
    expect(await ctx().invalidateNote(ID, 'agentA', 'crud-delete', 'the user said so')).toBe(true)
    const [payload] = payloadWrites()
    expect(payload).toMatchObject({ is_active: false, retired_by: 'crud-delete', retire_reason: 'the user said so' })
    expect(Date.parse(payload.retired_at)).not.toBeNaN()
  })

  it('still takes the two arguments of 2.1.x, and records no path', async () => {
    expect(await ctx().invalidateNote(ID, 'agentA')).toBe(true)
    expect(payloadWrites()[0]).toMatchObject({ is_active: false, retired_by: '', retire_reason: '' })
  })

  it('writes nothing for a caller that may not write the note', async () => {
    expect(await ctx().invalidateNote(ID, 'mallory', 'crud-delete')).toBe(false)
    expect(payloadWrites()).toEqual([])
  })
})

describe('restoreNote', () => {
  it('reactivates the note, clears the audit fields and pending_merge, and records the restore', async () => {
    expect(await ctx().restoreNote(ID, 'agentA')).toBe(true)
    const [payload] = payloadWrites()
    expect(payload).toMatchObject({
      is_active: true,
      pending_merge: false,
      retired_at: '',
      retired_by: '',
      retire_reason: '',
    })
    expect(Date.parse(payload.restored_at)).not.toBeNaN()
  })

  it('writes nothing for a caller that may not write the note', async () => {
    expect(await ctx().restoreNote(ID, 'mallory')).toBe(false)
    expect(payloadWrites()).toEqual([])
  })
})

describe('listRetired', () => {
  const retired = (id: string, retired_at: string, timestamp: string) => ({
    id,
    payload: { content: id, owner: 'agentA', readers: ['*'], writers: ['agentA'], is_active: false, retired_at, timestamp },
  })

  it('asks Qdrant for this agent’s retired notes without vectors', async () => {
    await ctx().listRetired('agentA', 5)
    const scroll = calls.find((c) => c.path.endsWith('/points/scroll'))!
    expect(scroll.body.with_vector).toBe(false)
    expect(scroll.body.filter.must).toContainEqual({ key: 'is_active', match: { value: false } })
    expect(JSON.stringify(scroll.body.filter.must)).toContain('"agentA"')
  })

  it('puts the most recently retired first, notes without retired_at last, and stops at the limit', async () => {
    points = [
      retired('old-style', '', '2026-01-03T00:00:00.000Z'),
      retired('earlier', '2026-11-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      retired('later', '2026-11-09T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
    ]
    const ids = (await ctx().listRetired('agentA', 2)).map((n) => n.id)
    expect(ids).toEqual(['later', 'earlier'])
  })

  it('leaves out notes the agent cannot read', async () => {
    points = [{ id: 'private', payload: { content: 'x', owner: 'agentC', readers: ['agentC'], is_active: false } }]
    expect(await ctx().listRetired('agentA', 5)).toEqual([])
  })
})

describe('pointToNote', () => {
  it('reads the audit fields, and empty strings on a note retired before they existed', () => {
    const audited = pointToNote({
      id: ID,
      payload: { content: 'x', retired_at: '2026-11-10T00:00:00.000Z', retired_by: 'merge', retire_reason: 'r' },
    })
    expect([audited.retired_at, audited.retired_by, audited.retire_reason]).toEqual([
      '2026-11-10T00:00:00.000Z',
      'merge',
      'r',
    ])
    const old = pointToNote({ id: ID, payload: { content: 'x' } })
    expect([old.retired_at, old.retired_by, old.retire_reason]).toEqual(['', '', ''])
  })
})

// ── revertNote ────────────────────────────────────────────────────────────────

function fakeStore(note: Partial<MemoryNote>, writable = true) {
  const stored = { keywords: [], tags: [], context: '', evolution_history: [], ...note } as unknown as MemoryNote
  const store = {
    getNote: vi.fn(async () => (stored.id ? structuredClone(stored) : null)),
    updateNoteContent: vi.fn(async (_id: string, content: string) => {
      if (!writable) return false
      stored.evolution_history = [
        ...stored.evolution_history,
        {
          triggeredBy: '',
          triggeredAt: '2026-11-10T00:00:00.000Z',
          oldContext: '',
          newContext: '',
          oldTags: [],
          newTags: [],
          action: 'crud_update',
          oldContent: stored.content,
        },
      ]
      stored.content = content
      return true
    }),
    patchNotePayload: vi.fn(async (_id: string, fields: Record<string, unknown>) => {
      stored.evolution_history = JSON.parse(fields.evolution_history as string)
    }),
  }
  return { ctx: store as unknown as StorageContext, store, stored }
}

const rewritten = {
  id: 'n1',
  content: 'Alice left the team',
  evolution_history: [
    {
      triggeredBy: '',
      triggeredAt: '2026-11-09T00:00:00.000Z',
      oldContext: '',
      newContext: '',
      oldTags: [],
      newTags: [],
      action: 'crud_update' as const,
      oldContent: 'Alice leads the team',
    },
  ],
}

describe('revertNote', () => {
  it('puts back the replaced text and records the change as a revert', async () => {
    const { ctx, stored } = fakeStore(structuredClone(rewritten))
    expect(await revertNote('n1', 'main', ctx)).toEqual({
      status: 'ok',
      content: 'Alice leads the team',
      replaced: 'Alice left the team',
    })
    expect(stored.content).toBe('Alice leads the team')
    const last = stored.evolution_history[stored.evolution_history.length - 1]
    expect(last).toMatchObject({ action: 'revert', oldContent: 'Alice left the team' })
  })

  it('undoes itself when run twice', async () => {
    const { ctx, stored } = fakeStore(structuredClone(rewritten))
    await revertNote('n1', 'main', ctx)
    await revertNote('n1', 'main', ctx)
    expect(stored.content).toBe('Alice left the team')
  })

  it('reports a note with no earlier text, a missing note and a refused write', async () => {
    expect((await revertNote('n1', 'main', fakeStore({ id: 'n1', content: 'x' }).ctx)).status).toBe('no_history')
    expect((await revertNote('n1', 'main', fakeStore({}).ctx)).status).toBe('not_found')
    expect((await revertNote('n1', 'main', fakeStore(structuredClone(rewritten), false).ctx)).status).toBe('denied')
  })
})

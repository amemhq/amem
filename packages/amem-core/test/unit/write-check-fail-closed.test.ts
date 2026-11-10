/**
 * The by-id write paths check the writers policy against the note they read. When that read
 * failed, getNote() reported it as a missing note and the check skipped itself, so the write
 * went ahead for any caller. ClawHub's review reproduced it on 2.1.7. Synthetic notes and a
 * stubbed Qdrant only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/embedding.js')>()),
  getEmbeddingDim: vi.fn(async () => 2),
}))

import { createStorageContext } from '../../src/storage.js'

const ID = '11111111-1111-4111-8111-111111111111'
const MODEL = 'test/model'

type Point = { id: string; payload: Record<string, unknown>; vector: number[] }

let point: Point | null
let readFails: boolean
let writes: string[]

function reply(result: unknown, ok = true) {
  return new Response(JSON.stringify(ok ? { status: 'ok', result } : { status: { error: 'boom' } }), {
    status: ok ? 200 : 500,
  })
}

beforeEach(() => {
  vi.stubEnv('AMEM_EMBED_MODEL', MODEL)
  point = {
    id: ID,
    payload: { content: 'a note agentA owns', owner: 'agentA', writers: ['agentA'], readers: ['*'], is_active: true },
    vector: [1, 0],
  }
  readFails = false
  writes = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const path = new URL(url).pathname
      const method = init?.method ?? 'GET'
      if (method === 'GET' && /^\/collections\/[^/]+$/.test(path)) {
        return reply({ config: { params: { vectors: { size: 2 } }, metadata: { embedding_model: MODEL } } })
      }
      if (method === 'POST' && path.endsWith('/points')) {
        return readFails ? reply(null, false) : reply(point ? [point] : [])
      }
      writes.push(`${method} ${path}`)
      return reply({})
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// A fresh collection name per test: ensureCollection latches readiness per name.
let n = 0
const ctx = () => createStorageContext(`write_check_${++n}`, false)

describe('a write check that cannot read the note', () => {
  it('refuses the update and the invalidation by throwing, and writes nothing', async () => {
    readFails = true
    const c = ctx()

    await expect(c.updateNoteContent(ID, 'new', [0, 1], 'h', 'agentB')).rejects.toThrow()
    await expect(c.invalidateNote(ID, 'agentB', 'crud-delete')).rejects.toThrow()

    expect(writes).toEqual([])
  })

  it('still reports the failed read to a plain getNote() as a missing note', async () => {
    readFails = true

    expect(await ctx().getNote(ID, 'agentA')).toBeNull()
  })
})

describe('a write check that can read the note', () => {
  it('returns false, unwritten, for a note that does not exist', async () => {
    point = null
    const c = ctx()

    expect(await c.updateNoteContent(ID, 'new', [0, 1], 'h', 'agentA')).toBe(false)
    expect(await c.invalidateNote(ID, 'agentA', 'crud-delete')).toBe(false)
    expect(writes).toEqual([])
  })

  it('returns false, unwritten, for a caller not in writers', async () => {
    const c = ctx()

    expect(await c.updateNoteContent(ID, 'new', [0, 1], 'h', 'agentB')).toBe(false)
    expect(await c.invalidateNote(ID, 'agentB', 'crud-delete')).toBe(false)
    expect(writes).toEqual([])
  })

  it('writes for a caller in writers', async () => {
    const c = ctx()

    expect(await c.updateNoteContent(ID, 'new', [0, 1], 'h', 'agentA')).toBe(true)
    expect(await c.invalidateNote(ID, 'agentA', 'crud-delete')).toBe(true)
    expect(writes.length).toBeGreaterThan(0)
  })
})

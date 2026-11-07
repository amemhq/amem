/**
 * `worldOnly` reads only notes that name nobody. The filter is asserted as the body handed to
 * Qdrant (stubbed fetch), because that is where the scoping happens, and on both retrieval
 * paths: the vector search and the scroll that feeds BM25 and link expansion. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/embedding.js')>()),
  getEmbeddingDim: vi.fn(async () => 2),
  encode: vi.fn(async () => [1, 0]),
}))

import { createStorageContext } from '../../src/storage.js'
import { searchMemory } from '../../src/memory.js'

const MODEL = 'test/model'
const WORLD = { is_empty: { key: 'subjects' } }
const SUBJECT = { should: [{ key: 'subjects', match: { value: 'alex' } }, WORLD] }

let bodies: Array<{ path: string; body: { filter?: { must?: unknown[] } } }>

function reply(result: unknown) {
  return new Response(JSON.stringify({ status: 'ok', result }), { status: 200 })
}

beforeEach(() => {
  vi.stubEnv('AMEM_EMBED_MODEL', MODEL)
  bodies = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const path = new URL(url).pathname
      const method = init?.method ?? 'GET'
      if (method === 'GET' && /^\/collections\/[^/]+$/.test(path)) {
        return reply({ config: { params: { vectors: { size: 2 } }, metadata: { embedding_model: MODEL } } })
      }
      if (path.endsWith('/points/count')) return reply({ count: 3 })
      if (path.endsWith('/points/search')) {
        bodies.push({ path, body: JSON.parse(init!.body!) })
        return reply([])
      }
      if (path.endsWith('/points/scroll')) {
        bodies.push({ path, body: JSON.parse(init!.body!) })
        return reply({ points: [] })
      }
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
const ctx = (modeB = false) => createStorageContext(`world_only_${++n}`, modeB)

describe('storage filter', () => {
  it.each([false, true])('worldOnly adds an is_empty clause on subjects (mode B: %s)', async (modeB) => {
    const c = ctx(modeB)
    await c.queryByEmbedding([1, 0], 5, 'main', 0, { worldOnly: true })
    await c.listNotes('main', { worldOnly: true })

    expect(bodies.map((b) => b.path.split('/').pop())).toEqual(['search', 'scroll'])
    for (const { body } of bodies) expect(body.filter!.must).toContainEqual(WORLD)
  })

  it('a subject string still matches that subject or nobody', async () => {
    const c = ctx()
    await c.queryByEmbedding([1, 0], 5, 'main', 0, 'alex')

    expect(bodies[0].body.filter!.must).toContainEqual(SUBJECT)
  })

  it('adds no subject clause when no scope is given', async () => {
    const c = ctx()
    await c.queryByEmbedding([1, 0], 5, 'main', 0)
    await c.listNotes('main')

    for (const { body } of bodies) {
      const text = JSON.stringify(body.filter)
      expect(text).not.toContain('subjects')
    }
  })
})

describe('searchMemory', () => {
  it('scopes both retrieval paths with worldOnly', async () => {
    await searchMemory('mining', 5, 'main', { worldOnly: true, storageCtx: ctx() })

    expect(bodies).toHaveLength(2)
    for (const { body } of bodies) expect(body.filter!.must).toContainEqual(WORLD)
  })

  it('prefers an explicit subject over worldOnly', async () => {
    await searchMemory('mining', 5, 'main', { subject: 'alex', worldOnly: true, storageCtx: ctx() })

    expect(bodies).toHaveLength(2)
    for (const { body } of bodies) {
      expect(body.filter!.must).toContainEqual(SUBJECT)
      expect(body.filter!.must).not.toContainEqual(WORLD)
    }
  })

  it('does not scope without worldOnly or subject', async () => {
    await searchMemory('mining', 5, 'main', { storageCtx: ctx() })

    for (const { body } of bodies) expect(JSON.stringify(body.filter)).not.toContain('subjects')
  })
})

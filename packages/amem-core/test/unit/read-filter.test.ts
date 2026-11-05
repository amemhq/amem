/**
 * List and search reads filter by agent_id in the query, and also drop what canRead denies.
 * Every write keeps readers in step with agent_id, so the second check drops nothing today.
 * ClawHub's review of 2.1.8 probed a shared note with restricted readers, which no write
 * path produces. A shared note with no readers field predates the field and stays visible.
 * Synthetic points and a stubbed Qdrant only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/embedding.js')>()),
  getEmbeddingDim: vi.fn(async () => 2),
}))

import { createStorageContext } from '../../src/storage.js'

const MODEL = 'test/model'
type Point = { id: string; payload: Record<string, unknown>; vector: number[]; score?: number }

const point = (id: string, payload: Record<string, unknown>): Point => ({
  id,
  payload: { content: `synthetic ${id}`, hash: id, is_active: true, timestamp: '2026-11-05T00:00:00Z', ...payload },
  vector: [1, 0],
  score: 0.9,
})

// What the agent filter lets through for agentB: its own notes and shared ones.
const POINTS = [
  point('own', { agent_id: 'agentB', owner: 'agentB', readers: ['agentB'], writers: ['agentB'] }),
  point('open', { agent_id: 'shared', owner: 'agentA', readers: ['*'], writers: ['agentA'] }),
  point('restricted', { agent_id: 'shared', owner: 'agentA', readers: ['agentA'], writers: ['agentA'] }),
  point('legacy', { agent_id: 'shared' }),
]

let hashHit: Point | null = null

beforeEach(() => {
  hashHit = null
  vi.stubEnv('AMEM_EMBED_MODEL', MODEL)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const p = new URL(url).pathname
      const method = init?.method ?? 'GET'
      const ok = (result: unknown) => new Response(JSON.stringify({ status: 'ok', result }))
      if (method === 'GET' && /^\/collections\/[^/]+$/.test(p)) {
        return ok({ config: { params: { vectors: { size: 2 } }, metadata: { embedding_model: MODEL } } })
      }
      if (p.endsWith('/points/search')) return ok(POINTS)
      if (p.endsWith('/points/scroll')) return ok({ points: hashHit ? [hashHit] : POINTS })
      return ok({})
    })
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

let n = 0
const ctx = (modeB = false) => createStorageContext(`read_filter_${++n}`, modeB)
const ids = (notes: Array<{ id: string }>) => notes.map((x) => x.id).sort()

describe('list and search reads', () => {
  it('drop a shared note whose readers exclude the caller, and keep a legacy one', async () => {
    const c = ctx()
    expect(ids(await c.listNotes('agentB'))).toEqual(['legacy', 'open', 'own'])
    expect(ids((await c.queryByEmbedding([1, 0], 10, 'agentB')).map((r) => r.note))).toEqual(['legacy', 'open', 'own'])
    expect(ids(await c.getNotesByDatePrefix('2026-11-05', 'agentB'))).toEqual(['legacy', 'open', 'own'])
  })

  it('do not dedupe a write into a note the caller may not read', async () => {
    hashHit = POINTS.find((p) => p.id === 'restricted')!
    expect(await ctx().findByHash('restricted', 'agentB')).toBeNull()
    hashHit = POINTS.find((p) => p.id === 'open')!
    expect((await ctx().findByHash('open', 'agentB'))?.id).toBe('open')
  })

  it('keep everything for a whole-collection list and in a mode B collection', async () => {
    expect(await ctx().listNotes()).toHaveLength(4)
    expect(await ctx(true).listNotes('agentB')).toHaveLength(4)
  })
})

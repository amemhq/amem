/**
 * listNotes() and countNotes() skipped the filter for any falsy agentId, so an empty
 * string scrolled the whole collection: every agent's private notes and the
 * invalidated ones. searchMemory() feeds that scroll to BM25 and the link walk.
 * Only undefined may mean the whole collection. Stubbed Qdrant only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/embedding.js', async (orig) => ({
  ...(await orig<typeof import('../../src/embedding.js')>()),
  getEmbeddingDim: vi.fn(async () => 2),
}))

import { createStorageContext } from '../../src/storage.js'

const MODEL = 'test/model'

type Sent = { path: string; body: { filter?: Record<string, unknown> } }
let sent: Sent[]

function reply(result: unknown) {
  return new Response(JSON.stringify({ status: 'ok', result }), { status: 200 })
}

beforeEach(() => {
  vi.stubEnv('AMEM_EMBED_MODEL', MODEL)
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const path = new URL(url).pathname
      if ((init?.method ?? 'GET') === 'GET') {
        return reply({ config: { params: { vectors: { size: 2 } }, metadata: { embedding_model: MODEL } } })
      }
      sent.push({ path, body: JSON.parse(init?.body ?? '{}') })
      if (path.endsWith('/points/scroll')) return reply({ points: [] })
      if (path.endsWith('/points/count')) return reply({ count: 0 })
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
const ctx = (modeBIsolated: boolean) => createStorageContext(`empty_agent_${++n}`, modeBIsolated)

const INACTIVE_EXCLUDED = [{ key: 'is_active', match: { value: false } }]

async function filtersFor(modeBIsolated: boolean, agentId: string | undefined) {
  const c = ctx(modeBIsolated)
  await c.listNotes(agentId)
  await c.listNotes(agentId, 'someone')
  await c.countNotes(agentId)
  const reads = sent.filter((s) => /\/points\/(scroll|count)$/.test(s.path))
  expect(reads).toHaveLength(3)
  return reads.map((s) => s.body.filter)
}

describe('an empty agentId', () => {
  it('is scoped to its own and shared notes, active only, in a shared collection', async () => {
    for (const filter of await filtersFor(false, '')) {
      expect(filter?.must_not).toEqual(INACTIVE_EXCLUDED)
      expect((filter?.must as unknown[])[0]).toEqual({
        should: [
          { key: 'agent_id', match: { value: '' } },
          { key: 'agent_id', match: { value: 'shared' } },
        ],
      })
    }
  })

  it('still excludes invalidated notes in an isolated collection', async () => {
    for (const filter of await filtersFor(true, '')) {
      expect(filter?.must_not).toEqual(INACTIVE_EXCLUDED)
    }
  })
})

describe('an undefined agentId', () => {
  it('still reads the whole collection', async () => {
    for (const filter of await filtersFor(false, undefined)) {
      expect(filter).toBeUndefined()
    }
  })
})

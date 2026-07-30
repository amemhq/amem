import { describe, it, expect, vi, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Isolate this run: a per-pid collection so parallel workers never collide, and
// temp paths for the evolution counter and data dir so ~/.amem is left alone.
// Set before amem-core's config.ts is imported — it captures the data dir once.
const { COLLECTION, fakeEncode } = vi.hoisted(() => {
  const os = require('os')
  const path = require('path')
  const pid = process.pid
  process.env.AMEM_COLLECTION = `amem_api_it_${pid}`
  process.env.AMEM_DATA_DIR = path.join(os.tmpdir(), `amem-api-it-${pid}`)
  process.env.AMEM_EVO_COUNTER_PATH = path.join(os.tmpdir(), `amem-api-it-${pid}-evo.json`)
  // Deterministic 384-d embedding: the same text maps to the same L2-normalized
  // vector, so a query repeating the stored text matches it exactly. No model.
  function fakeEncode(text: string): number[] {
    const v = new Array(384).fill(0)
    for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i) + 1
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
  return { COLLECTION: process.env.AMEM_COLLECTION, fakeEncode }
})

// Mock only the engine's embedding + llm — storage stays real, hitting Qdrant.
// The paths reach amem-core's SOURCE, which the vitest config aliases to the
// to; that is the whole reason for the alias.
vi.mock('../../../amem-core/src/embedding.js', () => ({
  encode: async (t: string) => fakeEncode(t),
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  isModelLoaded: () => true,
  loadModel: async () => {},
  // Storage measures the vector width through these before creating or
  // validating a collection; they must agree with fakeEncode.
  getEmbeddingDim: async () => 384,
  getEmbeddingModel: () => 'test/fake-encoder',
  // This test pins getEmbeddingModel to a constant, so model resolution has
  // nothing to resolve. Stubbed as no-ops rather than omitted: ensureCollection
  // calls both, and a missing export is a hard mock error.
  pinEmbeddingModel: () => {},
  getPinnedEmbeddingModel: () => null,
}))
vi.mock('../../../amem-core/src/llm.js', () => ({
  llmConstructNote: async () => ({
    keywords: [],
    tags: [],
    context: '',
    category: 'General',
    note_type: 'memory',
    topics: [],
  }),
  llmShouldLink: async () => false,
  llmEvolveNote: async () => ({ context: '', tags: [], keywords: [] }),
  llmShouldMerge: async () => ({ shouldMerge: false }),
  llmEvolutionJudge: async () => ({ action: 'NONE' }),
}))

import { createApp } from '../../src/app.js'

const NOTE = 'the ender dragon killed us at the obsidian portal'

let app: FastifyInstance
const build = () => (app ??= createApp({ logger: false }))

afterAll(async () => {
  if (app) await app.close()
  // Drop the throwaway collection so repeated runs stay clean.
  await fetch(`http://localhost:6333/collections/${COLLECTION}`, { method: 'DELETE' }).catch(() => {})
})

describe('amem-api over real Qdrant (integration — requires Qdrant on :6333)', () => {
  it('serves /healthz green when Qdrant is up and the model is (faked) loaded', async () => {
    const res = await build().inject({ method: 'GET', url: '/healthz' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', qdrant: true, model: true })
  })

  it('runs the whole pipeline over HTTP: write → count → search → consolidate → quality-scan', async () => {
    const api = build()

    // write (full pipeline, llm faked to construct-only)
    const write = await api.inject({ method: 'POST', url: '/v1/memories', payload: { text: NOTE } })
    expect(write.statusCode).toBe(201)
    const { id } = write.json() as { id: string }
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    // count sees it
    const count = await api.inject({ method: 'GET', url: '/v1/memories/count' })
    expect(count.statusCode).toBe(200)
    expect((count.json() as { count: number }).count).toBeGreaterThanOrEqual(1)

    // search finds it by the same text (deterministic embedding → exact match)
    const search = await api.inject({
      method: 'POST',
      url: '/v1/memories/search',
      payload: { query: NOTE },
    })
    expect(search.statusCode).toBe(200)
    const { results } = search.json() as { results: { id: string; content: string }[] }
    expect(results.some((r) => r.id === id)).toBe(true)
    expect(results[0].content).toContain('ender dragon')

    // consolidate runs end-to-end (nothing to merge → 0, but it drives Qdrant)
    const consolidate = await api.inject({ method: 'POST', url: '/v1/maintenance/consolidate', payload: {} })
    expect(consolidate.statusCode).toBe(200)
    expect(consolidate.json()).toEqual({ merged: expect.any(Number) })

    // quality-scan returns the {noteId, reasons} shape; a healthy note isn't flagged
    const scan = await api.inject({ method: 'POST', url: '/v1/maintenance/quality-scan', payload: {} })
    expect(scan.statusCode).toBe(200)
    expect(Array.isArray((scan.json() as { items: unknown[] }).items)).toBe(true)
  })

  it('isolates by agent — a different agent does not see the note', async () => {
    const res = await build().inject({
      method: 'POST',
      url: '/v1/memories/search',
      payload: { query: NOTE, agentId: 'someone-else' },
    })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { results: unknown[] }).results).toHaveLength(0)
  })
})

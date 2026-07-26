import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'

const core = vi.hoisted(() => ({
  pingQdrant: vi.fn(),
  isModelLoaded: vi.fn(),
  addMemory: vi.fn(),
  addEpisodic: vi.fn(),
  searchMemory: vi.fn(),
  listMemories: vi.fn(),
  consolidateMemories: vi.fn(),
  scanLowQuality: vi.fn(),
}))

vi.mock('@amemhq/core', () => core)

import { createApp } from '../../src/app.js'

let app: FastifyInstance

beforeEach(() => {
  vi.clearAllMocks()
  app = createApp({ logger: false })
})
afterEach(() => app.close())

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload })

const TEXT = 'the ender dragon killed us at the portal'
const QUALITY_ERROR = new Error('[quality] 写入拒绝: 内容过短')
const QDRANT_ERROR = new Error('Qdrant POST /collections/amem_notes/points failed: timeout')
const UNREACHABLE = new TypeError('fetch failed')

describe('POST /v1/memories', () => {
  it('rejects a missing text field before touching the engine', async () => {
    const res = await post('/v1/memories', {})

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' })
    expect(core.addMemory).not.toHaveBeenCalled()
  })

  it('rejects an empty text at the schema, not at the quality gate', async () => {
    const res = await post('/v1/memories', { text: '' })

    expect(res.statusCode).toBe(400)
    expect(core.addMemory).not.toHaveBeenCalled()
  })

  it('rejects an unknown field rather than silently dropping it', async () => {
    const res = await post('/v1/memories', { text: TEXT, embedding: [1, 2, 3] })

    expect(res.statusCode).toBe(400)
    expect(core.addMemory).not.toHaveBeenCalled()
  })

  it('rejects a scope outside the two the engine understands', async () => {
    const res = await post('/v1/memories', { text: TEXT, scope: 'public' })

    expect(res.statusCode).toBe(400)
    expect(core.addMemory).not.toHaveBeenCalled()
  })

  it('turns a quality-gate rejection into 422 and tells the caller why', async () => {
    core.addMemory.mockRejectedValue(QUALITY_ERROR)

    const res = await post('/v1/memories', { text: 'short' })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      statusCode: 422,
      error: 'Unprocessable Entity',
      detail: '[quality] 写入拒绝: 内容过短',
    })
  })

  it('turns a Qdrant failure into 503 and leaks nothing about it', async () => {
    core.addMemory.mockRejectedValue(QDRANT_ERROR)

    const res = await post('/v1/memories', { text: TEXT })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ statusCode: 503, error: 'Service Unavailable' })
  })

  it('treats an unreachable Qdrant as 503, not as a bug', async () => {
    core.addMemory.mockRejectedValue(UNREACHABLE)

    const res = await post('/v1/memories', { text: TEXT })

    expect(res.statusCode).toBe(503)
  })

  it('treats anything else as 500 and keeps the message internal', async () => {
    core.addMemory.mockRejectedValue(new Error('collection amem_notes has 0 shards'))

    const res = await post('/v1/memories', { text: TEXT })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
  })

  it('answers 201 with the new note id', async () => {
    core.addMemory.mockResolvedValue('note-1')

    const res = await post('/v1/memories', { text: TEXT })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ id: 'note-1' })
  })

  it('defaults to the "main" agent and a private scope', async () => {
    core.addMemory.mockResolvedValue('note-1')

    await post('/v1/memories', { text: TEXT })

    expect(core.addMemory).toHaveBeenCalledWith(TEXT, 'main', { scope: 'private' })
  })

  it('passes an explicit agent and scope through to the engine', async () => {
    core.addMemory.mockResolvedValue('note-1')

    await post('/v1/memories', { text: TEXT, agentId: 'game', scope: 'shared' })

    expect(core.addMemory).toHaveBeenCalledWith(TEXT, 'game', { scope: 'shared' })
  })
})

describe('POST /v1/memories/episodic', () => {
  it('answers 201 and takes the cheap path, never the full pipeline', async () => {
    core.addEpisodic.mockResolvedValue('event-1')

    const res = await post('/v1/memories/episodic', { text: TEXT })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ id: 'event-1' })
    expect(core.addEpisodic).toHaveBeenCalledWith(TEXT, 'main', { scope: 'private' })
    expect(core.addMemory).not.toHaveBeenCalled()
  })

  it('is guarded by the same quality gate', async () => {
    core.addEpisodic.mockRejectedValue(QUALITY_ERROR)

    const res = await post('/v1/memories/episodic', { text: 'no' })

    expect(res.statusCode).toBe(422)
  })
})

describe('POST /v1/memories/search', () => {
  it('rejects a missing query', async () => {
    const res = await post('/v1/memories/search', {})

    expect(res.statusCode).toBe(400)
    expect(core.searchMemory).not.toHaveBeenCalled()
  })

  it('rejects a limit below one', async () => {
    const res = await post('/v1/memories/search', { query: 'dragon', limit: 0 })

    expect(res.statusCode).toBe(400)
    expect(core.searchMemory).not.toHaveBeenCalled()
  })

  it('returns the engine hits under a results key', async () => {
    const hit = { id: 'note-1', content: TEXT, similarity: 0.9, rrf: 1.2 }
    core.searchMemory.mockResolvedValue([hit])

    const res = await post('/v1/memories/search', { query: 'dragon' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ results: [hit] })
  })

  it('defaults to five hits for the "main" agent', async () => {
    core.searchMemory.mockResolvedValue([])

    await post('/v1/memories/search', { query: 'dragon' })

    expect(core.searchMemory).toHaveBeenCalledWith('dragon', 5, 'main', { topicsFilter: undefined })
  })

  it('passes the limit, agent and topic filter through', async () => {
    core.searchMemory.mockResolvedValue([])

    await post('/v1/memories/search', {
      query: 'dragon',
      limit: 10,
      agentId: 'game',
      topicsFilter: ['combat'],
    })

    expect(core.searchMemory).toHaveBeenCalledWith('dragon', 10, 'game', {
      topicsFilter: ['combat'],
    })
  })
})

describe('GET /v1/memories/count', () => {
  it('returns the engine count verbatim', async () => {
    core.listMemories.mockResolvedValue({ count: 42 })

    const res = await app.inject({ method: 'GET', url: '/v1/memories/count' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 42 })
    expect(core.listMemories).toHaveBeenCalledWith('main')
  })

  it('counts a named agent from the query string', async () => {
    core.listMemories.mockResolvedValue({ count: 3 })

    await app.inject({ method: 'GET', url: '/v1/memories/count?agentId=game' })

    expect(core.listMemories).toHaveBeenCalledWith('game')
  })

  it('is 503 when Qdrant is down', async () => {
    core.listMemories.mockRejectedValue(UNREACHABLE)

    const res = await app.inject({ method: 'GET', url: '/v1/memories/count' })

    expect(res.statusCode).toBe(503)
  })
})

describe('POST /v1/maintenance/consolidate', () => {
  it('returns how many notes were merged', async () => {
    core.consolidateMemories.mockResolvedValue(3)

    const res = await post('/v1/maintenance/consolidate', {})

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ merged: 3 })
  })

  it('hands the engine this request’s logger, so its progress is traceable', async () => {
    core.consolidateMemories.mockResolvedValue(0)

    await post('/v1/maintenance/consolidate', { agentId: 'game' })

    expect(core.consolidateMemories).toHaveBeenCalledWith(
      'game',
      expect.objectContaining({
        info: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
      })
    )
  })

  it('defaults to the "main" agent, which the engine does not do for us', async () => {
    core.consolidateMemories.mockResolvedValue(0)

    await post('/v1/maintenance/consolidate', {})

    expect(core.consolidateMemories).toHaveBeenCalledWith('main', expect.anything())
  })

  it('still wants a body, even though every field in it is optional', async () => {
    const res = await post('/v1/maintenance/consolidate')

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      detail: 'body must be object',
    })
    expect(core.consolidateMemories).not.toHaveBeenCalled()
  })
})

describe('POST /v1/maintenance/quality-scan', () => {
  it('reports which notes are suspect without handing over the notes', async () => {
    core.scanLowQuality.mockResolvedValue([
      {
        note: {
          id: 'note-1',
          content: TEXT,
          embedding: [0.1, 0.2],
          evolution_history: ['x'],
          readers: ['*'],
        },
        reasons: ['too_short'],
      },
    ])

    const res = await post('/v1/maintenance/quality-scan', {})

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [{ noteId: 'note-1', reasons: ['too_short'] }] })
  })

  it('returns an empty list when nothing is flagged', async () => {
    core.scanLowQuality.mockResolvedValue([])

    const res = await post('/v1/maintenance/quality-scan', {})

    expect(res.json()).toEqual({ items: [] })
    expect(core.scanLowQuality).toHaveBeenCalledWith('main')
  })
})

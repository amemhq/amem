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

const healthz = () => app.inject({ method: 'GET', url: '/healthz' })

describe('GET /healthz', () => {
  it('is 200 ok only when Qdrant answers and the model is resident', async () => {
    core.pingQdrant.mockResolvedValue(undefined)
    core.isModelLoaded.mockReturnValue(true)

    const res = await healthz()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', qdrant: true, model: true })
  })

  it('is 503 when Qdrant is not listening at all', async () => {
    // What undici throws on ECONNREFUSED, before any HTTP response exists.
    core.pingQdrant.mockRejectedValue(new TypeError('fetch failed'))
    core.isModelLoaded.mockReturnValue(true)

    const res = await healthz()

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'degraded', qdrant: false, model: true })
  })

  it('is 503 when Qdrant answers but is not ready', async () => {
    core.pingQdrant.mockRejectedValue(new Error('Qdrant GET /readyz failed: 503'))
    core.isModelLoaded.mockReturnValue(true)

    const res = await healthz()

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'degraded', qdrant: false, model: true })
  })

  it('is 503 when the model has not loaded, even with Qdrant up', async () => {
    core.pingQdrant.mockResolvedValue(undefined)
    core.isModelLoaded.mockReturnValue(false)

    const res = await healthz()

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'degraded', qdrant: true, model: false })
  })

  it('re-checks Qdrant on every call instead of latching the first answer', async () => {
    core.isModelLoaded.mockReturnValue(true)
    core.pingQdrant
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TypeError('fetch failed'))

    expect((await healthz()).statusCode).toBe(200)
    expect((await healthz()).statusCode).toBe(503)
    expect(core.pingQdrant).toHaveBeenCalledTimes(2)
  })

  it('answers in its own shape when degraded, not the error envelope', async () => {
    core.pingQdrant.mockRejectedValue(new TypeError('fetch failed'))
    core.isModelLoaded.mockReturnValue(false)

    const body = (await healthz()).json()

    expect(body).not.toHaveProperty('error')
    expect(body).not.toHaveProperty('detail')
  })

  it('404s an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
  })
})

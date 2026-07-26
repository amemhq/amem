import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { assertBindable, isLoopback } from '../../src/net.js'

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

const TOKEN = 's3cret-token'

describe('assertBindable (startup guard)', () => {
  it('refuses a non-loopback host with no token', () => {
    expect(() => assertBindable('0.0.0.0', undefined)).toThrow(/AMEM_API_TOKEN/)
    expect(() => assertBindable('192.168.1.5', '')).toThrow(/AMEM_API_TOKEN/)
  })

  it('allows a non-loopback host once a token is set', () => {
    expect(() => assertBindable('0.0.0.0', TOKEN)).not.toThrow()
  })

  it('allows loopback with or without a token', () => {
    expect(() => assertBindable('127.0.0.1', undefined)).not.toThrow()
    expect(() => assertBindable('localhost', undefined)).not.toThrow()
    expect(() => assertBindable('::1', undefined)).not.toThrow()
  })

  it('treats 0.0.0.0 and :: as public, not loopback', () => {
    // The bug this prevents: mistaking "bind every interface" for "bind local".
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback('::')).toBe(false)
    expect(isLoopback('127.0.0.1')).toBe(true)
  })
})

describe('bearer auth', () => {
  let app: FastifyInstance

  afterEach(async () => {
    if (app) await app.close()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  const build = () => {
    app = createApp({ logger: false })
    return app
  }
  const get = (url: string, token?: string) =>
    build().inject({
      method: 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })

  it('is open when no token is configured', async () => {
    core.listMemories.mockResolvedValue({ count: 0 })

    const res = await get('/v1/memories/count') // no auth header

    expect(res.statusCode).toBe(200)
  })

  describe('with AMEM_API_TOKEN set', () => {
    beforeEach(() => vi.stubEnv('AMEM_API_TOKEN', TOKEN))

    it('rejects a request with no Authorization header', async () => {
      const res = await get('/v1/memories/count')

      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ statusCode: 401, error: 'Unauthorized' })
      expect(core.listMemories).not.toHaveBeenCalled()
    })

    it('rejects a wrong bearer token', async () => {
      const res = await get('/v1/memories/count', 'wrong-token')

      expect(res.statusCode).toBe(401)
      expect(core.listMemories).not.toHaveBeenCalled()
    })

    it('rejects a non-bearer Authorization scheme', async () => {
      const res = await build().inject({
        method: 'GET',
        url: '/v1/memories/count',
        headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` },
      })

      expect(res.statusCode).toBe(401)
    })

    it('accepts the correct bearer token', async () => {
      core.listMemories.mockResolvedValue({ count: 7 })

      const res = await get('/v1/memories/count', TOKEN)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ count: 7 })
    })

    it('guards writes too, before the engine is touched', async () => {
      const res = await build().inject({
        method: 'POST',
        url: '/v1/memories',
        payload: { text: 'the ender dragon killed us at the portal' },
      })

      expect(res.statusCode).toBe(401)
      expect(core.addMemory).not.toHaveBeenCalled()
    })

    it('leaves /healthz open, so probes work without the token', async () => {
      core.pingQdrant.mockResolvedValue(undefined)
      core.isModelLoaded.mockReturnValue(true)

      const res = await get('/healthz') // no auth header

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'ok' })
    })
  })
})

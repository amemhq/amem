import { describe, it, expect, vi, afterEach } from 'vitest'

// OpenClaw runs register() far more often than it starts the service: in CLI commands, in a
// cli-metadata mode where api.runtime throws, and in the gateway's model-catalog worker
// threads, which never exit and each have their own globalThis. A timer or a model load in
// register() ran there too: on 2.1.3 the 02:30 job ran twice in one gateway.

const { ensureCollection } = vi.hoisted(() => ({ ensureCollection: vi.fn(async () => {}) }))
// The plugin bundles the engine through a tsup alias, so there is no package to resolve.
vi.mock('@amemhq/core', async () => ({
  ...(await import('../../../amem-core/src/index.js')),
  ensureCollection,
}))

// Not installed here: the plugin is built against the host's copy.
vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({ definePluginEntry: (entry: unknown) => entry }))

import { register } from '../../src/index.js'
import { cancelNightly, unwatchAgentEvents } from '../../src/nightly.js'

const TIMER = Symbol.for('openclaw-amem.nightly-timer')
const timer = () => (globalThis as Record<symbol, unknown>)[TIMER]

type Service = { start: () => void; stop: () => void }

function fakeApi(runtime: unknown) {
  const services: Service[] = []
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: {},
    on: vi.fn(),
    registerTool: vi.fn(),
    registerService: (svc: Service) => services.push(svc),
    runtime,
  }
  return { api, services }
}

// What api.runtime is in cli-metadata registration: any property read throws.
const unavailable = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined
      throw new Error('runtime is intentionally unavailable during "cli-metadata" registration')
    },
  }
)

afterEach(() => {
  cancelNightly()
  unwatchAgentEvents()
  ensureCollection.mockClear()
})

describe('register() and the service', () => {
  it('register() schedules nothing, loads nothing and does not read api.runtime', () => {
    const { api } = fakeApi(unavailable)

    expect(() => register(api as never)).not.toThrow()

    expect(ensureCollection).not.toHaveBeenCalled()
    expect(timer()).toBeUndefined()
  })

  it('start() schedules the nightly job, subscribes to runs and checks the collection; stop() undoes it', () => {
    const unsubscribe = vi.fn()
    const onAgentEvent = vi.fn(() => unsubscribe)
    const { api, services } = fakeApi({ events: { onAgentEvent } })
    register(api as never)

    services[0].start()
    expect(timer()).toBeDefined()
    expect(onAgentEvent).toHaveBeenCalledTimes(1)
    expect(ensureCollection).toHaveBeenCalledTimes(1)

    services[0].stop()
    expect(timer()).toBeUndefined()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

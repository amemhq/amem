import { describe, it, expect, vi, beforeEach } from 'vitest'

// In a group session a search with no subject reads only notes about nobody. Cron, heartbeat, CLI
// and direct chats are unchanged. Synthetic data only.

const { searchMemory, addMemory, llmCrudDecision, storageCtx } = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  addMemory: vi.fn(),
  llmCrudDecision: vi.fn(),
  storageCtx: { getNote: vi.fn(), updateNoteContent: vi.fn(), invalidateNote: vi.fn() },
}))
vi.mock('@amemhq/core', async () => ({
  ...(await import('../../../amem-core/src/index.js')),
  searchMemory,
  addMemory,
  llmCrudDecision,
  createStorageContext: () => storageCtx,
}))
vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({ definePluginEntry: (entry: unknown) => entry }))

import { register } from '../../src/index.js'
import { cancelNightly, unwatchAgentEvents } from '../../src/nightly.js'

type Hook = (event: unknown, ctx?: unknown) => Promise<void>
type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
type Manager = { search: (query: string, opts?: { limit?: number }) => Promise<unknown> }
type Capability = { runtime: { getMemorySearchManager: (ctx: unknown) => Promise<{ manager: Manager }> } }

function setup() {
  const hooks: Record<string, Hook> = {}
  const factories: Record<string, (ctx: unknown) => Tool> = {}
  let capability: Capability | undefined
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: {},
    on: (name: string, fn: Hook) => {
      hooks[name] = fn
    },
    registerTool: (factory: (ctx: unknown) => Tool) => {
      factories[(factory(undefined) as unknown as { name: string }).name] = factory
    },
    registerMemoryCapability: (cap: Capability) => {
      capability = cap
    },
    registerService: () => {},
  }
  register(api as never)
  return {
    hooks,
    tool: (name: string, ctx?: unknown) => factories[name](ctx),
    manager: async (ctx: unknown) => (await capability!.runtime.getMemorySearchManager(ctx)).manager,
  }
}

const group = { agentId: 'main', channel: 'discord', senderId: 'u1', sessionKey: 'agent:main:discord:group:7' }
const room = { agentId: 'main', sessionKey: 'agent:main:slack:channel:C1' }
const dm = { agentId: 'main', channel: 'discord', senderId: 'u1', sessionKey: 'agent:main:main' }
const cron = { agentId: 'main', sessionKey: 'agent:main:cron:1' }
const event = {
  success: true,
  messages: [
    { role: 'user', content: 'I always play on the hard difficulty setting' },
    { role: 'assistant', content: 'Noted.' },
  ],
}

beforeEach(() => {
  cancelNightly()
  unwatchAgentEvents()
  for (const f of [searchMemory, addMemory, llmCrudDecision]) f.mockReset()
  for (const f of Object.values(storageCtx)) f.mockReset()
  searchMemory.mockResolvedValue([])
  llmCrudDecision.mockResolvedValue([])
})

describe('memory_search tool', () => {
  it('searches only notes about nobody in a group or a room', async () => {
    const { tool } = setup()
    await tool('memory_search', group).execute('c', { query: 'q' })
    await tool('memory_search', room).execute('c', { query: 'q' })

    expect(searchMemory.mock.calls[0][3]).toMatchObject({ worldOnly: true })
    expect(searchMemory.mock.calls[0][3].subject).toBeUndefined()
    expect(searchMemory.mock.calls[1][3]).toMatchObject({ worldOnly: true })
  })

  it('leaves an explicit subject in place, for the engine to prefer', async () => {
    await setup().tool('memory_search', group).execute('c', { query: 'q', subject: 'someone' })

    expect(searchMemory.mock.calls[0][3]).toMatchObject({ subject: 'someone' })
  })

  it('does not restrict cron, heartbeat, CLI or a direct chat', async () => {
    const { tool } = setup()
    for (const ctx of [cron, dm, { agentId: 'main' }, undefined]) {
      await tool('memory_search', ctx).execute('c', { query: 'q' })
    }

    for (const call of searchMemory.mock.calls) expect(call[3].worldOnly).toBe(false)
  })
})

describe('memory capability manager', () => {
  it('searches only notes about nobody when the host passes a group session key', async () => {
    const m = await (await setup()).manager(group)
    await m.search('q')

    expect(searchMemory.mock.calls[0][3]).toMatchObject({ worldOnly: true })
  })

  it('searches everything without a session key or in a non-group session', async () => {
    const s = setup()
    await (await s.manager({ agentId: 'main' })).search('q')
    await (await s.manager(cron)).search('q')
    await (await s.manager(dm)).search('q')

    for (const call of searchMemory.mock.calls) expect(call[3].worldOnly).toBe(false)
  })
})

describe('agent_end candidate search', () => {
  it('asks for notes about nobody in a group, and not otherwise', async () => {
    const { hooks } = setup()
    await hooks.agent_end(event, group)
    await hooks.agent_end(event, cron)

    expect(searchMemory.mock.calls[0][3]).toMatchObject({ worldOnly: true })
    expect(searchMemory.mock.calls[1][3].worldOnly).toBe(false)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The gateway identity bounds the subject the model may pass to memory_search and memory_add.
// Direct chat: the speaker only. Group: nobody. No sender: the model's choice. Synthetic data only.

const { searchMemory, addMemory, storageCtx } = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  addMemory: vi.fn(),
  storageCtx: {},
}))
vi.mock('@amemhq/core', async () => ({
  ...(await import('../../../amem-core/src/index.js')),
  searchMemory,
  addMemory,
  createStorageContext: () => storageCtx,
}))
vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({ definePluginEntry: (entry: unknown) => entry }))

import { register } from '../../src/index.js'
import { cancelNightly, unwatchAgentEvents } from '../../src/nightly.js'

type Result = { content: { text: string }[]; details: { error?: string; ok?: boolean } }
type Tool = { description: string; execute: (id: string, params: Record<string, unknown>) => Promise<Result> }

function setup(config?: unknown) {
  const factories: Record<string, (ctx: unknown) => Tool> = {}
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: {},
    config,
    on: () => {},
    registerTool: (factory: (ctx: unknown) => Tool) => {
      factories[(factory(undefined) as unknown as { name: string }).name] = factory
    },
    registerService: () => {},
  }
  register(api as never)
  return (name: string, ctx?: unknown) => factories[name](ctx)
}

const dm = { agentId: 'main', channel: 'discord', senderId: 'U1', sessionKey: 'agent:main:main' }
const group = { agentId: 'main', channel: 'discord', senderId: 'U1', sessionKey: 'agent:main:discord:group:7' }
const cron = { agentId: 'main', sessionKey: 'agent:main:cron:1' }
const KEY = 'discord:U1'

beforeEach(() => {
  cancelNightly()
  unwatchAgentEvents()
  searchMemory.mockReset()
  addMemory.mockReset()
  searchMemory.mockResolvedValue([])
  addMemory.mockResolvedValue('id1')
})

describe('memory_search in a direct chat', () => {
  it('refuses another subject, names the speaker, and does not search', async () => {
    const r = await setup()('memory_search', dm).execute('c', { query: 'q', subject: 'discord:other' })

    expect(searchMemory).not.toHaveBeenCalled()
    expect(r.details.error).toContain(KEY)
    expect(r.content[0].text).toContain(KEY)
    expect(r.content[0].text).toContain('Omit subject')
  })

  it('accepts the speaker key ignoring case and spaces, and searches as the exact key', async () => {
    await setup()('memory_search', dm).execute('c', { query: 'q', subject: '  DISCORD:u1 ' })

    expect(searchMemory.mock.calls[0][3].subject).toBe(KEY)
  })

  it('treats a blank subject as omitted', async () => {
    const r = await setup()('memory_search', dm).execute('c', { query: 'q', subject: '   ' })

    expect(r.details.error).toBeUndefined()
    expect(searchMemory.mock.calls[0][3].subject).toBe(KEY)
  })

  it('compares the identity key, not the channel id', async () => {
    const tool = setup({ session: { identityLinks: { Alice: ['discord:U1'] } } })
    await tool('memory_search', dm).execute('c', { query: 'q', subject: 'identity:alice' })
    const r = await tool('memory_search', dm).execute('c', { query: 'q', subject: KEY })

    expect(searchMemory).toHaveBeenCalledTimes(1)
    expect(searchMemory.mock.calls[0][3].subject).toBe('identity:alice')
    expect(r.details.error).toContain('identity:alice')
  })

  it('states the rule in the description', () => {
    expect(setup()('memory_search', dm).description).toContain(`only search memories about "${KEY}" or about nobody`)
  })
})

describe('memory_search in a group', () => {
  it('refuses any non-blank subject and does not search', async () => {
    const tool = setup()('memory_search', group)
    const r = await tool.execute('c', { query: 'q', subject: KEY })

    expect(searchMemory).not.toHaveBeenCalled()
    expect(r.details.error).toContain('group chat')
  })

  it('searches notes about nobody when the subject is blank or omitted', async () => {
    const tool = setup()('memory_search', group)
    await tool.execute('c', { query: 'q', subject: ' ' })
    await tool.execute('c', { query: 'q' })

    for (const call of searchMemory.mock.calls) {
      expect(call[3].worldOnly).toBe(true)
      expect(call[3].subject).toBeUndefined()
    }
    expect(searchMemory).toHaveBeenCalledTimes(2)
  })

  it('states the rule in the description', () => {
    expect(setup()('memory_search', group).description).toContain('group chat')
  })
})

describe('memory_search with no sender', () => {
  it('honours the model subject', async () => {
    await setup()('memory_search', cron).execute('c', { query: 'q', subject: 'someone' })

    expect(searchMemory.mock.calls[0][3]).toMatchObject({ subject: 'someone', worldOnly: false })
  })

  it('passes a padded or blank subject through unchanged', async () => {
    const tool = setup()('memory_search', cron)
    await tool.execute('c', { query: 'q', subject: ' bob ' })
    await tool.execute('c', { query: 'q', subject: '   ' })

    expect(searchMemory.mock.calls[0][3].subject).toBe(' bob ')
    expect(searchMemory.mock.calls[1][3].subject).toBe('   ')
  })
})

describe('memory_add in a direct chat', () => {
  it('refuses a subject list that names someone else, and saves nothing', async () => {
    const r = await setup()('memory_add', dm).execute('c', { text: 't', subjects: [KEY, 'discord:other'] })

    expect(addMemory).not.toHaveBeenCalled()
    expect(r.details).toMatchObject({ ok: false })
    expect(r.details.error).toContain(KEY)
  })

  it('normalises the speaker key and dedupes', async () => {
    await setup()('memory_add', dm).execute('c', { text: 't', subjects: ['discord:u1', ' DISCORD:U1'] })

    expect(addMemory.mock.calls[0][2].subjects).toEqual([KEY])
  })

  it('saves with no subjects for empty, blank or omitted', async () => {
    const tool = setup()('memory_add', dm)
    await tool.execute('c', { text: 't', subjects: [] })
    await tool.execute('c', { text: 't', subjects: ['  '] })
    await tool.execute('c', { text: 't' })

    expect(addMemory).toHaveBeenCalledTimes(3)
    for (const call of addMemory.mock.calls) expect(call[2].subjects).toBeUndefined()
  })
})

describe('memory_add in a group', () => {
  it('refuses subjects and saves nothing', async () => {
    const r = await setup()('memory_add', group).execute('c', { text: 't', subjects: [KEY] })

    expect(addMemory).not.toHaveBeenCalled()
    expect(r.details).toMatchObject({ ok: false })
    expect(r.details.error).toContain('group chat')
  })

  it('saves text with no subjects', async () => {
    await setup()('memory_add', group).execute('c', { text: 't' })

    expect(addMemory.mock.calls[0][2].subjects).toBeUndefined()
  })
})

describe('malformed subject arguments', () => {
  it('memory_search in a direct chat refuses a non-string subject without throwing', async () => {
    const r = await setup()('memory_search', dm).execute('c', { query: 'q', subject: 5 as never })

    expect(searchMemory).not.toHaveBeenCalled()
    expect(r.details.error).toContain(KEY)
  })

  it('memory_add in a direct chat refuses a string subjects value without throwing', async () => {
    const r = await setup()('memory_add', dm).execute('c', { text: 't', subjects: 'discord:other' as never })

    expect(addMemory).not.toHaveBeenCalled()
    expect(r.details).toMatchObject({ ok: false })
  })
})

describe('memory_add with no sender', () => {
  it('honours the model subjects', async () => {
    await setup()('memory_add', cron).execute('c', { text: 't', subjects: ['someone', 'else'] })

    expect(addMemory.mock.calls[0][2].subjects).toEqual(['someone', 'else'])
  })
})

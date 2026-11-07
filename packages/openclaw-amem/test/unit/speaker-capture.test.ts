import { describe, it, expect, vi, beforeEach } from 'vitest'

// The speaker key decides what agent_end tags, how it searches for candidates, and what
// memory_search defaults to. Synthetic data only.

const { searchMemory, addMemory, llmCrudDecision, encode, storageCtx } = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  addMemory: vi.fn(),
  llmCrudDecision: vi.fn(),
  encode: vi.fn(),
  storageCtx: {
    getNote: vi.fn(),
    updateNoteContent: vi.fn(),
    invalidateNote: vi.fn(),
  },
}))
vi.mock('@amemhq/core', async () => ({
  ...(await import('../../../amem-core/src/index.js')),
  searchMemory,
  addMemory,
  llmCrudDecision,
  encode,
  createStorageContext: () => storageCtx,
}))
vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({ definePluginEntry: (entry: unknown) => entry }))

import { register } from '../../src/index.js'
import { cancelNightly, unwatchAgentEvents } from '../../src/nightly.js'

type Hook = (event: unknown, ctx?: unknown) => Promise<void>
type Tool = { description: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }

function setup() {
  return setupWith(undefined)
}

function setupWith(config: unknown) {
  const hooks: Record<string, Hook> = {}
  const factories: Record<string, (ctx: unknown) => Tool> = {}
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: {},
    config,
    on: (name: string, fn: Hook) => {
      hooks[name] = fn
    },
    registerTool: (factory: (ctx: unknown) => Tool) => {
      // The tool's name is only known from what the factory returns.
      factories[(factory(undefined) as unknown as { name: string }).name] = factory
    },
    registerService: () => {},
  }
  register(api as never)
  return { hooks, tool: (name: string, ctx?: unknown) => factories[name](ctx) }
}

const event = {
  success: true,
  messages: [
    { role: 'user', content: 'I always play on the hard difficulty setting' },
    { role: 'assistant', content: 'Noted.' },
  ],
}
const dm = { agentId: 'main', channel: 'discord', senderId: 'u1', sessionKey: 'agent:main:main' }

beforeEach(() => {
  cancelNightly()
  unwatchAgentEvents()
  for (const f of [searchMemory, addMemory, llmCrudDecision, encode]) f.mockReset()
  for (const f of Object.values(storageCtx)) f.mockReset()
  storageCtx.getNote.mockResolvedValue({ embedding: [1, 0], subjects: [] })
  searchMemory.mockResolvedValue([])
  addMemory.mockResolvedValue('id1')
})

describe('agent_end capture', () => {
  it('tags speaker facts, leaves world facts untagged, and scopes the candidate search', async () => {
    llmCrudDecision.mockResolvedValue([
      { action: 'NEW', fact: 'plays on hard', aboutSpeaker: true },
      { action: 'NEW', fact: 'hard mode doubles damage', aboutSpeaker: false },
    ])
    await setup().hooks.agent_end(event, dm)

    expect(searchMemory.mock.calls[0][3]).toMatchObject({ subject: 'discord:u1' })
    expect(llmCrudDecision.mock.calls[0][3]).toMatchObject({ speaker: true })
    expect(addMemory.mock.calls[0][2].subjects).toEqual(['discord:u1'])
    expect(addMemory.mock.calls[1][2].subjects).toBeUndefined()
  })

  it('does not tag or scope in a group chat', async () => {
    llmCrudDecision.mockResolvedValue([{ action: 'NEW', fact: 'x', aboutSpeaker: true }])
    await setup().hooks.agent_end(event, { ...dm, sessionKey: 'agent:main:discord:group:7' })

    expect(searchMemory.mock.calls[0][3].subject).toBeUndefined()
    expect(llmCrudDecision.mock.calls[0][3].speaker).toBe(false)
    expect(addMemory.mock.calls[0][2].subjects).toBeUndefined()
  })

  it('does not tag or scope without a speaker', async () => {
    llmCrudDecision.mockResolvedValue([{ action: 'NEW', fact: 'x', aboutSpeaker: true }])
    await setup().hooks.agent_end(event, { agentId: 'main', sessionKey: 'agent:main:cron:1' })

    expect(searchMemory.mock.calls[0][3].subject).toBeUndefined()
    expect(addMemory.mock.calls[0][2].subjects).toBeUndefined()
  })

  it('tags the fallback memory when an UPDATE looks mis-targeted', async () => {
    searchMemory.mockResolvedValue([{ id: 'abcdefgh', content: 'old' }])
    encode.mockResolvedValue([1, 0])
    storageCtx.getNote.mockResolvedValue({ embedding: [0, 1] })
    llmCrudDecision.mockResolvedValue([{ action: 'UPDATE', fact: 'new', existingIdx: 0, aboutSpeaker: true }])
    await setup().hooks.agent_end(event, dm)

    expect(storageCtx.updateNoteContent).not.toHaveBeenCalled()
    expect(addMemory.mock.calls[0][2].subjects).toEqual(['discord:u1'])
  })

  it('leaves the fallback memory untagged for a world fact', async () => {
    searchMemory.mockResolvedValue([{ id: 'abcdefgh', content: 'old' }])
    encode.mockResolvedValue([1, 0])
    storageCtx.getNote.mockResolvedValue({ embedding: [0, 1] })
    llmCrudDecision.mockResolvedValue([{ action: 'UPDATE', fact: 'new', existingIdx: 0, aboutSpeaker: false }])
    await setup().hooks.agent_end(event, dm)

    expect(addMemory.mock.calls[0][2].subjects).toBeUndefined()
  })

  it('stores a speaker fact as a tagged note instead of updating an untagged one', async () => {
    searchMemory.mockResolvedValue([{ id: 'abcdefgh', content: 'old' }])
    encode.mockResolvedValue([1, 0])
    storageCtx.getNote.mockResolvedValue({ embedding: [1, 0], subjects: [] })
    llmCrudDecision.mockResolvedValue([{ action: 'UPDATE', fact: 'new', existingIdx: 0, aboutSpeaker: true }])
    await setup().hooks.agent_end(event, dm)

    expect(storageCtx.updateNoteContent).not.toHaveBeenCalled()
    expect(addMemory.mock.calls[0][2].subjects).toEqual(['discord:u1'])
    // The superseded untagged note must not stay active next to the tagged one.
    expect(storageCtx.invalidateNote).toHaveBeenCalledWith('abcdefgh', 'main')
  })

  it('updates in place a note already tagged for the speaker', async () => {
    searchMemory.mockResolvedValue([{ id: 'abcdefgh', content: 'old' }])
    encode.mockResolvedValue([1, 0])
    storageCtx.getNote.mockResolvedValue({ embedding: [1, 0], subjects: ['discord:u1'] })
    storageCtx.updateNoteContent.mockResolvedValue(true)
    llmCrudDecision.mockResolvedValue([{ action: 'UPDATE', fact: 'new', existingIdx: 0, aboutSpeaker: true }])
    await setup().hooks.agent_end(event, dm)

    expect(storageCtx.updateNoteContent).toHaveBeenCalled()
    expect(addMemory).not.toHaveBeenCalled()
  })
})

describe('agent_end candidate scope', () => {
  // Hidden notes come first, so the visible ones sit at raw positions 1 and 3.
  const notes: Record<string, string[]> = {
    theirs: ['discord:u2'],
    world: [],
    both: ['discord:u1', 'discord:u2'],
    mine: ['discord:u1'],
  }
  const results = Object.keys(notes).map((id) => ({ id, content: `c-${id}` }))
  const offered = () => (llmCrudDecision.mock.calls[0][2] as Array<{ content: string }>).map((m) => m.content)

  beforeEach(() => {
    searchMemory.mockResolvedValue(results)
    storageCtx.getNote.mockImplementation(async (id: string) => ({ embedding: [1, 0], subjects: notes[id] }))
    llmCrudDecision.mockResolvedValue([])
  })

  it('offers only untagged notes and notes tagged exactly for the speaker', async () => {
    await setup().hooks.agent_end(event, dm)
    expect(offered()).toEqual(['c-world', 'c-mine'])
  })

  it('offers only untagged notes when there is no speaker', async () => {
    await setup().hooks.agent_end(event, { agentId: 'main', sessionKey: 'agent:main:cron:1' })
    expect(offered()).toEqual(['c-world'])
  })

  it('offers only untagged notes in a group chat', async () => {
    await setup().hooks.agent_end(event, { ...dm, sessionKey: 'agent:main:discord:group:7' })
    expect(offered()).toEqual(['c-world'])
  })

  it('indexes the offered notes from zero, so a DELETE hits the note the model saw', async () => {
    llmCrudDecision.mockResolvedValue([{ action: 'DELETE', fact: '', existingIdx: 1, aboutSpeaker: true }])
    await setup().hooks.agent_end(event, dm)
    expect((llmCrudDecision.mock.calls[0][2] as Array<{ idx: number }>).map((m) => m.idx)).toEqual([0, 1])
    expect(storageCtx.invalidateNote).toHaveBeenCalledTimes(1)
    expect(storageCtx.invalidateNote).toHaveBeenCalledWith('mine', 'main')
  })

  it('skips a DELETE when the note stopped being visible after the search', async () => {
    searchMemory.mockResolvedValue([{ id: 'mine', content: 'c-mine' }])
    storageCtx.getNote
      .mockResolvedValueOnce({ embedding: [1, 0], subjects: ['discord:u1'] })
      .mockResolvedValueOnce({ embedding: [1, 0], subjects: ['discord:u1', 'discord:u2'] })
    llmCrudDecision.mockResolvedValue([{ action: 'DELETE', fact: '', existingIdx: 0, aboutSpeaker: true }])
    await setup().hooks.agent_end(event, dm)
    expect(storageCtx.invalidateNote).not.toHaveBeenCalled()
  })

  it('falls back to a tagged new note when an UPDATE target stopped being visible', async () => {
    searchMemory.mockResolvedValue([{ id: 'mine', content: 'c-mine' }])
    encode.mockResolvedValue([1, 0])
    storageCtx.getNote
      .mockResolvedValueOnce({ embedding: [1, 0], subjects: ['discord:u1'] })
      .mockResolvedValueOnce({ embedding: [1, 0], subjects: ['discord:u2'] })
    llmCrudDecision.mockResolvedValue([{ action: 'UPDATE', fact: 'new', existingIdx: 0, aboutSpeaker: true }])
    await setup().hooks.agent_end(event, dm)
    expect(storageCtx.updateNoteContent).not.toHaveBeenCalled()
    expect(storageCtx.invalidateNote).not.toHaveBeenCalled()
    expect(addMemory.mock.calls[0][2].subjects).toEqual(['discord:u1'])
  })

  it('falls back to an untagged new note for a world fact when the target stopped being visible', async () => {
    searchMemory.mockResolvedValue([{ id: 'mine', content: 'c-mine' }])
    encode.mockResolvedValue([1, 0])
    storageCtx.getNote
      .mockResolvedValueOnce({ embedding: [1, 0], subjects: ['discord:u1'] })
      .mockResolvedValueOnce({ embedding: [1, 0], subjects: ['discord:u1', 'discord:u2'] })
    llmCrudDecision.mockResolvedValue([{ action: 'UPDATE', fact: 'new', existingIdx: 0, aboutSpeaker: false }])
    await setup().hooks.agent_end(event, dm)
    expect(storageCtx.updateNoteContent).not.toHaveBeenCalled()
    expect(addMemory.mock.calls[0][2].subjects).toBeUndefined()
  })
})

describe('agent_end UPDATE on an untagged note', () => {
  beforeEach(() => {
    searchMemory.mockResolvedValue([{ id: 'abcdefgh', content: 'old' }])
    encode.mockResolvedValue([1, 0])
    storageCtx.getNote.mockResolvedValue({ embedding: [1, 0], subjects: [] })
    storageCtx.updateNoteContent.mockResolvedValue(true)
  })

  it('updates in place for a world fact', async () => {
    llmCrudDecision.mockResolvedValue([{ action: 'UPDATE', fact: 'new', existingIdx: 0, aboutSpeaker: false }])
    await setup().hooks.agent_end(event, dm)
    expect(storageCtx.updateNoteContent).toHaveBeenCalled()
    expect(storageCtx.invalidateNote).not.toHaveBeenCalled()
    expect(addMemory).not.toHaveBeenCalled()
  })

  it('updates in place when there is no speaker', async () => {
    llmCrudDecision.mockResolvedValue([{ action: 'UPDATE', fact: 'new', existingIdx: 0, aboutSpeaker: true }])
    await setup().hooks.agent_end(event, { agentId: 'main', sessionKey: 'agent:main:cron:1' })
    expect(storageCtx.updateNoteContent).toHaveBeenCalled()
    expect(storageCtx.invalidateNote).not.toHaveBeenCalled()
    expect(addMemory).not.toHaveBeenCalled()
  })
})

describe('identity links', () => {
  const link = { alice: ['telegram:7', 'discord:u1'] }

  it('uses one key for the same person on two channels', async () => {
    llmCrudDecision.mockResolvedValue([{ action: 'NEW', fact: 'x', aboutSpeaker: true }])
    const { hooks } = setupWith({ session: { identityLinks: link } })
    await hooks.agent_end(event, dm)
    await hooks.agent_end(event, { agentId: 'main', channel: 'telegram', senderId: '7', sessionKey: 'agent:main:main' })
    expect(addMemory.mock.calls[0][2].subjects).toEqual(['identity:alice'])
    expect(addMemory.mock.calls[1][2].subjects).toEqual(['identity:alice'])
  })

  it('ignores whitespace around an entry, as OpenClaw does', async () => {
    llmCrudDecision.mockResolvedValue([{ action: 'NEW', fact: 'x', aboutSpeaker: true }])
    const { hooks } = setupWith({ session: { identityLinks: { alice: [' telegram:7 ', 'discord:u1\t'] } } })
    await hooks.agent_end(event, dm)
    await hooks.agent_end(event, { agentId: 'main', channel: 'telegram', senderId: '7', sessionKey: 'agent:main:main' })
    expect(addMemory.mock.calls[0][2].subjects).toEqual(['identity:alice'])
    expect(addMemory.mock.calls[1][2].subjects).toEqual(['identity:alice'])
  })
})

describe('memory tools', () => {
  it('memory_search defaults subject to the speaker', async () => {
    await setup().tool('memory_search', dm).execute('c', { query: 'q' })

    expect(searchMemory.mock.calls[0][3].subject).toBe('discord:u1')
  })

  it('reads the speaker from the real tool ctx fields', async () => {
    const ctx = { agentId: 'main', messageChannel: 'Discord', requesterSenderId: 'u1' }
    const { tool } = setup()
    await tool('memory_search', ctx).execute('c', { query: 'q' })

    expect(searchMemory.mock.calls[0][3].subject).toBe('discord:u1')
    expect(tool('memory_add', ctx).description).toContain('discord:u1')
  })

  it('memory_search leaves subject unset without a speaker', async () => {
    await setup().tool('memory_search', { agentId: 'main' }).execute('c', { query: 'q' })
    expect(searchMemory.mock.calls[0][3].subject).toBeUndefined()
  })

  it('tells the model the speaker key, and nothing when unknown', () => {
    const { tool } = setup()
    expect(tool('memory_search', dm).description).toContain('discord:u1')
    expect(tool('memory_add', dm).description).toContain('discord:u1')
    expect(tool('memory_add', { agentId: 'main' }).description).not.toContain('speaker')
  })

  it('memory_add keeps no subjects as a world fact', async () => {
    await setup().tool('memory_add', dm).execute('c', { text: 't' })
    expect(addMemory.mock.calls[0][2].subjects).toBeUndefined()
  })
})

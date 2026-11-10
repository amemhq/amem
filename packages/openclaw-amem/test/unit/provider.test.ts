import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// The neutral reader the host prefers, and the registration that makes amem a native
// provider. Synthetic notes only.

const { searchMemory, pingQdrant, storageCtx } = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  pingQdrant: vi.fn(),
  storageCtx: { getNote: vi.fn() },
}))
vi.mock('@amemhq/core', async () => ({
  ...(await import('../../../amem-core/src/index.js')),
  searchMemory,
  pingQdrant,
  createStorageContext: () => storageCtx,
}))
vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({ definePluginEntry: (entry: unknown) => entry }))

import { createProviderRuntime } from '../../src/provider.js'
import { register } from '../../src/index.js'
import { cancelNightly, unwatchAgentEvents } from '../../src/nightly.js'

const scope = { agentId: 'main', storageCtx: storageCtx as never }
const context = () => ({ assertCurrent: vi.fn() })
const open = async (ctx = context()) =>
  (await createProviderRuntime('openclaw-amem', () => scope).open({ agentId: 'main', context: ctx })).provider

beforeEach(() => {
  cancelNightly()
  unwatchAgentEvents()
  for (const f of [searchMemory, pingQdrant, storageCtx.getNote]) f.mockReset()
})

describe('providerRuntime', () => {
  it('declares memory search only', async () => {
    expect((await open()).capabilities).toEqual({
      sources: ['memory'],
      pagination: false,
      candidates: [],
      projectFilter: false,
    })
  })

  it('searches notes about nobody, honours maxResults and minScore, and checks the caller around the read', async () => {
    searchMemory.mockResolvedValue([
      { id: 'a', content: 'kept', similarity: 0.8 },
      { id: 'b', content: 'too weak', similarity: 0.2 },
    ])
    const ctx = context()
    const page = await (await open(ctx)).search({ query: 'q', maxResults: 3, minScore: 0.5 })

    expect(searchMemory).toHaveBeenCalledWith('q', 3, 'main', { storageCtx, worldOnly: true })
    expect(page).toEqual({
      hits: [{ reference: { providerId: 'openclaw-amem', id: 'a' }, excerpt: 'kept', score: 0.8, source: 'memory' }],
      coverage: 'complete',
    })
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(2)
  })

  it('stops when the caller is no longer current', async () => {
    const ctx = context()
    ctx.assertCurrent.mockImplementation(() => {
      throw new Error('stale')
    })
    await expect((await open(ctx)).search({ query: 'q' })).rejects.toThrow('stale')
    expect(searchMemory).not.toHaveBeenCalled()
  })

  it('reads only what search can return: active notes about nobody', async () => {
    const provider = await open()
    const get = (id: string) => provider.get({ reference: { id } })
    storageCtx.getNote.mockResolvedValueOnce({ id: 'w', content: 'world', is_active: true, subjects: [] })
    expect(await get('w')).toEqual({ status: 'ok', reference: { providerId: 'openclaw-amem', id: 'w' }, text: 'world' })
    storageCtx.getNote.mockResolvedValueOnce({ id: 'p', content: 'x', is_active: true, subjects: ['discord:u1'] })
    expect(await get('p')).toEqual({ status: 'not_found' })
    storageCtx.getNote.mockResolvedValueOnce({ id: 'r', content: 'x', is_active: false, subjects: [] })
    expect(await get('r')).toEqual({ status: 'not_found' })
    storageCtx.getNote.mockResolvedValueOnce(null)
    expect(await get('none')).toEqual({ status: 'not_found' })
  })

  it('reports Qdrant being down as unavailable', async () => {
    const provider = await open()
    pingQdrant.mockResolvedValueOnce(undefined)
    expect((await provider.health()).status).toBe('ready')
    pingQdrant.mockRejectedValueOnce(new Error('down'))
    expect((await provider.health()).status).toBe('unavailable')
  })
})

describe('registration', () => {
  function registered() {
    const caps: Array<Record<string, unknown>> = []
    const cli: Array<{ opts: { descriptors: unknown[] } }> = []
    register({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginConfig: {},
      on: () => {},
      registerTool: () => {},
      registerService: () => {},
      registerMemoryCapability: (cap: Record<string, unknown>) => caps.push(cap),
      registerCli: (_r: unknown, opts: { descriptors: unknown[] }) => cli.push({ opts }),
    } as never)
    return { caps, cli }
  }

  it('registers providerRuntime next to the legacy runtime', () => {
    const [cap] = registered().caps
    expect(typeof (cap.runtime as { getMemorySearchManager?: unknown }).getMemorySearchManager).toBe('function')
    expect(typeof (cap.providerRuntime as { open?: unknown }).open).toBe('function')
  })

  it('registers the amem command with the descriptor the manifest declares', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../openclaw.plugin.json'), 'utf8'))
    const [{ opts }] = registered().cli
    expect(opts.descriptors).toEqual(manifest.cliCommands)
  })
})

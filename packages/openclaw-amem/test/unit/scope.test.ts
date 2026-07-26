import { describe, it, expect, vi } from 'vitest'
import type { AmemPluginConfig, StorageContext } from '@amemhq/core'
import { parseAgentIdFromSessionKey, resolveAgentId, buildScope } from '../../src/scope.js'

describe('parseAgentIdFromSessionKey', () => {
  it('pulls the agentId out of an agent:<id>:<rest> key', () => {
    expect(parseAgentIdFromSessionKey('agent:writer:session-123')).toBe('writer')
    expect(parseAgentIdFromSessionKey('agent:writer:a:b:c')).toBe('writer')
  })

  it('tolerates a leading colon (empty leading segment is filtered)', () => {
    expect(parseAgentIdFromSessionKey(':agent:writer:session')).toBe('writer')
  })

  it('returns undefined when the prefix is not "agent"', () => {
    expect(parseAgentIdFromSessionKey('user:writer:session')).toBeUndefined()
  })

  it('returns undefined when there are fewer than three segments', () => {
    // 'agent:writer' has two segments; 'agent:writer:' collapses to two after
    // the empty trailing segment is filtered out.
    expect(parseAgentIdFromSessionKey('agent:writer')).toBeUndefined()
    expect(parseAgentIdFromSessionKey('agent:writer:')).toBeUndefined()
    expect(parseAgentIdFromSessionKey('agent::session')).toBeUndefined()
  })

  it('returns undefined for empty / missing input', () => {
    expect(parseAgentIdFromSessionKey(undefined)).toBeUndefined()
    expect(parseAgentIdFromSessionKey('')).toBeUndefined()
  })
})

describe('resolveAgentId', () => {
  const cfg = (over: Partial<AmemPluginConfig> = {}): AmemPluginConfig => ({ ...over })

  it('prefers an explicit ctx.agentId over everything else', () => {
    expect(resolveAgentId({ agentId: 'explicit', sessionKey: 'agent:fromkey:s' }, cfg({ agentId: 'fromcfg' }))).toBe(
      'explicit'
    )
  })

  it('falls back to the sessionKey when ctx.agentId is absent', () => {
    expect(resolveAgentId({ sessionKey: 'agent:fromkey:s' }, cfg({ agentId: 'fromcfg' }))).toBe('fromkey')
  })

  it('falls back to pluginConfig.agentId when ctx has nothing usable', () => {
    expect(resolveAgentId({ sessionKey: 'not-an-agent-key' }, cfg({ agentId: 'fromcfg' }))).toBe('fromcfg')
    expect(resolveAgentId(undefined, cfg({ agentId: 'fromcfg' }))).toBe('fromcfg')
  })

  it("defaults to 'main' when nothing resolves", () => {
    expect(resolveAgentId(undefined, cfg())).toBe('main')
    expect(resolveAgentId({}, cfg())).toBe('main')
  })
})

describe('buildScope', () => {
  // A stub storage factory: records its args and returns an identifiable sentinel
  // so we can assert both the wiring passed to it and that its result is returned.
  const makeFactory = () =>
    vi.fn(
      (collection?: string, modeBIsolated?: boolean) =>
        ({ __stub: true, collection, modeBIsolated }) as unknown as StorageContext
    )

  it('mode A (default): no collection, shared-agent filter on', () => {
    const factory = makeFactory()
    const scope = buildScope('main', {}, factory)

    expect(scope.agentId).toBe('main')
    expect(scope.collection).toBeUndefined()
    expect(factory).toHaveBeenCalledWith(undefined, false)
    expect(scope.storageCtx).toBe(factory.mock.results[0].value)
  })

  it('mode A with a top-level collection: shared filter still on', () => {
    const factory = makeFactory()
    const scope = buildScope('main', { collection: 'shared_notes' }, factory)

    expect(scope.collection).toBe('shared_notes')
    expect(factory).toHaveBeenCalledWith('shared_notes', false)
  })

  it('per-agent agentId override remaps the effective agentId', () => {
    const factory = makeFactory()
    const scope = buildScope('raw', { agents: { raw: { agentId: 'canonical' } } }, factory)

    expect(scope.agentId).toBe('canonical')
    // No dedicated collection on the agent → still mode A.
    expect(factory).toHaveBeenCalledWith(undefined, false)
  })

  it('mode B (per-agent dedicated collection): isolated, filter off', () => {
    const factory = makeFactory()
    const scope = buildScope('raw', { agents: { raw: { collection: 'raw_notes' } } }, factory)

    expect(scope.collection).toBe('raw_notes')
    expect(factory).toHaveBeenCalledWith('raw_notes', true)
  })

  it("a per-agent collection wins over the top-level one and forces mode B", () => {
    const factory = makeFactory()
    const scope = buildScope('raw', { collection: 'top', agents: { raw: { collection: 'dedicated' } } }, factory)

    expect(scope.collection).toBe('dedicated')
    expect(factory).toHaveBeenCalledWith('dedicated', true)
  })
})

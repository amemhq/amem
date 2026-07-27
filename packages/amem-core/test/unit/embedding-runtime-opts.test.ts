/**
 * AMEM_EMBED_DEVICE / AMEM_EMBED_DTYPE resolution.
 *
 * Both are pass-through options, so the property that actually matters is the
 * *absence* one: unset must stay undefined so the pipeline call omits the key
 * entirely and an unconfigured install gets the library defaults it always had.
 * Returning a string like 'cpu' or 'fp32' would look equivalent and would not be —
 * it would pin behaviour that Transformers.js is free to change per platform.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { getEmbeddingDevice, getEmbeddingDtype } from '../../src/embedding.js'

afterEach(() => vi.unstubAllEnvs())

describe('getEmbeddingDevice', () => {
  it('is undefined when unset, so the option is omitted rather than defaulted here', () => {
    expect(getEmbeddingDevice()).toBeUndefined()
  })

  it('passes a value through without validating it', () => {
    // Transformers.js already rejects an unknown device and warns; a list here
    // would go stale the moment it gains a backend.
    vi.stubEnv('AMEM_EMBED_DEVICE', 'coreml')
    expect(getEmbeddingDevice()).toBe('coreml')
    vi.stubEnv('AMEM_EMBED_DEVICE', 'webgpu')
    expect(getEmbeddingDevice()).toBe('webgpu')
  })

  it('treats empty and whitespace as unset', () => {
    // An env var set to "" is how a shell passes "no value"; it must not become
    // a device named "" and reach the pipeline call.
    vi.stubEnv('AMEM_EMBED_DEVICE', '')
    expect(getEmbeddingDevice()).toBeUndefined()
    vi.stubEnv('AMEM_EMBED_DEVICE', '   ')
    expect(getEmbeddingDevice()).toBeUndefined()
  })

  it('trims surrounding whitespace', () => {
    vi.stubEnv('AMEM_EMBED_DEVICE', ' coreml ')
    expect(getEmbeddingDevice()).toBe('coreml')
  })
})

describe('getEmbeddingDtype', () => {
  it('is undefined when unset', () => {
    expect(getEmbeddingDtype()).toBeUndefined()
  })

  it('passes a value through', () => {
    vi.stubEnv('AMEM_EMBED_DTYPE', 'fp16')
    expect(getEmbeddingDtype()).toBe('fp16')
  })

  it('treats empty and whitespace as unset', () => {
    vi.stubEnv('AMEM_EMBED_DTYPE', '')
    expect(getEmbeddingDtype()).toBeUndefined()
    vi.stubEnv('AMEM_EMBED_DTYPE', '  ')
    expect(getEmbeddingDtype()).toBeUndefined()
  })

  it('does not interact with the pooling or model resolvers', () => {
    // All four read different env vars; a copy-paste error between them would be
    // invisible until someone set one and got another's behaviour.
    vi.stubEnv('AMEM_EMBED_DTYPE', 'int8')
    vi.stubEnv('AMEM_EMBED_DEVICE', 'cuda')
    expect(getEmbeddingDtype()).toBe('int8')
    expect(getEmbeddingDevice()).toBe('cuda')
  })
})

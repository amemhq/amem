/**
 * AMEM_EMBED_DEVICE / AMEM_EMBED_DTYPE resolution.
 *
 * Both are pass-through options, so the property that actually matters is the
 * *absence* one: unset must stay undefined so the pipeline call omits the key
 * entirely and an unconfigured install gets the library defaults it always had.
 * Returning a string like 'cpu' or 'fp32' would look equivalent and would not be —
 * it would pin behaviour that Transformers.js is free to change per platform.
 *
 * Dtype has exactly one exception to that, for amem's own default model. It is
 * asserted here in both directions because the whole risk is it leaking onto a
 * model that has no fp16 to load.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { getEmbeddingDevice, getEmbeddingDtype, DEFAULT_EMBEDDING_MODEL } from '../../src/embedding.js'

/** Any model that is not ours, so the dtype default does not apply. */
const OTHER_MODEL = 'Alibaba-NLP/gte-multilingual-base'

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
  it('is undefined when unset, for any model but our own', () => {
    vi.stubEnv('AMEM_EMBED_MODEL', OTHER_MODEL)
    expect(getEmbeddingDtype()).toBeUndefined()
  })

  it('passes a value through', () => {
    vi.stubEnv('AMEM_EMBED_MODEL', OTHER_MODEL)
    vi.stubEnv('AMEM_EMBED_DTYPE', 'fp16')
    expect(getEmbeddingDtype()).toBe('fp16')
  })

  it('treats empty and whitespace as unset', () => {
    vi.stubEnv('AMEM_EMBED_MODEL', OTHER_MODEL)
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

  // The one exception to the absence property above. fp16 halves the download for
  // the model amem ships (2.16 GB → 1.08 GB), but several models this project
  // documents publish fp32 only — multilingual-e5-large-instruct and
  // Qwen3-Embedding-4B among them — so it is scoped to the one model we checked.
  describe('the shipped default', () => {
    it('gets fp16 with nothing configured, which is what a fresh install is', () => {
      expect(getEmbeddingDtype()).toBe('fp16')
    })

    it('gets fp16 when named explicitly too', () => {
      vi.stubEnv('AMEM_EMBED_MODEL', DEFAULT_EMBEDDING_MODEL)
      expect(getEmbeddingDtype()).toBe('fp16')
    })

    it('still yields to AMEM_EMBED_DTYPE', () => {
      vi.stubEnv('AMEM_EMBED_MODEL', DEFAULT_EMBEDDING_MODEL)
      vi.stubEnv('AMEM_EMBED_DTYPE', 'fp32')
      expect(getEmbeddingDtype()).toBe('fp32')
    })

    it.each(['intfloat/multilingual-e5-large-instruct', 'onnx-community/Qwen3-Embedding-4B-ONNX', OTHER_MODEL])(
      'does not leak onto %s',
      (model) => {
        vi.stubEnv('AMEM_EMBED_MODEL', model)
        expect(getEmbeddingDtype()).toBeUndefined()
      }
    )
  })
})

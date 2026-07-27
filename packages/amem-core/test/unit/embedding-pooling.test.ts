/**
 * Pooling mode resolution.
 *
 * Every version before 1.4.2 pooled with `mean` unconditionally. BGE- and
 * GTE-family models are trained for `cls`, so pointing AMEM_EMBED_MODEL at one of
 * them produced a correctly-shaped, plausible, quietly-worse vector. Nothing
 * failed, which is why it went unnoticed — and why this is asserted here rather
 * than left to an integration test that would also pass either way.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { getEmbeddingPooling, DEFAULT_EMBEDDING_MODEL } from '../../src/embedding.js'

afterEach(() => vi.unstubAllEnvs())

describe('getEmbeddingPooling', () => {
  it('keeps mean for the shipped default, so upgrading changes nothing', () => {
    vi.stubEnv('AMEM_EMBED_MODEL', DEFAULT_EMBEDDING_MODEL)
    expect(getEmbeddingPooling()).toBe('mean')
  })

  it('resolves cls for bge-m3 — the case this fix exists for', () => {
    vi.stubEnv('AMEM_EMBED_MODEL', 'Xenova/bge-m3')
    expect(getEmbeddingPooling()).toBe('cls')
  })

  it('resolves the same model through a different org prefix', () => {
    // The ONNX mirror and the original are one model; keying on the full repo id
    // would silently mis-pool whichever one was not listed.
    vi.stubEnv('AMEM_EMBED_MODEL', 'BAAI/bge-m3')
    expect(getEmbeddingPooling()).toBe('cls')
    vi.stubEnv('AMEM_EMBED_MODEL', 'onnx-community/gte-multilingual-base')
    expect(getEmbeddingPooling()).toBe('cls')
  })

  it.each([
    ['Xenova/bge-base-zh-v1.5', 'cls'],
    ['Xenova/bge-small-en-v1.5', 'cls'],
    ['Alibaba-NLP/gte-modernbert-base', 'cls'],
    ['Snowflake/snowflake-arctic-embed-m', 'cls'],
    ['intfloat/multilingual-e5-large-instruct', 'mean'],
    ['onnx-community/Conan-embedding-v1', 'mean'],
    ['Xenova/all-MiniLM-L6-v2', 'mean'],
    ['nomic-ai/nomic-embed-text-v1.5', 'mean'],
  ] as const)('reads %s as %s', (model, expected) => {
    vi.stubEnv('AMEM_EMBED_MODEL', model)
    expect(getEmbeddingPooling()).toBe(expected)
  })

  it('falls back to mean for an unknown model rather than guessing', () => {
    // Wrong-by-omission on purpose: an unlisted model behaves exactly as every
    // release before this one did, so the table can only ever improve things.
    vi.stubEnv('AMEM_EMBED_MODEL', 'some-org/a-model-nobody-listed')
    expect(getEmbeddingPooling()).toBe('mean')
  })

  it('lets the env var override the table in both directions', () => {
    vi.stubEnv('AMEM_EMBED_MODEL', 'Xenova/bge-m3')
    vi.stubEnv('AMEM_EMBED_POOLING', 'mean')
    expect(getEmbeddingPooling()).toBe('mean')

    vi.stubEnv('AMEM_EMBED_MODEL', 'Xenova/all-MiniLM-L6-v2')
    vi.stubEnv('AMEM_EMBED_POOLING', 'cls')
    expect(getEmbeddingPooling()).toBe('cls')
  })

  it('ignores a malformed override instead of failing the encode path', () => {
    vi.stubEnv('AMEM_EMBED_MODEL', 'Xenova/bge-m3')
    vi.stubEnv('AMEM_EMBED_POOLING', 'CLS ')
    expect(getEmbeddingPooling()).toBe('cls') // trimmed and lowercased

    vi.stubEnv('AMEM_EMBED_POOLING', 'max')
    expect(getEmbeddingPooling()).toBe('cls') // unrecognised → model's own mode
  })
})

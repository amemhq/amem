/**
 * Which embedding model built a collection, recorded in Qdrant's own collection
 * metadata (Qdrant >= 1.16, PR #7123).
 *
 * This can only be proven against a real Qdrant: the whole change is about what
 * the server does with a `metadata` field and a PATCH, and a mocked client would
 * just confirm our own assumptions back to us.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const DIM = 384

// Model name comes from the env var, exactly as the real getEmbeddingModel does,
// so the tests can switch models without touching a real 2 GB download.
vi.mock('../../src/embedding.js', () => ({
  encode: async (t: string) => {
    const v = new Array(DIM).fill(0)
    for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) + 1
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / n)
  },
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  getEmbeddingDim: async () => DIM,
  getEmbeddingModel: () => process.env.AMEM_EMBED_MODEL || 'test/model-a',
  getEmbeddingPooling: () => 'mean',
}))

import { createStorageContext, resetCollectionReady, EmbeddingModelMismatchError } from '../../src/storage.js'

const QDRANT = 'http://localhost:6333'
const created: string[] = []

const fresh = (tag: string) => {
  const name = `amem_meta_${process.pid}_${tag}`
  created.push(name)
  return name
}

/** Read the collection's metadata straight from Qdrant, bypassing our code. */
async function readMetadata(col: string): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`${QDRANT}/collections/${col}`)
  const body = (await res.json()) as { result?: { config?: { metadata?: Record<string, unknown> } } }
  return body.result?.config?.metadata
}

beforeEach(() => {
  vi.unstubAllEnvs()
  // ensureCollection short-circuits on a per-collection readiness cache, so
  // without this the second open in a test returns before any check runs and the
  // assertion passes on nothing. (That cache is also why a model swap inside one
  // long-lived process is not caught — same limitation the dimension check has
  // always had, and out of scope here.)
  resetCollectionReady()
})

afterAll(async () => {
  for (const c of created) await fetch(`${QDRANT}/collections/${c}`, { method: 'DELETE' })
})

describe('collection model identity (integration — requires Qdrant on :6333)', () => {
  it('records the model on a collection it creates', async () => {
    const col = fresh('create')
    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-a')

    await createStorageContext(col).countNotes()

    expect(await readMetadata(col)).toMatchObject({ embedding_model: 'test/model-a' })
  })

  it('backfills a collection that predates the field', async () => {
    const col = fresh('backfill')
    // Create it the way every existing install's collection was created: no
    // metadata at all. This is the upgrade path, and it is the case that decides
    // whether current users survive a default-model change.
    await fetch(`${QDRANT}/collections/${col}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: { size: DIM, distance: 'Cosine' } }),
    })
    expect(await readMetadata(col)).toBeUndefined()

    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-a')
    await createStorageContext(col).countNotes()

    // The dimension matched, so the configured model provably wrote these
    // vectors — recording it now is the last moment that is still true.
    expect(await readMetadata(col)).toMatchObject({ embedding_model: 'test/model-a' })
  })

  it('refuses a different model of the same width', async () => {
    const col = fresh('mismatch')
    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-a')
    await createStorageContext(col).countNotes()

    // Same 384 dimensions, so the dimension guard sees nothing wrong. Without the
    // recorded model this is completely undetectable, and the store ends up
    // holding two incompatible geometries.
    resetCollectionReady()
    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-b')
    await expect(createStorageContext(col).countNotes()).rejects.toThrow(EmbeddingModelMismatchError)
  })

  it('names both models in the mismatch error, so the fix is in the message', async () => {
    const col = fresh('message')
    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-a')
    await createStorageContext(col).countNotes()

    resetCollectionReady()
    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-b')
    await expect(createStorageContext(col).countNotes()).rejects.toThrow(
      /test\/model-a[\s\S]*test\/model-b|test\/model-b[\s\S]*test\/model-a/
    )
  })

  it('accepts the model it recorded, on every later open', async () => {
    const col = fresh('stable')
    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-a')
    await createStorageContext(col).countNotes()
    // Drop the readiness cache so this really re-opens the collection and walks
    // the recorded-model comparison, rather than returning from cache.
    resetCollectionReady()
    await expect(createStorageContext(col).countNotes()).resolves.toBeTypeOf('number')
  })
})

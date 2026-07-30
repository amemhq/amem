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

/**
 * Stand-ins for the real constants. The point of these tests is the resolution
 * logic, not which model amem happens to ship — using the real names would make
 * them fail the next time the default moves, which is the one thing this logic
 * exists to survive.
 *
 * `LEGACY_DIM` must equal `DIM`: the legacy-inference branch keys on the
 * collection's width matching the old default's, and the mock encoder here is
 * that width.
 */
const LEGACY_DIM = DIM
const DEFAULT_MODEL = 'test/model-default'
const LEGACY_MODEL = 'test/model-legacy'

// vi.mock is hoisted above the imports, so the pin's state has to be hoisted too.
const emb = vi.hoisted(() => ({ pinned: null as string | null }))

// Model name resolves the way the real getEmbeddingModel does — env, then pin,
// then default — so the tests can switch models without a real 2 GB download.
vi.mock('../../src/embedding.js', () => ({
  encode: async (t: string) => {
    const v = new Array(DIM).fill(0)
    for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) + 1
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / n)
  },
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  getEmbeddingDim: async () => DIM,
  getEmbeddingModel: () => process.env.AMEM_EMBED_MODEL || emb.pinned || 'test/model-default',
  getEmbeddingPooling: () => 'mean',
  pinEmbeddingModel: (m: string | null) => {
    emb.pinned = m
  },
  getPinnedEmbeddingModel: () => emb.pinned,
  DEFAULT_EMBEDDING_MODEL: 'test/model-default',
  LEGACY_DEFAULT_EMBEDDING_MODEL: 'test/model-legacy',
  LEGACY_DEFAULT_DIM: 384,
}))

import {
  createStorageContext,
  resetCollectionReady,
  EmbeddingModelMismatchError,
  MixedEmbeddingModelsError,
} from '../../src/storage.js'
// The mock above, so this reads the same env-then-pin resolution the engine does.
import { getEmbeddingModel } from '../../src/embedding.js'

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

/**
 * A collection created the way every pre-2.0 install's was: vectors only, no
 * metadata. This is the upgrade path, and the only way to test it is to build one
 * without going through our own code.
 */
async function createBare(col: string, size = LEGACY_DIM): Promise<void> {
  await fetch(`${QDRANT}/collections/${col}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { size, distance: 'Cosine' } }),
  })
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
    await createBare(col)
    expect(await readMetadata(col)).toBeUndefined()

    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-a')
    await createStorageContext(col).countNotes()

    // The dimension matched and the model was configured rather than guessed, so
    // it provably wrote these vectors — recording it now is the last moment that
    // is still true.
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

  it('keeps a recorded model in use instead of the current default', async () => {
    const col = fresh('recorded-wins')
    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-a')
    await createStorageContext(col).countNotes()

    // Now the default moves — which is what a major release does. Nothing is
    // configured any more, so without the pin this would embed with
    // DEFAULT_MODEL and quietly mix two geometries in one store.
    resetCollectionReady()
    vi.unstubAllEnvs()
    await createStorageContext(col).countNotes()
    expect(getEmbeddingModel()).toBe('test/model-a')
  })
})

/**
 * The upgrade path for a store built before the model was ever recorded. There is
 * no metadata to read, so the only evidence is the vector width — and getting
 * this wrong means writing wrong-width vectors into a working store on the first
 * run after an upgrade.
 */
describe('legacy collections (integration — requires Qdrant on :6333)', () => {
  it('infers the old default from the width, and does not record the guess', async () => {
    const col = fresh('infer')
    await createBare(col)

    await createStorageContext(col).countNotes()

    expect(getEmbeddingModel()).toBe(LEGACY_MODEL)
    // Inference is repeated on every open precisely so it never has to be right
    // forever. A record here would be permanent, and it is a guess.
    expect(await readMetadata(col)).toBeUndefined()
  })

  it('does not infer when AMEM_EMBED_MODEL is set', async () => {
    const col = fresh('infer-off')
    await createBare(col)

    // Same collection, same width — only the env var differs. If the inference
    // ignored it, this would resolve to LEGACY_MODEL and record nothing.
    vi.stubEnv('AMEM_EMBED_MODEL', 'test/model-a')
    await createStorageContext(col).countNotes()

    expect(getEmbeddingModel()).toBe('test/model-a')
    expect(await readMetadata(col)).toMatchObject({ embedding_model: 'test/model-a' })
  })

  it('says how to migrate, on every open rather than once', async () => {
    const col = fresh('nag')
    await createBare(col)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await createStorageContext(col).countNotes()
    resetCollectionReady()
    await createStorageContext(col).countNotes()

    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('amem-migrate'))
    expect(said).toHaveLength(2)
    expect(said[0]).toContain(col)
    warn.mockRestore()
  })

  it('refuses two collections in one process that need different models', async () => {
    const migrated = fresh('mixed-new')
    const legacy = fresh('mixed-old')
    // What a half-finished mode B migration looks like: one per-agent collection
    // moved onto the new model, the rest still on the old one.
    await createStorageContext(migrated).countNotes()
    expect(await readMetadata(migrated)).toMatchObject({ embedding_model: DEFAULT_MODEL })
    await createBare(legacy)

    // No reset: this is deliberately the same process, still pinned by the first
    // collection. Picking a winner here would write DEFAULT_MODEL vectors into a
    // store built by LEGACY_MODEL.
    await expect(createStorageContext(legacy).countNotes()).rejects.toThrow(MixedEmbeddingModelsError)
  })
})

/**
 * Does a Qdrant alias carry the underlying collection's config through?
 *
 * This decides whether amem can adopt the alias pattern for model migrations —
 * data in `amem_notes_v2`, a stable alias `amem_notes` in front, switched
 * atomically so a user's configuration never has to change. Qdrant documents
 * that *queries* work identically through an alias; it does not say the same
 * about `GET /collections/{name}`, and amem reads two things from there:
 * `config.params.vectors.size` for the dimension guard and
 * `config.metadata.embedding_model` for the model guard.
 *
 * If either comes back empty through an alias, both guards silently stop
 * guarding — the dimension check would skip on `typeof !== 'number'` and the
 * model check would read `undefined` and take the "no record, backfill it"
 * branch. That is a worse failure than not adopting aliases at all, which is
 * why this is established before anything is built on it rather than after.
 */
import { describe, it, expect, afterAll } from 'vitest'

const QDRANT = 'http://localhost:6333'
const real = `amem_alias_real_${process.pid}`
const alias = `amem_alias_ptr_${process.pid}`
const DIM = 12
const MODEL = 'test/alias-probe-model'

type Info = {
  result?: {
    config?: {
      params?: { vectors?: { size?: number } }
      metadata?: Record<string, unknown>
    }
  }
}

const info = async (name: string): Promise<Info> =>
  (await (await fetch(`${QDRANT}/collections/${name}`)).json()) as Info

afterAll(async () => {
  await fetch(`${QDRANT}/collections/aliases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions: [{ delete_alias: { alias_name: alias } }] }),
  })
  await fetch(`${QDRANT}/collections/${real}`, { method: 'DELETE' })
})

describe('Qdrant alias transparency (integration — requires Qdrant on :6333)', () => {
  it('serves the underlying vector size and metadata through the alias', async () => {
    await fetch(`${QDRANT}/collections/${real}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: { size: DIM, distance: 'Cosine' } }),
    })
    await fetch(`${QDRANT}/collections/${real}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { embedding_model: MODEL } }),
    })

    // Sanity: the real collection has both, so a failure below is about the
    // alias rather than about the setup.
    const direct = await info(real)
    expect(direct.result?.config?.params?.vectors?.size).toBe(DIM)
    expect(direct.result?.config?.metadata?.embedding_model).toBe(MODEL)

    const aliased = await fetch(`${QDRANT}/collections/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ create_alias: { collection_name: real, alias_name: alias } }] }),
    })
    expect(aliased.ok).toBe(true)

    const viaAlias = await info(alias)
    expect(viaAlias.result?.config?.params?.vectors?.size).toBe(DIM)
    expect(viaAlias.result?.config?.metadata?.embedding_model).toBe(MODEL)
  })

  it('cannot create an alias over a name a real collection already holds', async () => {
    // This is the constraint that decides how an existing install adopts the
    // pattern: `amem_notes` is a real collection for everyone already running
    // amem, so the name has to be freed before an alias can take it.
    const occupied = `amem_alias_taken_${process.pid}`
    await fetch(`${QDRANT}/collections/${occupied}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: { size: DIM, distance: 'Cosine' } }),
    })

    const res = await fetch(`${QDRANT}/collections/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ create_alias: { collection_name: real, alias_name: occupied } }] }),
    })
    const body = await res.text()

    await fetch(`${QDRANT}/collections/${occupied}`, { method: 'DELETE' })

    // Recorded either way: if Qdrant permits this, the adoption path is far
    // simpler than assumed, and that is worth knowing precisely.
    console.log(`[alias-probe] create_alias over an existing collection → ${res.status} ${body.slice(0, 200)}`)
    expect([200, 400, 409]).toContain(res.status)
  })
})

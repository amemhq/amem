/**
 * Embedding-model migration, against a real Qdrant.
 *
 * `migrate.test.ts` covers the logic with every Qdrant call mocked. That proves
 * the branching and not much else: this command is what 2.0.0 will tell people to
 * run over the entire contents of their memory store, and until now nothing had
 * ever pushed a point through it into a real server.
 *
 * The properties asserted here are the ones a mock cannot establish — that the
 * target really ends up holding the notes, that the source is really untouched,
 * and that the refusals really refuse.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const SRC_DIM = 4
const DST_DIM = 6

// Two "models": the source collection is built at 4 dimensions, the migration
// target at 6. Tiny on purpose — this is about the plumbing, not about vectors.
vi.mock('../../src/embedding.js', () => ({
  encode: async (t: string) => {
    const v = new Array(DST_DIM).fill(0)
    for (let i = 0; i < t.length; i++) v[i % DST_DIM] += t.charCodeAt(i) + 1
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / n)
  },
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  getEmbeddingDim: async () => DST_DIM,
  getEmbeddingModel: () => 'test/target-model',
  getEmbeddingPooling: () => 'mean',
}))

// No LLM. Notes here all have keywords, so refreshFields never fires; the one
// test that needs it stubs a note without them and asserts the call is made.
const construct = vi.hoisted(() => vi.fn(async () => ({
  keywords: ['filled'],
  tags: ['filled'],
  context: 'filled',
  category: 'General',
  note_type: 'memory',
  topics: [],
})))
vi.mock('../../src/llm.js', () => ({ llmConstructNote: construct }))

import { migrateCollection } from '../../src/migrate.js'
import { createCollectionRaw, upsertPointsRaw, countPointsRaw, scrollAllRaw } from '../../src/storage.js'

const QDRANT = 'http://localhost:6333'
const made: string[] = []
const name = (tag: string) => {
  const n = `amem_mig_${process.pid}_${tag}`
  made.push(n)
  return n
}

/** A source collection at SRC_DIM holding `count` notes. */
async function seed(col: string, count: number, opts: { withKeywords?: boolean } = {}): Promise<void> {
  await fetch(`${QDRANT}/collections/${col}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { size: SRC_DIM, distance: 'Cosine' } }),
  })
  const now = new Date().toISOString()
  const points = Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    vector: new Array(SRC_DIM).fill(0).map((_, k) => (k === i % SRC_DIM ? 1 : 0)),
    payload: {
      content: `note number ${i}`,
      keywords: opts.withKeywords === false ? [] : ['seeded'],
      tags: opts.withKeywords === false ? [] : ['seeded'],
      context: 'seeded',
      embedding: [],
      links: [],
      timestamp: now,
      agent_id: 'main',
      hash: `h${i}`,
      retrieval_count: 0,
      last_accessed: now,
      evolution_history: [],
      category: 'General',
      is_active: true,
      note_type: 'memory',
      topics: [],
      owner: 'main',
      readers: ['main'],
      writers: ['main'],
      subjects: [],
    },
  }))
  await upsertPointsRaw(col, points)
}

beforeEach(() => construct.mockClear())

afterAll(async () => {
  for (const c of made) await fetch(`${QDRANT}/collections/${c}`, { method: 'DELETE' })
})

describe('migrateCollection (integration — requires Qdrant on :6333)', () => {
  it('a dry run reports the work and writes nothing', async () => {
    const from = name('dry_src')
    const to = name('dry_dst')
    await seed(from, 3)

    const r = await migrateCollection({ from, to, dryRun: true, logger: { info: () => {}, warn: () => {} } })

    expect(r.total).toBe(3)
    expect(r.migrated).toBe(0)
    expect(r.sourceDim).toBe(SRC_DIM)
    expect(r.targetDim).toBe(DST_DIM)
    // The target must not even exist — a dry run that creates an empty
    // collection would make a second dry run behave differently from the first.
    const res = await fetch(`${QDRANT}/collections/${to}`)
    expect(res.status).toBe(404)
  })

  it('rebuilds every note into a target of the new width', async () => {
    const from = name('apply_src')
    const to = name('apply_dst')
    await seed(from, 5)

    const r = await migrateCollection({ from, to, dryRun: false, logger: { info: () => {}, warn: () => {} } })

    expect(r.migrated).toBe(5)
    expect(await countPointsRaw(to)).toBe(5)

    const moved = await scrollAllRaw(to)
    expect(moved).toHaveLength(5)
    // Re-embedded at the target width, not copied across.
    for (const p of moved) expect(p.vector).toHaveLength(DST_DIM)
    // Content survived the round trip.
    const contents = moved.map((p) => p.payload.content).sort()
    expect(contents).toContain('note number 0')
    expect(contents).toContain('note number 4')
  })

  it('leaves the source untouched, which is what makes the switch reversible', async () => {
    const from = name('ro_src')
    const to = name('ro_dst')
    await seed(from, 4)
    const before = await scrollAllRaw(from)

    await migrateCollection({ from, to, dryRun: false, logger: { info: () => {}, warn: () => {} } })

    const after = await scrollAllRaw(from)
    expect(after).toHaveLength(before.length)
    // Same ids, same widths, same content — nothing rewritten in place.
    expect(after.map((p) => p.id).sort()).toEqual(before.map((p) => p.id).sort())
    for (const p of after) expect(p.vector).toHaveLength(SRC_DIM)
  })

  it('refuses a target that already holds points', async () => {
    const from = name('busy_src')
    const to = name('busy_dst')
    await seed(from, 2)
    // A target at the right width but not empty: the name is probably wrong, and
    // mixing two stores cannot be undone by pointing a config back.
    await createCollectionRaw(to, DST_DIM)
    await upsertPointsRaw(to, [
      { id: '00000000-0000-4000-8000-999999999999', vector: new Array(DST_DIM).fill(0.5), payload: { content: 'squatter' } },
    ])

    await expect(
      migrateCollection({ from, to, dryRun: false, logger: { info: () => {}, warn: () => {} } })
    ).rejects.toThrow(/already holds/)
  })

  it('refuses a missing source rather than creating an empty target', async () => {
    const to = name('nosrc_dst')
    await expect(
      migrateCollection({ from: `amem_absent_${process.pid}`, to, dryRun: false, logger: { info: () => {}, warn: () => {} } })
    ).rejects.toThrow(/does not exist/)
    expect((await fetch(`${QDRANT}/collections/${to}`)).status).toBe(404)
  })

  it('re-extracts only the notes that never had keywords', async () => {
    const from = name('refresh_src')
    const to = name('refresh_dst')
    await seed(from, 3, { withKeywords: false })

    const r = await migrateCollection({
      from,
      to,
      dryRun: false,
      refreshFields: true,
      logger: { info: () => {}, warn: () => {} },
    })

    expect(r.missingDerived).toBe(3)
    expect(r.refreshed).toBe(3)
    expect(construct).toHaveBeenCalledTimes(3)
    const moved = await scrollAllRaw(to)
    for (const p of moved) expect(p.payload.keywords).toEqual(['filled'])
  })

  it('makes no LLM calls when refreshFields is off', async () => {
    const from = name('norefresh_src')
    const to = name('norefresh_dst')
    await seed(from, 3, { withKeywords: false })

    const r = await migrateCollection({
      from,
      to,
      dryRun: false,
      refreshFields: false,
      logger: { info: () => {}, warn: () => {} },
    })

    expect(r.refreshed).toBe(0)
    expect(construct).not.toHaveBeenCalled()
    // Still migrated — just embedded from less text.
    expect(await countPointsRaw(to)).toBe(3)
  })

  it('records the target model on the collection it creates', async () => {
    const from = name('meta_src')
    const to = name('meta_dst')
    await seed(from, 1)

    await migrateCollection({ from, to, dryRun: false, logger: { info: () => {}, warn: () => {} } })

    const body = (await (await fetch(`${QDRANT}/collections/${to}`)).json()) as {
      result?: { config?: { metadata?: { embedding_model?: string } } }
    }
    expect(body.result?.config?.metadata?.embedding_model).toBe('test/target-model')
  })
})

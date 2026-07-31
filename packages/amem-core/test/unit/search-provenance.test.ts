/**
 * What a search result says about itself.
 *
 * Two hops of link expansion have been in `searchMemory` since Story 18, and no
 * test ever looked at what came out of it. Both defects below survived that way,
 * and together they made a working feature read as a missing one: an agent on a
 * real store reported that link expansion "does not happen", because every
 * expanded note it saw was labelled 0%.
 *
 * The embedding mock is a real 2-D cosine so similarity is an actual number here,
 * not a stub — the whole point is which number reaches the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/llm.js', () => ({
  llmConstructNote: vi.fn(),
  llmShouldLink: vi.fn(async () => false),
  llmEvolveNote: vi.fn(),
  llmShouldMerge: vi.fn(),
  llmEvolutionJudge: vi.fn(),
  llmConflictScan: vi.fn(async () => []),
}))
vi.mock('../../src/embedding.js', () => ({
  // The query sits on the x axis. A note's angle to it is set by its vector.
  encode: vi.fn(async () => [1, 0]),
  cosineSimilarity: (a: number[], b: number[]) => {
    const dot = a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)
    const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1
    const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0)) || 1
    return dot / (na * nb)
  },
}))

import { searchMemory } from '../../src/memory.js'
import type { MemoryNote, StorageContext } from '../../src/storage.js'

function note(id: string, embedding: number[], links: string[] = [], content = id): MemoryNote {
  return {
    id,
    content,
    keywords: [],
    tags: [],
    context: '',
    links,
    embedding,
    timestamp: '2026-01-01T00:00:00.000Z',
    agent_id: 'main',
    hash: id,
    retrieval_count: 0,
    last_accessed: '2026-01-01T00:00:00.000Z',
    evolution_history: [],
    category: 'General',
    is_active: true,
    note_type: 'memory',
    topics: [],
    pending_merge: false,
    conflict: false,
    subjects: [],
    ephemeral: false,
    low_quality: false,
    owner: 'main',
    readers: ['*'],
    writers: ['main'],
  }
}

/**
 * `hit` is on the query axis, is the only note dense retrieval returns, and is
 * the only one whose text contains the query term. `neighbour` is 60° off it —
 * well above the 0.25 gate, nowhere near a match — and is reachable only by
 * following `hit`'s link.
 *
 * The distinct wording matters: `bm25Score` returns every note in the store,
 * zero-scoring ones included, so a shared vocabulary would put `neighbour` in the
 * ranked pool and it would arrive as a match without ever going through
 * expansion — which is what this file is trying to observe.
 */
const HIT = note('hit', [1, 0], ['neighbour'], 'alpha')
const NEIGHBOUR = note('neighbour', [0.5, Math.sqrt(3) / 2], [], 'beta')

/** topK=1 keeps `neighbour` out of the ranked slice so expansion is the only way in. */
const TOP_K = 1

function makeCtx(all: MemoryNote[], dense: MemoryNote[]) {
  return {
    countNotes: vi.fn(async () => all.length),
    // Only `dense` is retrievable by vector — that is what makes `neighbour`
    // reachable by link and by nothing else.
    queryByEmbedding: vi.fn(async () => dense.map((n) => ({ note: n, score: 1 }))),
    listNotes: vi.fn(async () => all),
    findByHash: vi.fn(async () => null),
    addNote: vi.fn(async () => {}),
    updateNote: vi.fn(async () => {}),
    updateNoteContent: vi.fn(async () => true),
    getNote: vi.fn(async () => null),
  } as unknown as StorageContext
}

beforeEach(() => vi.clearAllMocks())

describe('link-expanded results', () => {
  it('reports how close the expanded note actually is, not zero', async () => {
    const res = await searchMemory('alpha', TOP_K, 'main', { storageCtx: makeCtx([HIT, NEIGHBOUR], [HIT]) })
    const expanded = res.find((r) => r.id === 'neighbour')

    // cos 60° = 0.5. Before this was fixed it was 0, because the similarity map
    // only covered dense results and an expanded note is by definition not one.
    expect(expanded?.similarity).toBeCloseTo(0.5, 5)
  })

  it('says which results matched and which came along a link', async () => {
    const res = await searchMemory('alpha', TOP_K, 'main', { storageCtx: makeCtx([HIT, NEIGHBOUR], [HIT]) })

    expect(res.find((r) => r.id === 'hit')?.via).toBe('match')
    expect(res.find((r) => r.id === 'neighbour')?.via).toBe('link')
  })

  it('keeps every match ahead of every link', async () => {
    // Matches are the rrf-sorted slice; links are appended in discovery order.
    // The boundary is the only thing that makes the tail of the list readable —
    // without it those rows look like lower-ranked matches.
    const res = await searchMemory('alpha', TOP_K, 'main', { storageCtx: makeCtx([HIT, NEIGHBOUR], [HIT]) })
    const firstLink = res.findIndex((r) => r.via === 'link')
    expect(firstLink).toBeGreaterThan(0)
    expect(res.slice(0, firstLink).every((r) => r.via === 'match')).toBe(true)
    expect(res.slice(firstLink).every((r) => r.via === 'link')).toBe(true)
  })

  it('carries no rrf when nothing ranked it', async () => {
    // `neighbour` shares no term with the query and is not in the dense results,
    // so neither retriever contributes it and it reaches the list only along the
    // link. It used to hold a fused score anyway — bm25Score returns every note
    // in the store, zero-scoring ones included, and that slice went straight into
    // the fusion. Filtering those out is what makes 0 mean "nothing ranked this".
    const res = await searchMemory('alpha', TOP_K, 'main', { storageCtx: makeCtx([HIT, NEIGHBOUR], [HIT]) })
    expect(res.find((r) => r.id === 'neighbour')?.rrf).toBe(0)
    expect(res.find((r) => r.id === 'hit')?.rrf).toBeGreaterThan(0)
  })

  it('still drops a neighbour below the relevance gate', async () => {
    // 90° off the query — cos 0, under the 0.25 default. Recording the
    // similarity must not have turned the gate into a pass-through.
    const far = note('far', [0, 1], [], 'gamma')
    const hit = note('hit', [1, 0], ['far'], 'alpha')
    const res = await searchMemory('alpha', TOP_K, 'main', { storageCtx: makeCtx([hit, far], [hit]) })
    expect(res.map((r) => r.id)).toEqual(['hit'])
  })

  it('admits it when the gate is switched off, and still reports the real number', async () => {
    const far = note('far', [0, 1], [], 'gamma')
    const hit = note('hit', [1, 0], ['far'], 'alpha')
    const res = await searchMemory('alpha', TOP_K, 'main', {
      storageCtx: makeCtx([hit, far], [hit]),
      bfsSimThreshold: 0,
    })
    expect(res.find((r) => r.id === 'far')?.similarity).toBeCloseTo(0, 5)
    expect(res.find((r) => r.id === 'far')?.via).toBe('link')
  })

  it('marks everything a match when expansion is off', async () => {
    const res = await searchMemory('alpha', TOP_K, 'main', {
      storageCtx: makeCtx([HIT, NEIGHBOUR], [HIT]),
      useBfs: false,
    })
    expect(res.map((r) => r.via)).toEqual(['match'])
  })
})

/**
 * What BM25 contributes when the query hits nothing.
 *
 * `bm25Score` scores every note in the store and returns them all; the ones that
 * share no term with the query come out at exactly 0 and sort among themselves in
 * whatever order the store handed them over. Taking the first `n` of that put
 * notes chosen by nothing into the fusion at the same rank weights as real dense
 * hits, and stably — the same notes on every such query, so it biased rather than
 * averaged out.
 */
describe('lexical misses', () => {
  const A = note('a', [1, 0], [], 'alpha')
  const B = note('b', [0.9, 0.1], [], 'beta')
  const C = note('c', [0.8, 0.2], [], 'gamma')

  it('contributes nothing when no note shares a term with the query', async () => {
    // Dense returns only `a`. Nothing matches "zeta", so the fusion has one
    // input and must return one note. `b` and `c` used to ride in on rank 1 and 2
    // of a table of zeroes.
    const res = await searchMemory('zeta', 5, 'main', { storageCtx: makeCtx([A, B, C], [A]) })
    expect(res.map((r) => r.id)).toEqual(['a'])
  })

  it('leaves the dense ranking alone rather than reshuffling it', async () => {
    // Both retrievers empty of lexical signal → the result is the dense order,
    // which is the right answer for a query with no terms in the store.
    const res = await searchMemory('zeta', 5, 'main', { storageCtx: makeCtx([A, B, C], [C, A, B]) })
    expect(res.map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('still fuses the notes that do match', async () => {
    // The half that works must keep working: `b` matches lexically and is absent
    // from the dense results, and it has to come back.
    const res = await searchMemory('beta', 5, 'main', { storageCtx: makeCtx([A, B, C], [A]) })
    expect(res.map((r) => r.id).sort()).toEqual(['a', 'b'])
    expect(res.find((r) => r.id === 'b')?.via).toBe('match')
  })
})

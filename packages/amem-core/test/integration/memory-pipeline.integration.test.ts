import { describe, it, expect, vi } from 'vitest'

// Deterministic fake embedding, hoisted so the vi.mock factory can use it:
// the same text always maps to the same L2-normalized 384-d vector, so a query
// that repeats the stored text matches it exactly. No ONNX model download.
const { fakeEncode } = vi.hoisted(() => {
  function fakeEncode(text: string): number[] {
    const dim = 384
    const v = new Array(dim).fill(0)
    for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i) + 1
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
  return { fakeEncode }
})

// Mock the LLM so the pipeline is deterministic and hits no API: a fixed note
// structure (empty keywords/tags/context → embed text == content), and no
// linking / merging / evolution.
vi.mock('../../src/llm.js', () => ({
  llmConstructNote: async () => ({
    keywords: [],
    tags: [],
    context: '',
    category: 'General',
    note_type: 'memory',
    topics: [],
  }),
  llmShouldLink: async () => false,
  llmEvolveNote: async () => ({ context: '', tags: [], keywords: [] }),
  llmShouldMerge: async () => ({ shouldMerge: false }),
  llmEvolutionJudge: async () => ({ action: 'NONE' }),
}))

// Mock embeddings so no 384-d ONNX model is downloaded; deterministic vectors.
// getEmbeddingDim is mocked to match fakeEncode's width: storage creates the
// collection at whatever this returns, and checks an existing one against it.
vi.mock('../../src/embedding.js', () => ({
  encode: async (t: string) => fakeEncode(t),
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  getEmbeddingDim: async () => 384,
  getEmbeddingModel: () => 'test/fake-encoder',
  // This test pins getEmbeddingModel to a constant, so model resolution has
  // nothing to resolve. Stubbed as no-ops rather than omitted: ensureCollection
  // calls both, and a missing export is a hard mock error.
  pinEmbeddingModel: () => {},
  getPinnedEmbeddingModel: () => null,
}))

import { addMemory, searchMemory } from '../../src/memory.js'
import { createStorageContext, type MemoryNote } from '../../src/storage.js'

// A fresh collection per worker keeps integration runs isolated (Mode B).
const collection = `amem_it_${process.pid}`

describe('memory pipeline (integration — requires Qdrant on :6333)', () => {
  it('stores a memory and retrieves it by the same query', async () => {
    const ctx = createStorageContext(collection)
    const id = await addMemory('the sky is unusually blue today', 'main', { storageCtx: ctx })
    expect(id).toBeTruthy()

    const results = await searchMemory('the sky is unusually blue today', 5, 'main', { storageCtx: ctx })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('sky is unusually blue')
  })

  it('isolates memories per agent — dev cannot see main’s private note', async () => {
    const ctx = createStorageContext(collection)
    await addMemory('mains private note mentioning zephyrquux', 'main', {
      scope: 'private',
      storageCtx: ctx,
    })
    const devResults = await searchMemory('zephyrquux', 5, 'dev', { storageCtx: ctx })
    expect(devResults).toHaveLength(0)
  })

  // Story 41: an accepted overwrite must stay recoverable. The similarity guard
  // has false negatives, so this is the last line before content is gone.
  it('keeps the replaced text in evolution_history on a caller-scoped update', async () => {
    // Its own collection. The fake encoder makes unrelated strings similar
    // enough to trip the 0.85 dedup threshold, so on the shared collection this
    // addMemory folded into a note from the test above and the assertions below
    // ran against content this test never wrote.
    const ctx = createStorageContext(`${collection}_evo`)
    const original = 'the original wording about quibblewick'
    const id = await addMemory(original, 'main', { storageCtx: ctx })

    const replacement = 'the revised wording about quibblewick'
    const ok = await ctx.updateNoteContent(id, replacement, fakeEncode(replacement), 'newhash', 'main')
    expect(ok).toBe(true)

    const note = await ctx.getNote(id, 'main')
    expect(note?.content).toBe(replacement)

    const snapshot = note?.evolution_history?.find((e) => e.action === 'crud_update')
    expect(snapshot).toBeDefined()
    expect(snapshot?.oldContent).toBe(original)
  })

  // Story 44: the subject filter is where isolation actually happens — it is a
  // Qdrant filter, not a JS post-filter — so it can only be proven against a real
  // Qdrant. Exercised at the STORAGE layer on purpose: this is a storage concern,
  // and going through addMemory would drag in hash and high-similarity dedup,
  // which collapses deliberately-similar test fixtures into one another. That
  // searchMemory threads the subject into both of its retrieval calls is pinned
  // by the unit tests instead.
  const subjNote = (id: string, content: string, subjects: string[], seed: number): MemoryNote => {
    // Distinct one-hot-ish vectors: identical enough to all match the probe,
    // distinct enough that nothing here depends on embedding similarity.
    const embedding = new Array(384).fill(0)
    embedding[seed] = 1
    const now = new Date().toISOString()
    return {
      id,
      subjects,
      content,
      keywords: [],
      tags: [],
      context: '',
      embedding,
      links: [],
      timestamp: now,
      agent_id: 'main',
      hash: id,
      retrieval_count: 0,
      last_accessed: now,
      evolution_history: [],
      category: 'General',
      is_active: true,
      note_type: 'memory',
      topics: [],
      pending_merge: false,
      conflict: false,
      ephemeral: false,
      low_quality: false,
      owner: 'main',
      readers: ['main'],
      writers: ['main'],
    } as MemoryNote
  }

  it('scopes retrieval by subject: own + shared + world, never someone else’s', async () => {
    const ctx = createStorageContext(collection)
    const p = process.pid
    const probe = new Array(384).fill(1 / Math.sqrt(384)) // matches everything a little

    await ctx.addNote(subjNote(`00000000-0000-4000-8000-${String(p).padStart(12, '1')}`, 'ALEX only', ['alex'], 10))
    await ctx.addNote(subjNote(`00000000-0000-4000-8000-${String(p).padStart(12, '2')}`, 'SAM only', ['sam'], 11))
    await ctx.addNote(
      subjNote(`00000000-0000-4000-8000-${String(p).padStart(12, '3')}`, 'SHARED both', ['alex', 'sam'], 12)
    )
    await ctx.addNote(subjNote(`00000000-0000-4000-8000-${String(p).padStart(12, '4')}`, 'WORLD nobody', [], 13))

    const seen = async (subject?: string) =>
      (await ctx.queryByEmbedding(probe, 50, 'main', 0.0, subject)).map((r) => r.note.content)

    const forAlex = await seen('alex')
    expect(forAlex).toContain('ALEX only') // about them
    expect(forAlex).toContain('SHARED both') // shared with them
    expect(forAlex).toContain('WORLD nobody') // about nobody
    expect(forAlex).not.toContain('SAM only') // about someone else

    const forSam = await seen('sam')
    expect(forSam).toContain('SAM only')
    expect(forSam).toContain('SHARED both')
    expect(forSam).not.toContain('ALEX only')

    // No subject = no person scoping. This is what every existing caller does.
    const all = await seen()
    expect(all).toEqual(expect.arrayContaining(['ALEX only', 'SAM only', 'SHARED both', 'WORLD nobody']))
  })
})
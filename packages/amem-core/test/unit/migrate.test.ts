/**
 * Embedding-model migration. Synthetic notes and a mocked Qdrant surface only.
 *
 * The property that matters most here is negative: the source collection is
 * never written to. That is what makes the switch reversible, so it is asserted
 * explicitly rather than assumed from reading the code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const raw = vi.hoisted(() => ({
  scrollAllRaw: vi.fn(),
  countPointsRaw: vi.fn(),
  collectionDimRaw: vi.fn(),
  createCollectionRaw: vi.fn(),
  upsertPointsRaw: vi.fn(),
}))
const { encode, constructNote } = vi.hoisted(() => ({
  encode: vi.fn(async () => [0.1, 0.2, 0.3]),
  constructNote: vi.fn(),
}))

vi.mock('../../src/storage.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, ...raw }
})
vi.mock('../../src/embedding.js', () => ({
  encode,
  getEmbeddingDim: vi.fn(async () => 3),
  getEmbeddingModel: vi.fn(() => 'test/model'),
}))
vi.mock('../../src/llm.js', () => ({
  llmConstructNote: constructNote,
  llmShouldLink: vi.fn(),
  llmEvolveNote: vi.fn(),
  llmShouldMerge: vi.fn(),
  llmEvolutionJudge: vi.fn(),
  llmConflictScan: vi.fn(),
}))

import { migrateCollection } from '../../src/migrate.js'

const point = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  vector: [1, 2],
  payload: {
    content: `content ${id}`,
    keywords: ['k'],
    tags: ['t'],
    context: 'c',
    links: [],
    timestamp: '2026-01-01T00:00:00.000Z',
    agent_id: 'main',
    hash: id,
    category: 'General',
    is_active: true,
    note_type: 'memory',
    owner: 'main',
    readers: ['main'],
    writers: ['main'],
    ...over,
  },
})

const silent = { info: () => {}, warn: () => {} }

beforeEach(() => {
  Object.values(raw).forEach((m) => m.mockReset())
  encode.mockClear()
  constructNote.mockReset()
  raw.collectionDimRaw.mockImplementation(async (c: string) => (c === 'src' ? 384 : null))
  raw.scrollAllRaw.mockResolvedValue([point('a'), point('b')])
  raw.countPointsRaw.mockResolvedValue(2)
})

describe('migrateCollection — dry run is the default', () => {
  it('writes nothing and reports what it found', async () => {
    const res = await migrateCollection({ from: 'src', to: 'dst', logger: silent })

    expect(res).toMatchObject({ total: 2, migrated: 0, dryRun: true, sourceDim: 384, targetDim: 3 })
    expect(raw.createCollectionRaw).not.toHaveBeenCalled()
    expect(raw.upsertPointsRaw).not.toHaveBeenCalled()
  })

  it('counts the notes that never had derived fields', async () => {
    raw.scrollAllRaw.mockResolvedValue([point('a'), point('old', { keywords: [], tags: [] })])

    const res = await migrateCollection({ from: 'src', to: 'dst', logger: silent })
    expect(res.missingDerived).toBe(1)
  })
})

describe('migrateCollection — applying', () => {
  it('creates the target at the model’s width and backfills every note', async () => {
    const res = await migrateCollection({ from: 'src', to: 'dst', dryRun: false, logger: silent })

    expect(raw.createCollectionRaw).toHaveBeenCalledWith('dst', 3)
    expect(res.migrated).toBe(2)
    expect(encode).toHaveBeenCalledTimes(2)
  })

  it('never writes to the source — this is what makes the switch reversible', async () => {
    await migrateCollection({ from: 'src', to: 'dst', dryRun: false, logger: silent })

    const written = raw.upsertPointsRaw.mock.calls.map((c) => c[0])
    expect(written.every((c) => c === 'dst')).toBe(true)
    expect(written).not.toContain('src')
  })

  it('re-extracts only the notes missing derived fields, and only fills gaps', async () => {
    raw.scrollAllRaw.mockResolvedValue([point('a'), point('old', { keywords: [], tags: [], context: '' })])
    constructNote.mockResolvedValue({ keywords: ['new'], tags: ['new'], context: 'new', topics: [] })

    const res = await migrateCollection({ from: 'src', to: 'dst', dryRun: false, logger: silent })

    expect(constructNote).toHaveBeenCalledOnce() // not for the healthy note
    expect(res.refreshed).toBe(1)
  })

  it('keeps a note’s existing tags when re-extracting, rather than relabelling', async () => {
    // A note with keywords but no tags gets its tags filled and its keywords left
    // alone: this is a backfill of what was never extracted, not a rewrite of
    // curation the user may have done.
    raw.scrollAllRaw.mockResolvedValue([point('half', { keywords: ['mine'], tags: [] })])
    constructNote.mockResolvedValue({ keywords: ['theirs'], tags: ['added'], context: 'x', topics: [] })

    await migrateCollection({ from: 'src', to: 'dst', dryRun: false, logger: silent })

    const written = raw.upsertPointsRaw.mock.calls[0][1][0]
    expect(written.payload.keywords).toEqual(['mine'])
    expect(written.payload.tags).toEqual(['added'])
  })

  it('survives a failed re-extraction by keeping the note as it was', async () => {
    raw.scrollAllRaw.mockResolvedValue([point('old', { keywords: [], tags: [] })])
    constructNote.mockRejectedValue(new Error('llm down'))

    const res = await migrateCollection({ from: 'src', to: 'dst', dryRun: false, logger: silent })

    expect(res.refreshed).toBe(0)
    expect(res.migrated).toBe(1) // still migrated, just not re-extracted
  })

  it('can be told to skip re-extraction entirely', async () => {
    raw.scrollAllRaw.mockResolvedValue([point('old', { keywords: [], tags: [] })])

    await migrateCollection({ from: 'src', to: 'dst', dryRun: false, refreshFields: false, logger: silent })
    expect(constructNote).not.toHaveBeenCalled()
  })
})

describe('migrateCollection — refusals', () => {
  it('refuses when source and target are the same', async () => {
    await expect(migrateCollection({ from: 'same', to: 'same', logger: silent })).rejects.toThrow(/same collection/)
  })

  it('refuses when the source does not exist', async () => {
    raw.collectionDimRaw.mockResolvedValue(null)
    await expect(migrateCollection({ from: 'nope', to: 'dst', logger: silent })).rejects.toThrow(/does not exist/)
  })

  it('refuses a target that already holds points', async () => {
    // A non-empty target means the name is probably wrong, and mixing two stores
    // together is not undone by pointing a config back.
    raw.collectionDimRaw.mockImplementation(async (c: string) => (c === 'src' ? 384 : 3))
    raw.countPointsRaw.mockResolvedValue(7)

    await expect(migrateCollection({ from: 'src', to: 'dst', dryRun: false, logger: silent })).rejects.toThrow(
      /already holds 7 point/
    )
  })

  it('refuses a target whose width does not match the model', async () => {
    raw.collectionDimRaw.mockImplementation(async (c: string) => (c === 'src' ? 384 : 999))

    await expect(migrateCollection({ from: 'src', to: 'dst', dryRun: false, logger: silent })).rejects.toThrow(
      /exists at 999d/
    )
  })
})

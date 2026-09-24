import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/llm.js', () => ({
  llmConstructNote: vi.fn(),
  llmShouldLink: vi.fn(),
  llmEvolveNote: vi.fn(),
  llmShouldMerge: vi.fn(),
  llmEvolutionJudge: vi.fn(),
  llmConflictScan: vi.fn(),
}))
vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(),
  cosineSimilarity: () => 0,
}))

import { mergeSimilarNotes } from '../../src/memory.js'
import type { StorageContext } from '../../src/storage.js'

function makeCtx() {
  return { getNotesByDatePrefix: vi.fn(async () => []) } as unknown as StorageContext & {
    getNotesByDatePrefix: ReturnType<typeof vi.fn>
  }
}

afterEach(() => vi.useRealTimers())

// The merge moved out of agent_end into a nightly job, which runs after local midnight
// and has to reach back to the UTC day that just ended. Notes are dated in UTC.
describe('mergeSimilarNotes date', () => {
  it('reads the UTC day it is given', async () => {
    const ctx = makeCtx()
    await mergeSimilarNotes('dev', ctx, '2026-09-24')
    expect(ctx.getNotesByDatePrefix).toHaveBeenCalledWith('2026-09-24', 'dev')
  })

  it('defaults to the current UTC day, not the local one', async () => {
    vi.useFakeTimers()
    // 02:30 on the 25th in UTC+8 is still the 24th in UTC.
    vi.setSystemTime(new Date('2026-09-24T18:30:00.000Z'))
    const ctx = makeCtx()
    await mergeSimilarNotes('main', ctx)
    expect(ctx.getNotesByDatePrefix).toHaveBeenCalledWith('2026-09-24', 'main')
  })
})

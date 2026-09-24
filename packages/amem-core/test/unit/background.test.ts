import { describe, it, expect, vi, afterEach } from 'vitest'

// The nightly job shares the gateway, the API key and the notes with the user's runs. Once
// a run starts, the job's next LLM call, at any depth, stops the step it is in. Calls that
// belong to the run itself never stop.

const { anthropicCreate, cosine } = vi.hoisted(() => ({ anthropicCreate: vi.fn(), cosine: vi.fn(() => 0.9) }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
  },
}))
vi.mock('openai', () => ({ default: class {} }))
vi.mock('../../src/embedding.js', () => ({
  encode: vi.fn(async () => [1, 0]),
  cosineSimilarity: cosine,
}))

async function load() {
  vi.resetModules()
  vi.stubEnv('ANTHROPIC_API_KEY', 'k')
  const config = await import('../../src/config.js')
  config.configure({ warn: vi.fn() })
  const llm = await import('../../src/llm.js')
  const background = await import('../../src/background.js')
  const memory = await import('../../src/memory.js')
  return { llm, memory, ...background }
}

const MERGE_NO = { content: [{ type: 'text', text: '{"shouldMerge": false}' }] }
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

afterEach(() => {
  anthropicCreate.mockReset()
  cosine.mockClear()
  vi.unstubAllEnvs()
})

describe('runInBackground', () => {
  it('stops a call made deep inside the job while the host is busy, before it reaches the API', async () => {
    const { llm, runInBackground, BackgroundPreempted } = await load()
    anthropicCreate.mockResolvedValue(MERGE_NO)

    const job = runInBackground(
      () => true,
      () => llm.llmShouldMerge('a', 'b')
    )

    await expect(job).rejects.toBeInstanceOf(BackgroundPreempted)
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('checks before each call, so a run that starts partway stops the next call', async () => {
    const { llm, runInBackground, BackgroundPreempted } = await load()
    anthropicCreate.mockResolvedValue(MERGE_NO)
    let busy = false

    const job = runInBackground(
      () => busy,
      async () => {
        await llm.llmShouldMerge('a', 'b')
        busy = true
        await tick() // the store survives timers as well as awaits
        await llm.llmShouldMerge('c', 'd')
      }
    )

    await expect(job).rejects.toBeInstanceOf(BackgroundPreempted)
    expect(anthropicCreate).toHaveBeenCalledTimes(1)
  })

  it('never stops a call made outside it, such as one made by the run', async () => {
    const { llm, runInBackground } = await load()
    anthropicCreate.mockResolvedValue(MERGE_NO)

    const background = runInBackground(
      () => true,
      () => llm.llmShouldMerge('a', 'b')
    ).catch(() => {})
    await llm.llmShouldMerge('c', 'd')
    await background

    expect(anthropicCreate).toHaveBeenCalledTimes(1)
  })

  it('reaches through the conflict scan instead of reading as a batch with no answer', async () => {
    const { llm, runInBackground, BackgroundPreempted } = await load()

    const job = runInBackground(
      () => true,
      () => llm.llmConflictScan(['x', 'y'])
    )

    await expect(job).rejects.toBeInstanceOf(BackgroundPreempted)
  })
})

describe('pauseForForeground', () => {
  it('does nothing outside the job', async () => {
    const { pauseForForeground } = await load()
    await expect(pauseForForeground()).resolves.toBeUndefined()
  })

  it('lets the event loop run inside the job, and stops once the host is busy', async () => {
    const { runInBackground, pauseForForeground, BackgroundPreempted } = await load()
    let ranBetween = false
    let busy = false

    await runInBackground(
      () => busy,
      async () => {
        setImmediate(() => (ranBetween = true))
        await pauseForForeground()
      }
    )
    expect(ranBetween).toBe(true)

    busy = true
    await expect(runInBackground(() => busy, pauseForForeground)).rejects.toBeInstanceOf(BackgroundPreempted)
  })
})

describe('a stopped step leaves the notes as they were', () => {
  const note = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    content: `note ${id}`,
    keywords: [],
    tags: [],
    context: '',
    embedding: [1, 0],
    links: [],
    agent_id: 'main',
    timestamp: '2026-09-24T10:00:00.000Z',
    category: 'Personal',
    note_type: 'memory',
    pending_merge: false,
    ...over,
  })

  it('does not clear pending_merge on a note whose evolution judgment it never made', async () => {
    // A skipped judgment reads as NEW, which clears the flag for good. A stop must not.
    const { memory, runInBackground, BackgroundPreempted } = await load()
    const ctx = {
      getNotesByDatePrefix: vi.fn(async () => [note('p', { pending_merge: true }), note('q')]),
      patchNotePayload: vi.fn(async () => {}),
      updateNoteContent: vi.fn(async () => {}),
      deleteNote: vi.fn(async () => {}),
    }

    const job = runInBackground(
      () => true,
      () => memory.mergeSimilarNotes('main', ctx as never, '2026-09-24')
    )

    await expect(job).rejects.toBeInstanceOf(BackgroundPreempted)
    expect(ctx.patchNotePayload).not.toHaveBeenCalled()
    expect(ctx.deleteNote).not.toHaveBeenCalled()
  })

  it('does not clear pending_merge on a note with no neighbour once the host is busy', async () => {
    // The one nightly write that follows no LLM call, so it has its own check.
    const { memory, runInBackground, BackgroundPreempted } = await load()
    const ctx = {
      getNotesByDatePrefix: vi.fn(async () => [note('p', { pending_merge: true })]),
      patchNotePayload: vi.fn(async () => {}),
    }

    const job = runInBackground(
      () => true,
      () => memory.mergeSimilarNotes('main', ctx as never, '2026-09-24')
    )

    await expect(job).rejects.toBeInstanceOf(BackgroundPreempted)
    expect(ctx.patchNotePayload).not.toHaveBeenCalled()
  })

  it('stops after a call during which a run came and went, before writing from its answer', async () => {
    // Checked only before each call, a short run between two checks would go unseen, and
    // the step would merge from what it read before that run wrote.
    const { memory, runInBackground, BackgroundPreempted } = await load()
    let busy = false
    anthropicCreate.mockImplementation(async () => {
      busy = true // the host saw activity while the call was out
      return { content: [{ type: 'text', text: '{"type": "EVOLVE", "mergedContent": "p + q"}' }] }
    })
    const ctx = {
      getNotesByDatePrefix: vi.fn(async () => [note('p', { pending_merge: true }), note('q')]),
      patchNotePayload: vi.fn(async () => {}),
      updateNoteContent: vi.fn(async () => {}),
      deleteNote: vi.fn(async () => {}),
    }

    const job = runInBackground(
      () => busy,
      () => memory.mergeSimilarNotes('main', ctx as never, '2026-09-24')
    )

    await expect(job).rejects.toBeInstanceOf(BackgroundPreempted)
    expect(anthropicCreate).toHaveBeenCalledTimes(1)
    expect(ctx.updateNoteContent).not.toHaveBeenCalled()
    expect(ctx.deleteNote).not.toHaveBeenCalled()
  })

  it('stops consolidation inside the similarity loop, which blocks the event loop', async () => {
    const { memory, runInBackground, BackgroundPreempted } = await load()
    const ctx = {
      listNotes: vi.fn(async () => [note('a'), note('b'), note('c')]),
      updateNote: vi.fn(async () => {}),
      invalidateNote: vi.fn(async () => true),
      replaceLinkReferences: vi.fn(async () => {}),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const job = runInBackground(
      () => true,
      () => memory.consolidateMemories('main', logger, ctx as never)
    )

    await expect(job).rejects.toBeInstanceOf(BackgroundPreempted)
    expect(cosine).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(ctx.updateNote).not.toHaveBeenCalled()
  })
})

/**
 * Story 43 — the batched contradiction scan. Synthetic notes only.
 *
 * The point of scanning a batch WHOLE rather than pairwise is to catch
 * contradictions the engine's similarity gate structurally cannot: "is
 * vegetarian" and "loved the steak" sit far apart in embedding space.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { anthropicCreate } = vi.hoisted(() => ({ anthropicCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
    constructor() {}
  },
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: vi.fn() } }
    constructor() {}
  },
}))

async function loadLlm(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v ?? '')
  return import('../../src/llm.js')
}

const reply = (text: string) => ({ content: [{ type: 'text', text }] })

const THREE = ['user is vegetarian', 'user prefers dark mode', 'user loved the steak last night']

beforeEach(() => anthropicCreate.mockReset())
afterEach(() => vi.unstubAllEnvs())

describe('llmConflictScan', () => {
  it('returns the pair the model reports, with its reason', async () => {
    anthropicCreate.mockResolvedValue(reply('[{"a":0,"b":2,"reason":"diet: vegetarian vs ate steak"}]'))
    const { llmConflictScan } = await loadLlm()

    const pairs = await llmConflictScan(THREE)

    expect(pairs).toEqual([{ a: 0, b: 2, reason: 'diet: vegetarian vs ate steak', supersededIndex: null }])
  })

  it('sends the whole batch in one numbered prompt, not pairwise', async () => {
    anthropicCreate.mockResolvedValue(reply('[]'))
    const { llmConflictScan } = await loadLlm()

    await llmConflictScan(THREE)

    // One call for three notes — pairwise would be three.
    expect(anthropicCreate).toHaveBeenCalledOnce()
    const prompt = anthropicCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toContain('[0] user is vegetarian')
    expect(prompt).toContain('[2] user loved the steak last night')
  })

  it('runs on the strong tier', async () => {
    anthropicCreate.mockResolvedValue(reply('[]'))
    const { llmConflictScan } = await loadLlm({ AMEM_LLM_MODEL: 'cheap-1', AMEM_LLM_STRONG_MODEL: 'strong-1' })

    await llmConflictScan(THREE)
    expect(anthropicCreate.mock.calls[0][0].model).toBe('strong-1')
  })

  it('drops a hallucinated out-of-range index instead of mis-targeting a note', async () => {
    // The Story 41 lesson: a bad index must never reach a real memory.
    anthropicCreate.mockResolvedValue(reply('[{"a":0,"b":99,"reason":"nonsense"}]'))
    const { llmConflictScan } = await loadLlm()

    expect(await llmConflictScan(THREE)).toEqual([])
  })

  it('drops a self-pair and de-duplicates a repeated pair', async () => {
    anthropicCreate.mockResolvedValue(
      reply('[{"a":1,"b":1,"reason":"self"},{"a":0,"b":2,"reason":"x"},{"a":2,"b":0,"reason":"same again"}]')
    )
    const { llmConflictScan } = await loadLlm()

    const pairs = await llmConflictScan(THREE)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ a: 0, b: 2 })
  })

  it('returns nothing when the model finds no contradiction', async () => {
    anthropicCreate.mockResolvedValue(reply('[]'))
    const { llmConflictScan } = await loadLlm()
    expect(await llmConflictScan(THREE)).toEqual([])
  })

  it('degrades to nothing on unparseable output rather than throwing', async () => {
    anthropicCreate.mockResolvedValue(reply('I could not do that.'))
    const { llmConflictScan } = await loadLlm()
    expect(await llmConflictScan(THREE)).toEqual([])
  })

  it('tolerates a <think> block around the array', async () => {
    anthropicCreate.mockResolvedValue(reply('<think>comparing [0] and [2]…</think>\n[{"a":0,"b":2,"reason":"r"}]'))
    const { llmConflictScan } = await loadLlm()
    expect(await llmConflictScan(THREE)).toHaveLength(1)
  })

  it('never calls the model for a batch too small to contain a pair', async () => {
    const { llmConflictScan } = await loadLlm()
    expect(await llmConflictScan(['only one'])).toEqual([])
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('instructs the model that additive facts are NOT contradictions', async () => {
    // The documented Memory-R1 failure: a second dog read as contradicting the
    // first. The prompt must name this, or the sweep manufactures conflicts.
    anthropicCreate.mockResolvedValue(reply('[]'))
    const { llmConflictScan } = await loadLlm()

    await llmConflictScan(THREE)
    const prompt = anthropicCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toMatch(/Additive facts/i)
    expect(prompt).toContain('Scout')
  })
})

describe('llmConflictScan — the superseded marker', () => {
  it('carries through a superseded index that names one side of the pair', async () => {
    anthropicCreate.mockResolvedValue(reply('[{"a":0,"b":2,"superseded":0,"reason":"r"}]'))
    const { llmConflictScan } = await loadLlm()

    expect((await llmConflictScan(THREE))[0].supersededIndex).toBe(0)
  })

  it('treats a superseded index outside the pair as unknown, not as a target', async () => {
    // Naming a third note is not an answer about THIS pair. Accepting it would
    // retire a memory the model was not even talking about.
    anthropicCreate.mockResolvedValue(reply('[{"a":0,"b":2,"superseded":1,"reason":"r"}]'))
    const { llmConflictScan } = await loadLlm()

    expect((await llmConflictScan(THREE))[0].supersededIndex).toBeNull()
  })

  it('accepts an explicit null as "cannot tell"', async () => {
    anthropicCreate.mockResolvedValue(reply('[{"a":0,"b":2,"superseded":null,"reason":"r"}]'))
    const { llmConflictScan } = await loadLlm()

    expect((await llmConflictScan(THREE))[0].supersededIndex).toBeNull()
  })

  it('asks the model to judge from wording, and warns the list is not chronological', async () => {
    anthropicCreate.mockResolvedValue(reply('[]'))
    const { llmConflictScan } = await loadLlm()

    await llmConflictScan(THREE)
    const prompt = anthropicCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toMatch(/NOT listed in chronological order/i)
    expect(prompt).toMatch(/used to|back in/i)
  })
})

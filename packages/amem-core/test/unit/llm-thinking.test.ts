/**
 * #158 — fast-tier calls turn thinking off, and fall back for a model that refuses.
 *
 * Mocked SDKs, synthetic prompts. The relay these numbers came from added thinking to
 * claude-haiku-4-5 unasked; Opus 5.5 and Fable answer thinking disabled with a 400.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { anthropicCreate, openaiCreate } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
  },
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } }
  },
}))

async function load(env: Record<string, string> = {}) {
  vi.resetModules()
  vi.stubEnv('ANTHROPIC_API_KEY', 'k')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const config = await import('../../src/config.js')
  const sink = vi.fn()
  config.configure({ warn: sink })
  const llm = await import('../../src/llm.js')
  return { ...llm, sink }
}

const reply = (text: string) => ({ content: [{ type: 'text', text }] })
const refused = () =>
  Object.assign(new Error('400 "thinking.type.disabled" is not supported for this model.'), { status: 400 })
const bodies = () => anthropicCreate.mock.calls.map((c) => c[0])

beforeEach(() => {
  anthropicCreate.mockReset()
  openaiCreate.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('thinking on the fast tier', () => {
  it('turns it off on a fast call to the Anthropic API', async () => {
    anthropicCreate.mockResolvedValue(reply('yes'))
    const { llmCall } = await load()

    expect(await llmCall('related?', 16, 'fast')).toBe('yes')
    expect(bodies()[0]).toMatchObject({ max_tokens: 16, thinking: { type: 'disabled' } })
  })

  it('leaves the strong tier alone, and sends nothing when set to auto', async () => {
    anthropicCreate.mockResolvedValue(reply('ok'))
    const { llmCall, configureLlm } = await load()

    await llmCall('judge', 300, 'strong')
    configureLlm({ thinking: 'auto' })
    await llmCall('related?', 16, 'fast')

    for (const body of bodies()) expect(body).not.toHaveProperty('thinking')
  })

  it('lets AMEM_LLM_THINKING win over the host setting', async () => {
    anthropicCreate.mockResolvedValue(reply('ok'))
    const { llmCall, configureLlm } = await load({ AMEM_LLM_THINKING: 'auto' })

    configureLlm({ thinking: 'off' })
    await llmCall('related?', 16, 'fast')

    expect(bodies()[0]).not.toHaveProperty('thinking')
  })

  it('never sends a thinking or reasoning field on the OpenAI path', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'yes' } }] })
    const { llmCall } = await load({ AMEM_LLM_PROVIDER: 'openai' })

    await llmCall('related?', 16, 'fast')

    const body = openaiCreate.mock.calls[0][0]
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('treats an unknown value as off, and says so once', async () => {
    anthropicCreate.mockResolvedValue(reply('ok'))
    const { llmCall, sink } = await load({ AMEM_LLM_THINKING: 'none' })

    await llmCall('a', 16, 'fast')
    await llmCall('b', 16, 'fast')

    expect(bodies()[0]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(sink.mock.calls.filter((c) => String(c[0]).includes('AMEM_LLM_THINKING'))).toHaveLength(1)
  })
})

describe('a model that refuses thinking disabled', () => {
  it('is asked again without the field, and remembered, so it pays the 400 once', async () => {
    anthropicCreate.mockRejectedValueOnce(refused()).mockResolvedValue(reply('yes'))
    const { llmCall, sink } = await load({ AMEM_LLM_MODEL: 'claude-opus-5-5' })

    expect(await llmCall('related?', 16, 'fast')).toBe('yes')
    expect(await llmCall('related again?', 16, 'fast')).toBe('yes')

    expect(anthropicCreate).toHaveBeenCalledTimes(3)
    const [first, retry, next] = bodies()
    expect(first).toHaveProperty('thinking')
    for (const body of [retry, next]) {
      expect(body).not.toHaveProperty('thinking')
      // Room for the thinking it will do, or its answer may never start.
      expect(body.max_tokens).toBeGreaterThanOrEqual(4000)
    }
    expect(sink.mock.calls.filter((c) => String(c[0]).includes('refused thinking disabled'))).toHaveLength(1)
  })

  it('is not remembered when the second request fails too, because the 400 had another cause', async () => {
    anthropicCreate.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused()).mockResolvedValue(reply('yes'))
    const { llmCall } = await load()

    expect(await llmCall('related?', 16, 'fast')).toBeNull()
    await llmCall('related again?', 16, 'fast')

    expect(bodies()[2]).toMatchObject({ max_tokens: 16, thinking: { type: 'disabled' } })
  })

  it('is not asked again after an error that is not a 400', async () => {
    anthropicCreate.mockRejectedValueOnce(Object.assign(new Error('529 overloaded'), { status: 529 }))
    const { llmCall } = await load()

    expect(await llmCall('related?', 16, 'fast')).toBeNull()
    expect(anthropicCreate).toHaveBeenCalledTimes(1)
  })

  it('is not asked again when the deadline leaves no room for a call', async () => {
    anthropicCreate.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      throw refused()
    })
    const { llmCall } = await load()

    // 3.1 s at the start clears the 3 s floor; 200 ms later it does not.
    expect(await llmCall('related?', 16, 'fast', { deadline: Date.now() + 3100 })).toBeNull()
    expect(anthropicCreate).toHaveBeenCalledTimes(1)
  })
})

describe('room for a model that may think', () => {
  // With too few output tokens, thinking can use them all and leave no answer, and a
  // missing evolution judgment reads as NEW, which clears pending_merge.

  it('is given on the strong tier, which does not turn thinking off', async () => {
    anthropicCreate.mockResolvedValue(reply('{"type": "NEW"}'))
    const { llmEvolutionJudge } = await load({ AMEM_LLM_STRONG_MODEL: 'claude-opus-5-5' })

    await llmEvolutionJudge('old', 'new')

    expect(bodies()[0].max_tokens).toBeGreaterThanOrEqual(4000)
    expect(bodies()[0]).not.toHaveProperty('thinking')
  })

  it('is given to a fast call when thinking is left on', async () => {
    anthropicCreate.mockResolvedValue(reply('yes'))
    const { llmCall } = await load({ AMEM_LLM_THINKING: 'auto' })

    await llmCall('related?', 16, 'fast')

    expect(bodies()[0].max_tokens).toBe(4000)
  })

  it('is not needed once thinking is off', async () => {
    anthropicCreate.mockResolvedValue(reply('yes'))
    const { llmCall } = await load()

    await llmCall('related?', 16, 'fast')

    expect(bodies()[0].max_tokens).toBe(16)
  })

  it("is given to OpenAI's reasoning models, and not to the others", async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'yes' } }] })
    const reasoning = await load({ AMEM_LLM_PROVIDER: 'openai', AMEM_LLM_MODEL: 'gpt-5' })
    await reasoning.llmCall('related?', 16, 'fast')
    const plain = await load({ AMEM_LLM_PROVIDER: 'openai', AMEM_LLM_MODEL: 'gpt-4o-mini' })
    await plain.llmCall('related?', 16, 'fast')

    const [first, second] = openaiCreate.mock.calls.map((c) => c[0])
    expect(first.max_completion_tokens).toBe(4000)
    expect(second.max_tokens).toBe(16)
  })
})

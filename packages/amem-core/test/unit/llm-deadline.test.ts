import { describe, it, expect, vi, afterEach } from 'vitest'
import { hasTimeFor, MIN_CALL_MS } from '../../src/deadline.js'

// agent_end has a 30 s budget the host stops waiting at, without cancelling the work.
// A call inside it must get the time left, and must not be retried: both SDKs retry twice
// by default and retry a timeout too, so one slow call could run to three timeouts.

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

async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const config = await import('../../src/config.js')
  const sink = vi.fn()
  config.configure({ warn: sink })
  return { llm: await import('../../src/llm.js'), sink }
}

const TEXT = { content: [{ type: 'text', text: 'yes' }] }
const CHAT = { choices: [{ message: { content: 'yes' } }] }

afterEach(() => {
  anthropicCreate.mockReset()
  openaiCreate.mockReset()
  vi.unstubAllEnvs()
})

describe('hasTimeFor', () => {
  it('always has time without a deadline', () => {
    expect(hasTimeFor(undefined)).toBe(true)
  })

  it('needs MIN_CALL_MS left to start a call', () => {
    expect(hasTimeFor(Date.now() + MIN_CALL_MS + 1000)).toBe(true)
    expect(hasTimeFor(Date.now() + MIN_CALL_MS - 1000)).toBe(false)
    expect(hasTimeFor(Date.now() - 1)).toBe(false)
  })
})

describe('llmCall with a deadline', () => {
  it('sends no per-request limits without one, so background work keeps its retries', async () => {
    const { llm } = await load({ ANTHROPIC_API_KEY: 'k' })
    anthropicCreate.mockResolvedValueOnce(TEXT)
    await llm.llmCall('hi')
    expect(anthropicCreate.mock.calls[0][1]).toBeUndefined()
  })

  it('gives an Anthropic call the time left and no retries', async () => {
    const { llm } = await load({ ANTHROPIC_API_KEY: 'k' })
    anthropicCreate.mockResolvedValueOnce(TEXT)
    await llm.llmCall('hi', 10, 'fast', { deadline: Date.now() + 20_000 })
    const limits = anthropicCreate.mock.calls[0][1]
    expect(limits.maxRetries).toBe(0)
    expect(limits.timeout).toBeLessThanOrEqual(20_000)
    expect(limits.timeout).toBeGreaterThan(15_000)
  })

  it('does the same on the OpenAI path', async () => {
    const { llm } = await load({ AMEM_LLM_PROVIDER: 'openai' })
    openaiCreate.mockResolvedValueOnce(CHAT)
    await llm.llmCall('hi', 10, 'fast', { deadline: Date.now() + 20_000 })
    expect(openaiCreate.mock.calls[0][1]).toMatchObject({ maxRetries: 0 })
  })

  it('never lengthens a configured timeout that is shorter than the time left', async () => {
    const { llm } = await load({ ANTHROPIC_API_KEY: 'k', AMEM_LLM_TIMEOUT: '5000' })
    anthropicCreate.mockResolvedValueOnce(TEXT)
    await llm.llmCall('hi', 10, 'fast', { deadline: Date.now() + 20_000 })
    expect(anthropicCreate.mock.calls[0][1].timeout).toBe(5000)
  })

  it('does not start a call it cannot finish, and says so', async () => {
    const { llm, sink } = await load({ ANTHROPIC_API_KEY: 'k' })
    expect(await llm.llmCall('hi', 10, 'fast', { deadline: Date.now() + 1000 })).toBeNull()
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(String(sink.mock.calls[0][0])).toContain('skipped an LLM call')
  })

  it('passes the deadline through the per-turn task functions', async () => {
    const { llm } = await load({ ANTHROPIC_API_KEY: 'k' })
    anthropicCreate.mockResolvedValue(TEXT)
    const deadline = Date.now() + 20_000
    await llm.llmShouldLink('a', 'b', { deadline })
    await llm.llmCrudDecision('u', 'a', [], { deadline })
    for (const call of anthropicCreate.mock.calls) expect(call[1]).toMatchObject({ maxRetries: 0 })
  })
})

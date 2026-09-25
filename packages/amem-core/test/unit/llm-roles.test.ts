/**
 * Story 42 — the fast/strong tier split.
 *
 * Drives the real task functions with mocked SDKs, so these assert which model
 * and endpoint each call actually reaches, not an internal resolver.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { anthropicCreate, openaiCreate, AnthropicCtor, OpenAICtor } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
  AnthropicCtor: vi.fn(),
  OpenAICtor: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
    constructor(opts: unknown) {
      AnthropicCtor(opts)
    }
  },
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } }
    constructor(opts: unknown) {
      OpenAICtor(opts)
    }
  },
}))

async function loadLlm(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v ?? '')
  return import('../../src/llm.js')
}

const asAnthropic = (text: string) => ({ content: [{ type: 'text', text }] })
const MERGE_JSON = JSON.stringify({ shouldMerge: false })
const NOTE_JSON = JSON.stringify({
  keywords: ['k'],
  tags: [],
  context: '',
  category: 'General',
  note_type: 'memory',
  topics: [],
  confidence: 'high',
})

/** Model names seen by the Anthropic mock, in call order. */
const modelsUsed = () => anthropicCreate.mock.calls.map((c) => c[0].model)

beforeEach(() => {
  anthropicCreate.mockReset()
  openaiCreate.mockReset()
  AnthropicCtor.mockReset()
  OpenAICtor.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('call → role routing', () => {
  it('runs extraction and linking on fast, merge and evolution-judge on strong', async () => {
    anthropicCreate.mockImplementation(async (a: { model: string; max_tokens: number }) =>
      asAnthropic(a.model === 'strong-1' ? MERGE_JSON : a.max_tokens === 10 ? 'no' : NOTE_JSON)
    )
    const llm = await loadLlm({ AMEM_LLM_MODEL: 'cheap-1', AMEM_LLM_STRONG_MODEL: 'strong-1' })

    await llm.llmConstructNote('x')
    await llm.llmShouldLink('a', 'b')
    await llm.llmShouldMerge('a', 'b')
    await llm.llmEvolutionJudge('a', 'b')

    expect(modelsUsed()).toEqual(['cheap-1', 'cheap-1', 'strong-1', 'strong-1'])
  })

  it('puts the CRUD decision on fast by default', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic('[]'))
    const llm = await loadLlm({ AMEM_LLM_MODEL: 'cheap-1', AMEM_LLM_STRONG_MODEL: 'strong-1' })

    await llm.llmCrudDecision('u', 'a', [])
    expect(modelsUsed()).toEqual(['cheap-1'])
  })

  it('moves the CRUD decision to strong when asked', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic('[]'))
    const llm = await loadLlm({
      AMEM_LLM_MODEL: 'cheap-1',
      AMEM_LLM_STRONG_MODEL: 'strong-1',
      AMEM_LLM_CRUD_ROLE: 'strong',
    })

    await llm.llmCrudDecision('u', 'a', [])
    expect(modelsUsed()).toEqual(['strong-1'])
  })

  it('falls back to fast on an unrecognised crud role', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic('[]'))
    const llm = await loadLlm({
      AMEM_LLM_MODEL: 'cheap-1',
      AMEM_LLM_STRONG_MODEL: 'strong-1',
      AMEM_LLM_CRUD_ROLE: 'nonsense',
    })

    await llm.llmCrudDecision('u', 'a', [])
    expect(modelsUsed()).toEqual(['cheap-1'])
  })
})

describe('strong falls back to fast per field', () => {
  it('uses the fast model for strong calls when no strong model is set — zero regression', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic(MERGE_JSON))
    const llm = await loadLlm({ AMEM_LLM_MODEL: 'only-1', AMEM_LLM_STRONG_MODEL: undefined })

    await llm.llmShouldMerge('a', 'b')
    expect(modelsUsed()).toEqual(['only-1'])
  })

  it('keeps the fast provider and endpoint when only a strong MODEL is set', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: MERGE_JSON } }] })
    const llm = await loadLlm({
      AMEM_LLM_PROVIDER: 'openai',
      AMEM_LLM_BASE_URL: 'http://shared.local/v1',
      AMEM_LLM_STRONG_MODEL: 'strong-1',
    })

    await llm.llmShouldMerge('a', 'b')

    expect(openaiCreate.mock.calls[0][0].model).toBe('strong-1')
    expect(OpenAICtor.mock.calls[0][0]).toMatchObject({ baseURL: 'http://shared.local/v1' })
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('runs the two tiers on entirely different backends when all strong fields are set', async () => {
    // The case the shared-config design would have made impossible: a local
    // OpenAI-compatible server for fast, a hosted Anthropic API for strong.
    anthropicCreate.mockResolvedValue(asAnthropic(MERGE_JSON))
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: NOTE_JSON } }] })
    const llm = await loadLlm({
      AMEM_LLM_PROVIDER: 'openai',
      AMEM_LLM_MODEL: 'local-1',
      AMEM_LLM_BASE_URL: 'http://localhost:11434/v1',
      AMEM_LLM_STRONG_PROVIDER: 'anthropic',
      AMEM_LLM_STRONG_MODEL: 'big-1',
      AMEM_LLM_STRONG_BASE_URL: 'https://api.example.com',
    })

    await llm.llmConstructNote('x') // fast  → openai @ localhost
    await llm.llmShouldMerge('a', 'b') // strong → anthropic @ example.com

    expect(openaiCreate.mock.calls[0][0].model).toBe('local-1')
    expect(OpenAICtor.mock.calls[0][0]).toMatchObject({ baseURL: 'http://localhost:11434/v1' })
    expect(anthropicCreate.mock.calls[0][0].model).toBe('big-1')
    expect(AnthropicCtor.mock.calls[0][0]).toMatchObject({ baseURL: 'https://api.example.com' })
  })
})

describe('client cache is keyed by endpoint', () => {
  it('builds one client per distinct base URL, not one per call', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic(MERGE_JSON))
    const llm = await loadLlm({
      AMEM_LLM_MODEL: 'cheap-1',
      AMEM_LLM_BASE_URL: 'https://fast.example.com',
      AMEM_LLM_STRONG_MODEL: 'strong-1',
      AMEM_LLM_STRONG_BASE_URL: 'https://strong.example.com',
    })

    await llm.llmConstructNote('x')
    await llm.llmConstructNote('y') // same endpoint → reuses the client
    await llm.llmShouldMerge('a', 'b') // different endpoint → its own client

    expect(AnthropicCtor).toHaveBeenCalledTimes(2)
    const urls = AnthropicCtor.mock.calls.map((c) => c[0].baseURL)
    expect(urls).toEqual(['https://fast.example.com', 'https://strong.example.com'])
  })
})

describe('configureLlm carries the strong tier', () => {
  it('accepts a host-injected strong tier, with env still winning', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic(MERGE_JSON))
    const llm = await loadLlm({
      AMEM_LLM_MODEL: undefined,
      AMEM_LLM_STRONG_MODEL: undefined,
    })

    llm.configureLlm({ model: 'cfg-fast', strong: { model: 'cfg-strong' } })
    await llm.llmShouldMerge('a', 'b')
    expect(modelsUsed()).toEqual(['cfg-strong'])
  })
})

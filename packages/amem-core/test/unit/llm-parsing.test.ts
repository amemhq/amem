/**
 * Story 40 — LLM response-parsing hardening (mem0 取经).
 *
 * Drives the real note-construction / CRUD functions with mocked SDK clients, so
 * these assert end-to-end behaviour (a good response must parse), not a private
 * helper. Synthetic responses only.
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

/** Wrap text as an Anthropic text-block response (the default provider path). */
const asAnthropic = (text: string) => ({ content: [{ type: 'text', text }] })

const VALID_NOTE_JSON = JSON.stringify({
  keywords: ['qdrant', 'vector'],
  tags: ['db'],
  context: 'a note about vector search',
  category: 'Technical',
  note_type: 'memory',
  topics: [],
  confidence: 'high',
})

beforeEach(() => {
  anthropicCreate.mockReset()
  openaiCreate.mockReset()
  AnthropicCtor.mockReset()
  OpenAICtor.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('① strip <think> blocks and special tokens before JSON.parse', () => {
  it('parses when the reasoning block itself contains JSON-like braces', async () => {
    // The case brace-extraction alone cannot handle: a reasoning model drafts the
    // structure inside <think>, so the response has TWO brace regions. Greedy
    // extraction would span from the draft's `{` to the real `}` and fail —
    // stripping the block first is what makes the real object recoverable.
    anthropicCreate.mockResolvedValue(
      asAnthropic(`<think>I'll shape it as {"keywords": [...], "tags": [...]}</think>\n${VALID_NOTE_JSON}`)
    )
    const { llmConstructNote } = await loadLlm()

    const note = await llmConstructNote('Qdrant is a vector database')

    expect(note.keywords).toEqual(['qdrant', 'vector'])
    expect(note.category).toBe('Technical')
  })

  it('strips <think> on the CRUD array path when the reasoning contains brackets', async () => {
    // Same shape on the array path: `/\[.*\]/s` would otherwise span from the
    // bracket in the reasoning to the real array's closing bracket.
    const ops = JSON.stringify([{ action: 'NEW', fact: 'user likes tea' }])
    anthropicCreate.mockResolvedValue(asAnthropic(`<think>options are [keep, drop]</think>\n${ops}`))
    const { llmCrudDecision } = await loadLlm()

    const result = await llmCrudDecision('I like tea', 'noted', [])
    expect(result).toHaveLength(1)
    expect(result[0].action).toBe('NEW')
  })

  it('parses when the model appends a chat special token', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic(`${VALID_NOTE_JSON}<|eot_id|>`))
    const { llmConstructNote } = await loadLlm()

    const note = await llmConstructNote('x')
    expect(note.keywords).toEqual(['qdrant', 'vector'])
  })
})

describe('③ tolerate a preamble sentence before the JSON object', () => {
  it('recovers a note when the model prepends prose before the object', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic(`Sure! Here is the JSON you asked for:\n${VALID_NOTE_JSON}`))
    const { llmConstructNote } = await loadLlm()

    const note = await llmConstructNote('x')
    expect(note.keywords).toEqual(['qdrant', 'vector'])
  })

  it('still falls back gracefully when there is no JSON at all', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic('I could not do that.'))
    const { llmConstructNote } = await loadLlm()

    const note = await llmConstructNote('x')
    // No object anywhere → the safe blank default, never a throw.
    expect(note.keywords).toEqual([])
    expect(note.category).toBe('General')
  })
})

describe('④ configurable client timeout', () => {
  it('passes AMEM_LLM_TIMEOUT to the Anthropic client', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic(VALID_NOTE_JSON))
    const { llmConstructNote } = await loadLlm({ AMEM_LLM_TIMEOUT: '5000' })

    await llmConstructNote('x')
    expect(AnthropicCtor.mock.calls[0][0]).toMatchObject({ timeout: 5000 })
  })

  it('passes the default 30s timeout when unset', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: VALID_NOTE_JSON } }] })
    const { llmConstructNote } = await loadLlm({ AMEM_LLM_PROVIDER: 'openai' })

    await llmConstructNote('x')
    expect(OpenAICtor.mock.calls[0][0]).toMatchObject({ timeout: 30000 })
  })

  it('honours configureLlm({ timeoutMs }) when no env var is set', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic(VALID_NOTE_JSON))
    const { llmConstructNote, configureLlm } = await loadLlm({ AMEM_LLM_TIMEOUT: undefined })

    configureLlm({ timeoutMs: 12000 })
    await llmConstructNote('x')
    expect(AnthropicCtor.mock.calls[0][0]).toMatchObject({ timeout: 12000 })
  })
})

describe('CRUD about-speaker flag', () => {
  const ask = async (about: unknown, env: Record<string, string> = {}) => {
    const item: Record<string, unknown> = { action: 'NEW', fact: 'f' }
    if (about !== undefined) item.about = about
    anthropicCreate.mockResolvedValue(asAnthropic(JSON.stringify([item])))
    const { llmCrudDecision } = await loadLlm(env)
    return llmCrudDecision('I like tea a lot', 'noted', [], { speaker: true })
  }

  it('reads "world" as a general fact', async () => {
    expect((await ask('world'))[0].aboutSpeaker).toBe(false)
  })

  it('reads "speaker" as about the speaker', async () => {
    expect((await ask('speaker'))[0].aboutSpeaker).toBe(true)
  })

  it('treats a missing, invalid or uncertain answer as about the speaker', async () => {
    expect((await ask(undefined))[0].aboutSpeaker).toBe(true)
    expect((await ask('maybe'))[0].aboutSpeaker).toBe(true)
    expect((await ask(false))[0].aboutSpeaker).toBe(true)
  })

  it('sets no flag when the speaker question was not asked', async () => {
    anthropicCreate.mockResolvedValue(asAnthropic(JSON.stringify([{ action: 'NEW', fact: 'f', about: 'world' }])))
    const { llmCrudDecision } = await loadLlm()
    const ops = await llmCrudDecision('I like tea a lot', 'noted', [])
    expect(ops[0]).not.toHaveProperty('aboutSpeaker')
  })

  it.each(['en', 'zh'])('asks for the field only when there is a speaker (%s prompt)', async (locale) => {
    anthropicCreate.mockResolvedValue(asAnthropic('[]'))
    const { llmCrudDecision } = await loadLlm({ AMEM_PROMPT_LOCALE: locale })
    await llmCrudDecision('I like tea a lot', 'noted', [], { speaker: true })
    await llmCrudDecision('I like tea a lot', 'noted', [])
    const prompts = anthropicCreate.mock.calls.map((c) => c[0].system as string)
    expect(prompts[0]).toContain('"about"')
    expect(prompts[1]).not.toContain('"about"')
  })
})

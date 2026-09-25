import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LlmConfig } from '../../src/llm.js'

// Shared spies for both SDK clients. The engine constructs each client lazily,
// so these capture the constructor options and the create() calls.
const { anthropicCreate, openaiCreate, AnthropicCtor, OpenAICtor } = vi.hoisted(() => {
  const anthropicCreate = vi.fn()
  const openaiCreate = vi.fn()
  const AnthropicCtor = vi.fn()
  const OpenAICtor = vi.fn()
  return { anthropicCreate, openaiCreate, AnthropicCtor, OpenAICtor }
})

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

// Story 35 made provider/model resolve per call rather than at module load, but
// each case still re-imports fresh so the lazy client cache and the warn-once set
// start empty.
async function loadLlm(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '')
    else vi.stubEnv(k, v)
  }
  return import('../../src/llm.js')
}

beforeEach(() => {
  anthropicCreate.mockReset()
  openaiCreate.mockReset()
  AnthropicCtor.mockReset()
  OpenAICtor.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('llmCall provider dispatch', () => {
  it('defaults to Anthropic and returns the first text block', async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '  hi from claude  ' }] })
    const { llmCall } = await loadLlm({ AMEM_LLM_PROVIDER: undefined })

    const out = await llmCall('ping')

    expect(out).toBe('hi from claude')
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(openaiCreate).not.toHaveBeenCalled()
    const arg = anthropicCreate.mock.calls[0][0]
    expect(arg.model).toBe('claude-sonnet-4-6')
    expect(arg.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('routes to OpenAI chat.completions when AMEM_LLM_PROVIDER=openai', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: '  hi from gpt  ' } }] })
    const { llmCall } = await loadLlm({ AMEM_LLM_PROVIDER: 'openai' })

    const out = await llmCall('ping', 123)

    expect(out).toBe('hi from gpt')
    expect(openaiCreate).toHaveBeenCalledOnce()
    expect(anthropicCreate).not.toHaveBeenCalled()
    const arg = openaiCreate.mock.calls[0][0]
    expect(arg.model).toBe('gpt-4o-mini') // provider default
    expect(arg.max_tokens).toBe(123)
    expect(arg.max_completion_tokens).toBeUndefined()
    expect(arg.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('honours AMEM_LLM_BASE_URL and AMEM_LLM_API_KEY on the OpenAI client', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall } = await loadLlm({
      AMEM_LLM_PROVIDER: 'openai',
      AMEM_LLM_BASE_URL: 'http://localhost:11434/v1',
      AMEM_LLM_API_KEY: 'my-key',
    })

    await llmCall('ping')

    expect(OpenAICtor).toHaveBeenCalledOnce()
    expect(OpenAICtor.mock.calls[0][0]).toMatchObject({ apiKey: 'my-key', baseURL: 'http://localhost:11434/v1' })
  })

  it('falls back to a placeholder key so keyless local servers work', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall } = await loadLlm({
      AMEM_LLM_PROVIDER: 'openai',
      AMEM_LLM_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    })

    await llmCall('ping')

    expect(OpenAICtor.mock.calls[0][0].apiKey).toBe('sk-no-key-required')
  })

  it('honours the standard OPENAI_API_KEY when AMEM_LLM_API_KEY is unset', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall } = await loadLlm({
      AMEM_LLM_PROVIDER: 'openai',
      AMEM_LLM_API_KEY: undefined,
      OPENAI_API_KEY: 'sk-real-openai-key',
    })

    await llmCall('ping')

    // Passing the placeholder would block the SDK's own env fallback → 401 on every call.
    expect(OpenAICtor.mock.calls[0][0].apiKey).toBe('sk-real-openai-key')
  })

  it('uses max_completion_tokens for OpenAI reasoning models', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall } = await loadLlm({ AMEM_LLM_PROVIDER: 'openai', AMEM_LLM_MODEL: 'o3-mini' })

    await llmCall('ping', 200)

    const arg = openaiCreate.mock.calls[0][0]
    // Raised as well: reasoning counts against it (see llm-thinking.test.ts).
    expect(arg.max_completion_tokens).toBe(4000)
    expect(arg.max_tokens).toBeUndefined()
  })

  it('uses max_tokens (not max_completion_tokens) for deepseek-reasoner', async () => {
    // deepseek-reasoner is a reasoning model but DeepSeek's API takes max_tokens;
    // a broad includes('reason') match would send the wrong parameter.
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall } = await loadLlm({ AMEM_LLM_PROVIDER: 'openai', AMEM_LLM_MODEL: 'deepseek-reasoner' })

    await llmCall('ping', 200)

    const arg = openaiCreate.mock.calls[0][0]
    expect(arg.max_tokens).toBe(200)
    expect(arg.max_completion_tokens).toBeUndefined()
  })

  it('trims whitespace on AMEM_LLM_PROVIDER so "openai " still routes to OpenAI', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall } = await loadLlm({ AMEM_LLM_PROVIDER: 'openai ' })

    const out = await llmCall('ping')

    expect(out).toBe('ok')
    expect(openaiCreate).toHaveBeenCalledOnce()
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('returns null (not throw) when the provider call rejects', async () => {
    openaiCreate.mockRejectedValue(new Error('502 upstream'))
    const { llmCall } = await loadLlm({ AMEM_LLM_PROVIDER: 'openai' })

    const out = await llmCall('ping')

    expect(out).toBeNull()
  })
})

// ── Story 35 ──────────────────────────────────────────────────────────────────
describe('configureLlm — host-injected LLM settings', () => {
  const noEnv = { AMEM_LLM_PROVIDER: undefined, AMEM_LLM_MODEL: undefined, AMEM_LLM_BASE_URL: undefined }

  it('applies an injected model when no env var is set', async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const { llmCall, configureLlm } = await loadLlm(noEnv)

    configureLlm({ model: 'claude-opus-4-6' })
    await llmCall('ping')

    expect(anthropicCreate.mock.calls[0][0].model).toBe('claude-opus-4-6')
  })

  it('lets the env var win over an injected model', async () => {
    // The operator's override outranks whatever the host config asked for.
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const { llmCall, configureLlm } = await loadLlm({ ...noEnv, AMEM_LLM_MODEL: 'from-env' })

    configureLlm({ model: 'from-host-config' })
    await llmCall('ping')

    expect(anthropicCreate.mock.calls[0][0].model).toBe('from-env')
  })

  it('treats an empty env var as unset so it cannot shadow host config', async () => {
    // `AMEM_LLM_MODEL=` exported but blank must not outrank a real configured model.
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const { llmCall, configureLlm } = await loadLlm({ ...noEnv, AMEM_LLM_MODEL: '' })

    configureLlm({ model: 'from-host-config' })
    await llmCall('ping')

    expect(anthropicCreate.mock.calls[0][0].model).toBe('from-host-config')
  })

  it('switches provider, and picks that provider’s default model', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall, configureLlm } = await loadLlm(noEnv)

    configureLlm({ provider: 'openai' })
    await llmCall('ping')

    expect(openaiCreate).toHaveBeenCalledOnce()
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(openaiCreate.mock.calls[0][0].model).toBe('gpt-4o-mini')
  })

  it('passes an injected baseURL to the client', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall, configureLlm } = await loadLlm(noEnv)

    configureLlm({ provider: 'openai', baseURL: 'http://gateway.local/v1' })
    await llmCall('ping')

    expect(OpenAICtor.mock.calls[0][0]).toMatchObject({ baseURL: 'http://gateway.local/v1' })
  })

  it('rebuilds the client when the baseURL changes after a call', async () => {
    // The client captures baseURL at construction; a cached one would keep
    // talking to the old endpoint for the rest of the process.
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall, configureLlm } = await loadLlm(noEnv)

    configureLlm({ provider: 'openai', baseURL: 'http://first.local/v1' })
    await llmCall('ping')
    configureLlm({ provider: 'openai', baseURL: 'http://second.local/v1' })
    await llmCall('ping')

    expect(OpenAICtor).toHaveBeenCalledTimes(2)
    expect(OpenAICtor.mock.calls[1][0]).toMatchObject({ baseURL: 'http://second.local/v1' })
  })

  it('leaves untouched fields at their defaults', async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const { llmCall, configureLlm } = await loadLlm(noEnv)

    configureLlm({ baseURL: 'http://proxy.local' })
    await llmCall('ping')

    // Provider and model were not configured — the defaults still stand.
    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(anthropicCreate.mock.calls[0][0].model).toBe('claude-sonnet-4-6')
  })

  it('ignores an apiKey smuggled into the config object', async () => {
    // Deliberate: config arrives from a host config file, and honouring a key
    // field here would make the memory engine a channel for a user's gateway
    // credentials. TypeScript rejects the field; this pins the runtime too.
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] })
    const { llmCall, configureLlm } = await loadLlm({
      ...noEnv,
      AMEM_LLM_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    })

    configureLlm({ provider: 'openai', apiKey: 'sk-smuggled-from-host-config' } as LlmConfig)
    await llmCall('ping')

    expect(OpenAICtor.mock.calls[0][0].apiKey).toBe('sk-no-key-required')
  })
})

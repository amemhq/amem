/**
 * An endpoint that refuses every call as unauthenticated is reported as an error, not only
 * as one more warning. On 2026-10-28 a local proxy's Claude login expired, and six days of
 * 401s, one warning each, stored nothing before anyone noticed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// A plain function, not vi.fn: under vitest 4 a spy whose implementation rejects can fail a
// later test even though the code caught the rejection.
const sdk = vi.hoisted(() => ({ replies: [] as Array<() => Promise<unknown>> }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: () => (sdk.replies.length > 1 ? sdk.replies.shift()! : sdk.replies[0])() }
  },
}))

/** The SDK's answers in order; the last one repeats. */
const answers = (...replies: Array<() => Promise<unknown>>) => {
  sdk.replies = replies
}
const throws = (make: () => Error) => async () => {
  throw make()
}
const returns = (value: unknown) => async () => value
vi.mock('openai', () => ({ default: class {} }))

async function load(env: Record<string, string> = {}) {
  vi.resetModules()
  vi.stubEnv('ANTHROPIC_API_KEY', 'k')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const config = await import('../../src/config.js')
  const warn = vi.fn()
  const error = vi.fn()
  config.configure({ warn, error })
  const llm = await import('../../src/llm.js')
  return { ...llm, warn, error, config }
}

const reply = (text: string) => ({ content: [{ type: 'text', text }] })
const fail = (status: number, message: string) => Object.assign(new Error(message), { status })
const expired = () =>
  fail(401, '401 {"type":"error","error":{"type":"authentication_error","message":"Claude authentication expired"}}')
const relayed = () =>
  fail(500, '500 api_error: Claude Code returned an error result: Failed to authenticate. API Error: 403')
const overloaded = () => fail(529, '529 overloaded')
const alerts = (error: ReturnType<typeof vi.fn>) => error.mock.calls.map((c) => String(c[0]))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('an endpoint that refuses every call as unauthenticated', () => {
  it('is reported as an error on the third refusal in a row, with the last error', async () => {
    answers(throws(expired))
    const { llmCall, error } = await load({ AMEM_LLM_BASE_URL: 'http://127.0.0.1:3456' })

    await llmCall('a', 16)
    await llmCall('b', 16)
    expect(error).not.toHaveBeenCalled()
    await llmCall('c', 16)

    expect(alerts(error)).toHaveLength(1)
    expect(alerts(error)[0]).toContain(
      '3 LLM calls in a row to http://127.0.0.1:3456 (model claude-sonnet-4-6) failed authentication'
    )
    expect(alerts(error)[0]).toContain('turns are not captured')
    expect(alerts(error)[0]).toContain('Claude authentication expired')
  })

  it('is reported again at most once an hour while it lasts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    answers(throws(expired))
    const { llmCall, error } = await load()

    for (let i = 0; i < 10; i++) await llmCall(`call ${i}`, 16)
    expect(alerts(error)).toHaveLength(1)

    vi.setSystemTime(Date.now() + 60 * 60_000)
    await llmCall('an hour later', 16)
    expect(alerts(error)).toHaveLength(2)
    expect(alerts(error)[1]).toContain('11 LLM calls in a row to')
  })

  it('says so once a call works again, and starts counting from zero', async () => {
    answers(throws(expired), throws(expired), throws(expired), returns(reply('ok')), throws(expired))
    const { llmCall, error, warn } = await load()

    for (let i = 0; i < 4; i++) await llmCall(`call ${i}`, 16)
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('work again, after 3 failed authentication')
    )

    await llmCall('e', 16)
    await llmCall('f', 16)
    expect(alerts(error)).toHaveLength(1)
  })

  it('counts a relay that wraps an authentication failure in a 500', async () => {
    answers(throws(relayed))
    const { llmCall, error } = await load()

    for (let i = 0; i < 3; i++) await llmCall(`call ${i}`, 16)

    expect(alerts(error)).toHaveLength(1)
  })

  it('does not count other failures, and they do not end a run of refusals', async () => {
    answers(throws(expired), throws(overloaded), throws(expired), throws(overloaded), throws(expired))
    const { llmCall, error } = await load()

    for (let i = 0; i < 4; i++) await llmCall(`call ${i}`, 16)
    expect(error).not.toHaveBeenCalled()
    await llmCall('fifth', 16)

    expect(alerts(error)).toHaveLength(1)
    expect(alerts(error)[0]).toContain('3 LLM calls in a row to')
  })

  it('counts each endpoint on its own', async () => {
    answers(throws(expired))
    const { llmCall, error } = await load({
      AMEM_LLM_BASE_URL: 'http://127.0.0.1:3456',
      AMEM_LLM_STRONG_BASE_URL: 'https://relay.example',
    })

    await llmCall('a', 16, 'fast')
    await llmCall('b', 16, 'strong')
    await llmCall('c', 16, 'fast')
    await llmCall('d', 16, 'strong')
    expect(error).not.toHaveBeenCalled()
    await llmCall('e', 16, 'fast')

    expect(alerts(error)).toHaveLength(1)
    expect(alerts(error)[0]).toContain('http://127.0.0.1:3456')
  })

  it('counts each model on its own, and says what stops for a strong-tier model', async () => {
    // A relay can deny one model and serve another on the same endpoint.
    answers(throws(expired), throws(expired), throws(expired), returns(reply('ok')))
    const { llmCall, error, warn } = await load({ AMEM_LLM_STRONG_MODEL: 'claude-opus-5-5' })

    for (let i = 0; i < 3; i++) await llmCall(`judge ${i}`, 300, 'strong')
    await llmCall('a fast call that works', 16, 'fast')

    expect(alerts(error)).toHaveLength(1)
    expect(alerts(error)[0]).toContain('(model claude-opus-5-5)')
    expect(alerts(error)[0]).toContain('the nightly merge and contradiction checks do nothing')
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('work again'))).toBe(false)
  })

  it('points at the variable the SDK reads when no base URL is configured here', async () => {
    answers(throws(expired))
    const { llmCall, error } = await load()

    for (let i = 0; i < 3; i++) await llmCall(`call ${i}`, 16)

    expect(alerts(error)[0]).toContain(
      'the endpoint the Anthropic SDK picks (ANTHROPIC_BASE_URL, or api.anthropic.com)'
    )
  })

  it('names the endpoint by scheme and host only', async () => {
    answers(throws(expired))
    const { llmCall, error } = await load({ AMEM_LLM_BASE_URL: 'https://user:s3cret@relay.example:8443/v1?key=abc' })

    for (let i = 0; i < 3; i++) await llmCall(`call ${i}`, 16)

    const msg = alerts(error)[0]
    expect(msg).toContain('to https://relay.example:8443 (model')
    for (const secret of ['s3cret', 'user', 'key=abc', '/v1']) expect(msg).not.toContain(secret)
  })
})

describe('the error sink', () => {
  it('defaults to console.error', async () => {
    vi.resetModules()
    const config = await import('../../src/config.js')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    config.error('boom')
    expect(spy).toHaveBeenCalledWith('boom')
    spy.mockRestore()
  })
})

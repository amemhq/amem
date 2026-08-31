import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

// The engine reports recovered failures through config.ts's `warn`, not through
// console directly. That indirection is the whole point: stderr is fine for the
// CLI and useless under a host that discards it, and OpenClaw's gateway runs
// under launchd with StandardErrorPath=/dev/null. Through 2.1.1 an LLM outage
// that stored notes with empty keywords for eleven days produced no log line
// anywhere.

const { anthropicCreate } = vi.hoisted(() => ({ anthropicCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
  },
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: vi.fn() } }
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

// Each case re-imports so the module-level sink starts back at its default.
async function fresh() {
  vi.resetModules()
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
  const config = await import('../../src/config.js')
  const llm = await import('../../src/llm.js')
  return { config, llm }
}

describe('engine diagnostics sink', () => {
  it('defaults to stderr, which is what a CLI wants', async () => {
    const { llm } = await fresh()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    anthropicCreate.mockRejectedValueOnce(new Error('boom'))

    expect(await llm.llmCall('hi')).toBeNull()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('LLM call failed'))
  })

  it('sends a failed LLM call to a host that claims it, and not to stderr', async () => {
    const { config, llm } = await fresh()
    const sink = vi.fn()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    config.configure({ warn: sink })
    anthropicCreate.mockRejectedValueOnce(new Error('404 /v1/v1/messages'))

    expect(await llm.llmCall('hi')).toBeNull()
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('404 /v1/v1/messages'))
    expect(spy).not.toHaveBeenCalled()
  })

  it('leaves dataDir alone when only warn is configured', async () => {
    const { config } = await fresh()
    const before = config.getDataDir()
    config.configure({ warn: vi.fn() })
    expect(config.getDataDir()).toBe(before)
  })
})

describe('no engine module writes to stderr directly', () => {
  // The failure this guards against is not a wrong message, it is a message
  // nobody can read. A console.error added here looks like it works — it prints
  // in every test and every terminal — and is discarded in the one place that
  // matters. cli-migrate.ts is exempt: it IS a terminal program, and config.ts
  // holds the default sink.
  const EXEMPT = new Set(['cli-migrate.ts', 'config.ts'])
  const srcDir = fileURLToPath(new URL('../../src', import.meta.url))

  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !EXEMPT.has(f))

  it('has engine modules to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files)('%s uses warn() rather than console.error/console.warn', (file) => {
    const src = readFileSync(`${srcDir}/${file}`, 'utf8')
    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /console\.(error|warn)\s*\(/.test(line))
      .map(([n, line]) => `${file}:${n} ${line.trim()}`)

    expect(offenders).toEqual([])
  })
})

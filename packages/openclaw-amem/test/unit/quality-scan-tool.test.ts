import { describe, it, expect, vi } from 'vitest'

// The model does not choose which file memory_quality_scan writes. ClawHub's review of 2.1.8
// showed a chosen name could be AGENTS.md in the gateway's working directory.

const { generateReviewBatch } = vi.hoisted(() => ({
  generateReviewBatch: vi.fn(async () => '/reviews/amem-review-batch1.md'),
}))
vi.mock('@amemhq/core', async () => ({
  ...(await import('../../../amem-core/src/index.js')),
  generateReviewBatch,
}))
vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({ definePluginEntry: (entry: unknown) => entry }))

import { register } from '../../src/index.js'

type Tool = { name: string; parameters: { properties: Record<string, unknown> }; execute: (...a: unknown[]) => unknown }

function qualityScanTool(): Tool {
  const factories: Array<(ctx: unknown) => Tool> = []
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: {},
    on: vi.fn(),
    registerTool: (factory: (ctx: unknown) => Tool) => factories.push(factory),
    registerService: vi.fn(),
    runtime: {},
  }
  register(api as never)
  const tool = factories.map((f) => f({ agentId: 'main' })).find((t) => t?.name === 'memory_quality_scan')
  if (!tool) throw new Error('memory_quality_scan not registered')
  return tool
}

describe('memory_quality_scan', () => {
  it('takes no file name, and ignores one if the model sends it anyway', async () => {
    const tool = qualityScanTool()
    expect(tool.parameters.properties).toEqual({})

    await tool.execute('call-1', { outputPath: 'AGENTS.md' })

    expect(generateReviewBatch).toHaveBeenCalledWith('main')
  })
})

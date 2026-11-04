import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ pipeline: vi.fn() }))
vi.mock('@huggingface/transformers', () => ({
  pipeline: h.pipeline,
  env: { cacheDir: null, localModelPath: '', allowLocalModels: false },
}))

beforeEach(() => {
  vi.resetModules()
  h.pipeline.mockReset()
  h.pipeline.mockResolvedValue(async () => ({ data: Float32Array.from([1, 0]) }))
})

describe('loading the model on this thread', () => {
  it('turns KleidiAI off through the session options when asked', async () => {
    const { loadExtractor } = await import('../../src/embedding-local.js')
    await loadExtractor({ model: 'm', disableKleidiAi: true })
    expect(h.pipeline.mock.calls[0][2].session_options).toEqual({ extra: { mlas: { disable_kleidiai: '1' } } })
  })

  it('passes no session options otherwise, so the library defaults stand', async () => {
    const { loadExtractor } = await import('../../src/embedding-local.js')
    await loadExtractor({ model: 'm' })
    expect(h.pipeline.mock.calls[0][2]).not.toHaveProperty('session_options')
  })

  it('loads once for concurrent callers, and again only when the spec changes', async () => {
    const { loadExtractor } = await import('../../src/embedding-local.js')
    await Promise.all([loadExtractor({ model: 'm' }), loadExtractor({ model: 'm' })])
    expect(h.pipeline).toHaveBeenCalledTimes(1)
    await loadExtractor({ model: 'other' })
    expect(h.pipeline).toHaveBeenCalledTimes(2)
  })

  it('never hands one spec the pipeline of another that loaded at the same time', async () => {
    let finishA!: (v: unknown) => void
    const { loadExtractor } = await import('../../src/embedding-local.js')
    await loadExtractor({ model: 'warm' }) // imports the library once, outside the overlap
    h.pipeline.mockImplementationOnce(() => new Promise((r) => (finishA = r)))
    h.pipeline.mockImplementationOnce(async () => 'pipeline-B')

    const a = loadExtractor({ model: 'A' })
    const b = await loadExtractor({ model: 'B' })
    finishA('pipeline-A')
    await a

    expect(b).toBe('pipeline-B')
    expect(await loadExtractor({ model: 'B' })).toBe('pipeline-B')
  })
})

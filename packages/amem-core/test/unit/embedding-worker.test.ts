/**
 * The embedding runs in a worker thread. OpenClaw 2026.10.10 samples the gateway's main
 * thread with a V8 CPU profiler, and on an Apple chip with SME that kills the process the
 * moment onnxruntime's KleidiAI kernels run there. Fake workers only: nothing loads a model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const h = vi.hoisted(() => ({
  workers: [] as any[],
  existsSync: vi.fn(() => true),
  encodeLocal: vi.fn(async () => Float32Array.from([0.6, 0.8])),
  loadExtractor: vi.fn(async () => ({})),
  isLocalLoaded: vi.fn(() => false),
  throwOnSpawn: false,
}))

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWorker extends EventEmitter {
    file: string
    refs = 0
    sent: any[] = []
    terminated = false
    constructor(file: string) {
      super()
      if (h.throwOnSpawn) throw new Error('spawn refused')
      this.file = file
      h.workers.push(this)
    }
    ref() {
      this.refs = 1
    }
    unref() {
      this.refs = 0
    }
    postMessage(msg: any) {
      this.sent.push(msg)
    }
    async terminate() {
      this.terminated = true
      this.emit('exit', 1)
      return 1
    }
    /** Answer the oldest unanswered request. */
    answer(vector = Float32Array.from([1, 0])) {
      const msg = this.sent.shift()
      this.emit('message', msg.type === 'load' ? { id: msg.id, ok: true } : { id: msg.id, ok: true, vector })
    }
  }
  return { Worker: FakeWorker, parentPort: null }
})
vi.mock('fs', async (orig) => ({ ...(await orig<typeof import('fs')>()), existsSync: h.existsSync }))
vi.mock('../../src/embedding-local.js', () => ({
  encodeLocal: h.encodeLocal,
  loadExtractor: h.loadExtractor,
  isLocalLoaded: h.isLocalLoaded,
}))

async function load() {
  vi.resetModules()
  const config = await import('../../src/config.js')
  const warn = vi.fn()
  config.configure({ warn })
  const emb = await import('../../src/embedding.js')
  return { emb, warn }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const platform = (p: string, a: string) => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  Object.defineProperty(process, 'arch', { value: a, configurable: true })
}
const real = { platform: process.platform, arch: process.arch }

beforeEach(() => {
  h.workers.length = 0
  h.existsSync.mockReturnValue(true)
  h.encodeLocal.mockClear()
  h.loadExtractor.mockClear()
  h.throwOnSpawn = false
})
afterEach(() => platform(real.platform, real.arch))

describe('the embedding worker', () => {
  it('encodes in the worker, started from the file next to the engine', async () => {
    const { emb } = await load()

    const v = emb.encode('hello')
    await tick()
    const w = h.workers[0]
    expect(w.file).toMatch(/embed-worker\.ts$/)
    expect(w.sent[0]).toMatchObject({ type: 'encode', text: 'hello', spec: { model: emb.getEmbeddingModel() } })
    w.answer(Float32Array.from([0.6, 0.8]))

    expect(await v).toEqual([Float32Array.from([0.6])[0], Float32Array.from([0.8])[0]])
    expect(h.encodeLocal).not.toHaveBeenCalled()
    expect(emb.isModelLoaded()).toBe(true)
  })

  it('keeps the process alive only while a request waits on the worker', async () => {
    const { emb } = await load()

    const v = emb.encode('hello')
    await tick()
    const w = h.workers[0]
    expect(w.refs).toBe(1)
    w.answer()
    await v
    expect(w.refs).toBe(0)
  })

  it('starts one worker and reuses it', async () => {
    const { emb } = await load()

    const a = emb.encode('a')
    const b = emb.encode('b')
    await tick()
    h.workers[0].answer()
    h.workers[0].answer()
    await Promise.all([a, b])

    expect(h.workers).toHaveLength(1)
  })

  it('embeds on this thread with KleidiAI off on macOS arm64 when there is no worker file', async () => {
    platform('darwin', 'arm64')
    h.existsSync.mockReturnValue(false)
    const { emb, warn } = await load()

    await emb.encode('hello')

    expect(h.workers).toHaveLength(0)
    expect(h.encodeLocal).toHaveBeenCalledWith('hello', expect.objectContaining({ disableKleidiAi: true }), 'cls')
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('embedding worker unavailable')
    )
  })

  it('leaves KleidiAI on when it embeds on this thread elsewhere', async () => {
    platform('linux', 'arm64')
    h.throwOnSpawn = true
    const { emb } = await load()

    await emb.encode('hello')

    expect(h.encodeLocal).toHaveBeenCalledWith('hello', expect.objectContaining({ disableKleidiAi: false }), 'cls')
  })

  it('replaces a worker that exits, and resends what was waiting', async () => {
    const { emb, warn } = await load()

    const v = emb.encode('waiting')
    await tick()
    h.workers[0].emit('exit', 1)
    await tick()

    expect(h.workers).toHaveLength(2)
    expect(h.workers[1].sent[0]).toMatchObject({ type: 'encode', text: 'waiting' })
    h.workers[1].answer()
    expect(await v).toHaveLength(2)
    expect(h.encodeLocal).not.toHaveBeenCalled()
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining('starting a new one'))
  })

  it('embeds on this thread after three exits within a minute, and stays there', async () => {
    const { emb } = await load()

    const v = emb.encode('waiting')
    for (let i = 0; i < 3; i++) {
      await tick()
      h.workers[i].emit('error', new Error('worker crashed'))
    }

    expect(await v).toHaveLength(2)
    expect(h.encodeLocal).toHaveBeenCalledWith('waiting', expect.anything(), 'cls')
    await emb.encode('after')
    expect(h.workers).toHaveLength(3)
    expect(h.encodeLocal).toHaveBeenCalledTimes(2)
  })

  it('logs download progress from the worker on this thread', async () => {
    const { emb } = await load()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const v = emb.encode('x')
    await tick()
    h.workers[0].emit('message', { log: '[amem] downloading onnx/model.onnx: 100% of 607 kB' })
    h.workers[0].answer()
    await v

    expect(log).toHaveBeenCalledWith('[amem] downloading onnx/model.onnx: 100% of 607 kB')
    log.mockRestore()
  })

  it('does not record a width measured for a model that was re-pinned mid-probe', async () => {
    const { emb } = await load()

    const dim = emb.getEmbeddingDim()
    await tick()
    emb.pinEmbeddingModel('Xenova/paraphrase-multilingual-MiniLM-L12-v2')
    h.workers[0].answer(Float32Array.from([1, 0, 0]))
    await dim

    expect(emb.isModelLoaded()).toBe(false)
    // The new model loads through a write, not a probe. Its width is still unmeasured.
    const write = emb.encode('a note')
    await tick()
    h.workers[0].answer(Float32Array.from([1, 0]))
    await write
    expect(emb.isModelLoaded()).toBe(true)

    const again = emb.getEmbeddingDim()
    await tick()
    expect(h.workers[0].sent).toHaveLength(1) // probed again, for the new model
    h.workers[0].answer(Float32Array.from([1, 0]))
    expect(await again).toBe(2)
  })

  it('loads the model again when a worker that held it exits idle', async () => {
    const { emb } = await load()

    const loaded = emb.loadModel()
    await tick()
    h.workers[0].answer()
    await loaded
    expect(emb.isModelLoaded()).toBe(true)

    h.workers[0].emit('exit', 1)
    await tick()
    expect(emb.isModelLoaded()).toBe(false)
    expect(h.workers[1].sent[0]).toMatchObject({ type: 'load' })
    h.workers[1].answer()
    await tick()
    expect(emb.isModelLoaded()).toBe(true)
  })

  it('does not reload for a process that only encodes, so a CLI can still exit', async () => {
    const { emb } = await load()

    const v = emb.encode('x')
    await tick()
    h.workers[0].answer()
    await v
    h.workers[0].emit('exit', 1)
    await tick()

    expect(h.workers).toHaveLength(1)
  })

  it('does not reload a model the pin has moved away from', async () => {
    const { emb } = await load()

    const loaded = emb.loadModel()
    await tick()
    emb.pinEmbeddingModel('Xenova/paraphrase-multilingual-MiniLM-L12-v2')
    h.workers[0].answer()
    await loaded
    h.workers[0].emit('exit', 1)
    await tick()

    expect(h.workers).toHaveLength(1)
  })

  it('passes a failure in the worker back to the caller', async () => {
    const { emb } = await load()

    const v = emb.encode('x')
    await tick()
    const w = h.workers[0]
    const msg = w.sent.shift()
    w.emit('message', { id: msg.id, ok: false, error: 'model not found' })

    await expect(v).rejects.toThrow('model not found')
  })

  it('stops the worker on close, answers what was waiting, and starts no other', async () => {
    const { emb } = await load()

    const v = emb.encode('x')
    await tick()
    await emb.closeEmbedding()

    expect(h.workers[0].terminated).toBe(true)
    await expect(v).rejects.toThrow('embedding is closed')
    // Work still in flight in a retired plugin copy must not start a worker nothing stops.
    await expect(emb.encode('y')).rejects.toThrow('embedding is closed')
    expect(h.workers).toHaveLength(1)
    expect(h.encodeLocal).not.toHaveBeenCalled()
  })

  it('embeds again after openEmbedding, on a new worker', async () => {
    // OpenClaw stops and starts a memory plugin's service on the same module when it
    // reloads other plugins.
    const { emb } = await load()
    await emb.closeEmbedding()

    emb.openEmbedding()
    const v = emb.encode('y')
    await tick()
    h.workers[0].answer()

    expect(await v).toHaveLength(2)
  })
})

describe('the worker side', () => {
  it('answers requests in order and survives a failing one', async () => {
    const { serve } = await import('../../src/embed-worker.js')
    const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
    const local = {
      loadExtractor: vi.fn(async () => ({})),
      encodeLocal: vi.fn(async (text: string) => {
        if (text === 'bad') throw new Error('boom')
        return Float32Array.from([1])
      }),
    }
    serve(port as never, local as never)

    const spec = { model: 'm' }
    port.emit('message', { id: 1, type: 'load', spec })
    port.emit('message', { id: 2, type: 'encode', spec, text: 'bad', pooling: 'cls' })
    port.emit('message', { id: 3, type: 'encode', spec, text: 'good', pooling: 'cls' })
    await new Promise((r) => setTimeout(r, 10))

    const replies = port.postMessage.mock.calls.map((c) => c[0])
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3])
    expect(replies[1]).toMatchObject({ ok: false, error: 'boom' })
    expect(replies[2]).toMatchObject({ ok: true })
    // The vector's buffer is transferred, not copied.
    expect(port.postMessage.mock.calls[2][1]).toHaveLength(1)
  })

  // In an OpenClaw plugin capture, Transformers.js cannot see onnxruntime-common: it imports
  // it without declaring it, and the capture links only declared dependencies.
  describe('resolving onnxruntime-common', () => {
    const ctx = { conditions: ['node', 'import'], importAttributes: {}, parentURL: 'file:///c/package-10/t.mjs' }
    const notFound = (code: string) => Object.assign(new Error('Cannot find package'), { code })
    const resolver = (missing: string | null) =>
      vi.fn((spec: string, c?: { parentURL?: string }) => {
        if (spec === 'onnxruntime-node') return { url: 'file:///c/package-13/node_modules/onnxruntime-node/i.js' }
        if (missing && c?.parentURL === ctx.parentURL) throw notFound(missing)
        return { url: `file:///found/${spec}?from=${c?.parentURL}` }
      })

    it('resolves it from onnxruntime-node when the importer cannot', async () => {
      const { resolveOrtCommon } = await import('../../src/embed-worker.js')
      for (const code of ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']) {
        expect(resolveOrtCommon('onnxruntime-common', ctx, resolver(code)).url).toBe(
          'file:///found/onnxruntime-common?from=file:///c/package-13/node_modules/onnxruntime-node/i.js'
        )
      }
    })

    it('leaves a resolution that works, other packages and other errors alone', async () => {
      const { resolveOrtCommon } = await import('../../src/embed-worker.js')
      expect(resolveOrtCommon('onnxruntime-common', ctx, resolver(null)).url).toContain(`from=${ctx.parentURL}`)
      expect(() => resolveOrtCommon('sharp', ctx, resolver('ERR_MODULE_NOT_FOUND'))).toThrow('Cannot find package')
      expect(() => resolveOrtCommon('onnxruntime-common', ctx, resolver('ERR_INVALID_PACKAGE_CONFIG'))).toThrow()
    })
  })
})

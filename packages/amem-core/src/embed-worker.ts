/**
 * The worker thread that loads the embedding model and runs it. See embedding.ts for why.
 *
 * Requests are served one at a time, in arrival order. A failure is answered, not thrown,
 * so one bad request does not end the worker.
 */
import * as nodeModule from 'node:module'
import { parentPort } from 'node:worker_threads'
import { encodeLocal, loadExtractor, setProgressSink, type ExtractorSpec } from './embedding-local.js'

export type EmbedRequest =
  | { id: number; type: 'load'; spec: ExtractorSpec }
  | { id: number; type: 'encode'; spec: ExtractorSpec; text: string; pooling: 'mean' | 'cls' }

export type EmbedResponse =
  { id: number; ok: true; vector?: Float32Array } | { id: number; ok: false; error: string } | { log: string }

interface Port {
  on(event: 'message', listener: (msg: EmbedRequest) => void): unknown
  postMessage(msg: EmbedResponse, transfer?: ArrayBuffer[]): void
}

export function serve(port: Port, local = { encodeLocal, loadExtractor }): void {
  let queue: Promise<void> = Promise.resolve()
  port.on('message', (msg) => {
    queue = queue.then(async () => {
      try {
        if (msg.type === 'load') {
          await local.loadExtractor(msg.spec)
          port.postMessage({ id: msg.id, ok: true })
        } else {
          const vector = await local.encodeLocal(msg.text, msg.spec, msg.pooling)
          port.postMessage({ id: msg.id, ok: true, vector }, [vector.buffer as ArrayBuffer])
        }
      } catch (err) {
        port.postMessage({ id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) })
      }
    })
  })
}

/**
 * Transformers.js imports onnxruntime-common without declaring it, so it resolves only where
 * an installer hoisted it. OpenClaw links each package in a plugin capture to what it declares
 * and nothing else; its own resolver covers the gap on the main thread but is not registered
 * in a worker. Resolve it from onnxruntime-node instead, whose copy is the one the native
 * binding is built against. Node before 22.15 has no registerHooks and skips this.
 */
export function resolveOrtCommon(
  specifier: string,
  context: nodeModule.ResolveHookContext,
  next: (specifier: string, context?: Partial<nodeModule.ResolveHookContext>) => nodeModule.ResolveFnOutput
): nodeModule.ResolveFnOutput {
  if (specifier !== 'onnxruntime-common') return next(specifier, context)
  try {
    return next(specifier, context)
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw err
    return next(specifier, { ...context, parentURL: next('onnxruntime-node', context).url })
  }
}

if (parentPort) {
  nodeModule.registerHooks?.({ resolve: resolveOrtCommon })
  const port = parentPort as unknown as Port
  setProgressSink((line) => port.postMessage({ log: line }))
  serve(port)
}

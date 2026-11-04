/**
 * embedding.ts — Local ONNX embedding via @huggingface/transformers
 * Matches Python: SentenceTransformer.encode(text, normalize_embeddings=True)
 *
 * The model is selectable, and changing it is a breaking change whenever the
 * dimension differs — Qdrant fixes a collection's vector size at creation. So
 * nothing here decides on its own: a collection that already exists keeps the
 * model it was built with (see `pinEmbeddingModel`), and moving is a deliberate
 * `amem-migrate` run. See docs/reference/embedding-models.md.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { Worker } from 'node:worker_threads'
import { warn } from './config.js'
import { encodeLocal, loadExtractor, type ExtractorSpec } from './embedding-local.js'
import type { EmbedRequest, EmbedResponse } from './embed-worker.js'

export { humanBytes } from './bytes.js'

let loadedKey: string | null = null
let cachedDim: { key: string; dim: number } | null = null

/**
 * What a fresh install embeds with.
 *
 * Chosen for having no architectural question mark rather than for topping a
 * leaderboard: XLM-RoBERTa, natively supported by Transformers.js, its ONNX
 * maintained by that library's own author. 8192 tokens against the 128 of the
 * model this replaced, which is the whole reason for the change — anything longer
 * than a couple of sentences was being truncated before it reached the vector.
 */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-m3'

/**
 * The default before 2.0.0. Every store built by an earlier version holds its
 * vectors, and nothing recorded that at the time — `LEGACY_DEFAULT_DIM` is how a
 * collection from back then is recognised.
 */
export const LEGACY_DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
export const LEGACY_DEFAULT_DIM = 384

/**
 * Set when a collection says which model built it, so the engine keeps using that
 * one instead of whatever the current default happens to be.
 *
 * Without this, changing `DEFAULT_EMBEDDING_MODEL` would break every existing
 * install on upgrade. With it, the default is only ever what a *new* store gets.
 */
let pinnedModel: string | null = null

/** Pin the model to what a collection was built with. `null` clears it. */
export function pinEmbeddingModel(model: string | null): void {
  if (pinnedModel === model) return
  pinnedModel = model
  loadedKey = null
  cachedDim = null
}

/** What the pin currently holds, or null. The caller that set it checks for conflicts. */
export function getPinnedEmbeddingModel(): string | null {
  return pinnedModel
}

/**
 * Which model this process embeds with: the env var, else whatever the open
 * collection was built with, else the shipped default.
 *
 * An explicit `AMEM_EMBED_MODEL` outranks the pin on purpose — someone who set it
 * is migrating deliberately, and silently overriding them with the collection's
 * old model would make the setting look broken.
 */
export function getEmbeddingModel(): string {
  return process.env.AMEM_EMBED_MODEL?.trim() || pinnedModel || DEFAULT_EMBEDDING_MODEL
}

/** How token embeddings are collapsed into one sentence vector. */
export type PoolingMode = 'mean' | 'cls'

/**
 * Models trained with CLS pooling, by repo basename.
 *
 * Unlike the vector dimension — which is measured, because a table is silently
 * wrong for anything not in it — pooling cannot be probed: both modes return a
 * correctly-shaped, plausible vector, and only one of them is the model the
 * benchmark measured. So this is a table, and it is wrong-by-omission on purpose:
 * an unlisted model falls back to `mean`, which is what every version before this
 * one did unconditionally.
 *
 * Keyed on the basename so the ONNX mirror and the original resolve alike —
 * `Xenova/bge-m3` and `BAAI/bge-m3` are the same model. Each entry was read from
 * that model's own `1_Pooling/config.json`.
 */
const CLS_POOLED_MODELS = new Set([
  'bge-m3',
  'bge-base-zh-v1.5',
  'bge-small-zh-v1.5',
  'bge-base-en-v1.5',
  'bge-small-en-v1.5',
  'bge-large-en-v1.5',
  'gte-multilingual-base',
  'gte-modernbert-base',
  'gte-large-en-v1.5',
  'snowflake-arctic-embed-m',
  'snowflake-arctic-embed-l',
])

/**
 * Which pooling this process uses: `AMEM_EMBED_POOLING`, else the model's known
 * mode, else `mean`.
 *
 * Getting this wrong does not fail. `encode()` returns a normalized vector of the
 * right width either way, and search keeps working because notes and queries are
 * embedded by the same function — it just retrieves worse than the model can,
 * with nothing to indicate it. That is why the mode is resolved rather than
 * assumed.
 */
export function getEmbeddingPooling(): PoolingMode {
  const explicit = process.env.AMEM_EMBED_POOLING?.trim().toLowerCase()
  if (explicit === 'mean' || explicit === 'cls') return explicit
  const basename = getEmbeddingModel().split('/').pop()?.toLowerCase() ?? ''
  return CLS_POOLED_MODELS.has(basename) ? 'cls' : 'mean'
}

/**
 * Where inference runs. Unset means Transformers.js picks, which on Node is `cpu`.
 *
 * It is not CPU-only for lack of anything else: `onnxruntime-node`'s macOS arm64
 * binary links CoreML.framework and exports the CoreML provider, and
 * Transformers.js lists `coreml` (macOS), `dml` (Windows), `cuda` (Linux x64) and
 * `webgpu` alongside `cpu`. It simply defaults to `cpu` and amem never asked for
 * anything else.
 *
 * Whether asking helps is **unmeasured**. CoreML partitions a graph operator by
 * operator and falls back to CPU for the ones it cannot take, so it can lose to
 * plain CPU on some models and pay a compile cost on first load. Hence: opt-in,
 * default unchanged, and no recommendation until someone benchmarks it.
 */
export function getEmbeddingDevice(): string | undefined {
  return process.env.AMEM_EMBED_DEVICE?.trim() || undefined
}

/**
 * Weight precision. Unset means Transformers.js picks, which on Node is `fp32` —
 * the largest download of every variant a model publishes.
 *
 * 2.0.0 defaulted this to `fp16` for bge-m3, to halve a 2.27 GB download. That
 * shipped broken: `onnxruntime-node` 1.24.3 aborts loading those weights in
 * `SimplifiedLayerNormFusion`, on a node the fp16 conversion inserts, so the
 * default install could not embed at all. Reproduced on bge-m3 and on
 * gte-multilingual-base, on two machines — it is the runtime and fp16, not one
 * model. Nothing here picks a dtype now; saving the download is not worth
 * choosing a build we have not loaded.
 *
 * Passed through rather than validated against a list: Transformers.js already
 * rejects an unknown value and names the valid ones, and a list here would go
 * stale the moment it gains a quantization.
 */
export function getEmbeddingDtype(): string | undefined {
  return process.env.AMEM_EMBED_DTYPE?.trim() || undefined
}

/** Everything that decides which weights are resident. */
function extractorKey(): string {
  return `${getEmbeddingModel()}|${getEmbeddingDevice() ?? ''}|${getEmbeddingDtype() ?? ''}`
}

// ── The embedding worker ──────────────────────────────────────────────────────
// The model loads and runs in a worker thread, not on the caller's thread. OpenClaw
// 2026.10.10 keeps a V8 CPU profiler sampling the gateway's main thread on Node 26. On an
// Apple chip with SME, onnxruntime's KleidiAI kernels run in streaming mode, and a SIGPROF
// arriving there makes V8's handler execute an illegal instruction: the gateway died 26
// times in one day. V8 signals only the thread it samples, so in a worker the same load
// and inference do not crash, and keep their speed: 77 ms per run measured on an M4,
// against 210 ms with KleidiAI turned off. The 3.3 s main-thread stall while the model
// loads goes away too.
//
// The worker file sits next to this module, so inside OpenClaw it comes from the same
// verified capture copy as the plugin, and resolves its imports through the dependencies
// linked there. A worker that exits is replaced. If it cannot start, or exits three times
// within a minute, embedding moves onto this thread for the rest of the process, with
// KleidiAI off on macOS arm64: slower, but it cannot crash.
let worker: Worker | null = null
let inThread = false
// Set by closeEmbedding, cleared by openEmbedding. A host that stopped the plugin may still
// have work in flight in this module instance; that work must not start a worker nothing
// will ever stop.
let closed = false
// Set by loadModel(): this process wants the model resident, not only loaded on demand.
let keepLoaded = false
let nextId = 1
const exits: number[] = []
const EXITS_BEFORE_IN_THREAD = 3
const EXIT_WINDOW_MS = 60_000
const pending = new Map<number, { msg: EmbedRequest; resolve: (r: EmbedResponse) => void }>()

type Answer = Exclude<EmbedResponse, { log: string }>

function workerFile(): string {
  // __filename where it exists, so that a '#' or '?' in the install path survives; tsup's
  // shims supply it in the ESM build.
  const here = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
  return path.join(path.dirname(here), `embed-worker${path.extname(here)}`)
}

function spec(): ExtractorSpec {
  const device = getEmbeddingDevice()
  const dtype = getEmbeddingDtype()
  return { model: getEmbeddingModel(), ...(device ? { device } : {}), ...(dtype ? { dtype } : {}) }
}

/** The worker, started if needed, or null once embedding has moved onto this thread. */
function getWorker(): Worker | null {
  if (inThread) return null
  if (worker) return worker
  const file = workerFile()
  if (!fs.existsSync(file)) return moveInThread(`no worker file at ${file}`)
  let w: Worker
  try {
    w = new Worker(file)
  } catch (err) {
    return moveInThread((err as Error).message)
  }
  // Not a reason to keep a CLI alive. It is ref'd while a request waits on it.
  w.unref()
  w.on('message', (res: EmbedResponse) => {
    // Download progress, logged here because hosts capture console output on this thread.
    if ('log' in res) return console.log(res.log)
    const job = pending.get(res.id)
    if (!job) return
    pending.delete(res.id)
    if (pending.size === 0) w.unref()
    job.resolve(res)
  })
  const lost = (why: string) => {
    if (worker !== w) return
    const wasLoaded = loadedKey !== null && loadedKey === extractorKey()
    worker = null
    loadedKey = null
    const now = Date.now()
    exits.push(now)
    while (exits.length > 0 && now - exits[0] > EXIT_WINDOW_MS) exits.shift()
    if (exits.length >= EXITS_BEFORE_IN_THREAD) moveInThread(`${exits.length} exits within a minute, last: ${why}`)
    else warn(`[amem] embedding worker stopped (${why}); starting a new one`)
    // Whatever was waiting runs again, on a new worker or on this thread.
    const waiting = [...pending.values()]
    pending.clear()
    for (const job of waiting) void dispatch(job.msg).then(job.resolve)
    // A worker that dies idle takes the model with it. A process that loaded it up front
    // (amem-api, whose /healthz reports it) gets it back without waiting for a request. Only
    // that one: a reload is ref'd while it runs, and would keep a CLI from exiting.
    if (waiting.length === 0 && wasLoaded && keepLoaded) {
      loadModel().catch((err) => {
        if (!closed) warn(`[amem] reloading the embedding model failed: ${(err as Error).message}`)
      })
    }
  }
  w.on('error', (err: unknown) => lost((err as Error)?.message ?? String(err)))
  w.on('exit', (code) => lost(`exited with code ${code}`))
  worker = w
  return w
}

function moveInThread(why: string): null {
  if (!inThread) warn(`[amem] embedding worker unavailable (${why}); embedding on this thread instead`)
  inThread = true
  return null
}

async function runInThread(msg: EmbedRequest): Promise<Answer> {
  const s = { ...msg.spec, disableKleidiAi: process.platform === 'darwin' && process.arch === 'arm64' }
  try {
    if (msg.type === 'load') {
      await loadExtractor(s)
      return { id: msg.id, ok: true }
    }
    return { id: msg.id, ok: true, vector: await encodeLocal(msg.text, s, msg.pooling) }
  } catch (err) {
    return { id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) }
  }
}

function dispatch(msg: EmbedRequest): Promise<Answer> {
  if (closed) return Promise.resolve({ id: msg.id, ok: false, error: 'embedding is closed' })
  const w = getWorker()
  if (!w) return runInThread(msg)
  return new Promise((resolve) => {
    pending.set(msg.id, { msg, resolve: resolve as (r: EmbedResponse) => void })
    if (pending.size === 1) w.ref()
    w.postMessage(msg)
  })
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

function request(msg: WithoutId<EmbedRequest>): Promise<Answer> {
  return dispatch({ ...msg, id: nextId++ } as EmbedRequest)
}

/**
 * Stop the embedding worker, for a host that is shutting down or retiring the plugin.
 * Later calls fail instead of starting another one, until openEmbedding().
 */
export async function closeEmbedding(): Promise<void> {
  closed = true
  const w = worker
  worker = null
  loadedKey = null
  const waiting = [...pending.values()]
  pending.clear()
  for (const job of waiting) job.resolve({ id: job.msg.id, ok: false, error: 'embedding is closed' })
  if (w) await w.terminate()
}

/**
 * Allow embedding again after closeEmbedding(). OpenClaw stops and starts a memory plugin's
 * service on the same module when it reloads other plugins, so start() must undo stop().
 */
export function openEmbedding(): void {
  closed = false
}

/**
 * The vector width this model produces, measured rather than looked up.
 *
 * A hardcoded table would be wrong the moment someone points AMEM_EMBED_MODEL at
 * something not in it, and wrong silently — the collection would be created with
 * the wrong size and every insert would fail. Encoding one short string costs one
 * forward pass on a model that has to load anyway, and is right for any model.
 */
export async function getEmbeddingDim(): Promise<number> {
  const key = extractorKey()
  if (cachedDim?.key === key && loadedKey === key) return cachedDim.dim
  // encode() reads the model when it is called, so the width is the one `key` produces even
  // if the model changes while the probe runs.
  const probe = await encode('dimension probe')
  cachedDim = { key, dim: probe.length }
  return probe.length
}

/** Record what is resident, unless the model changed while the request ran. */
function noteLoaded(key: string): void {
  if (extractorKey() === key) loadedKey = key
}

/**
 * Encode text to a normalized embedding vector. The width is the model's — 1024
 * for the default, 384 for the one before it — so nothing here should assume a
 * number.
 * Singleton model, loaded once and reused.
 */
export async function encode(text: string): Promise<number[]> {
  const key = extractorKey()
  const res = await request({ type: 'encode', spec: spec(), text, pooling: getEmbeddingPooling() })
  if (!res.ok) throw new Error(res.error)
  noteLoaded(key)
  return Array.from(res.vector!)
}

/**
 * Load the model now rather than on the first encode(). A long-lived service
 * pays the download at startup, not on a user's first write.
 */
export async function loadModel(): Promise<void> {
  keepLoaded = true
  const key = extractorKey()
  const res = await request({ type: 'load', spec: spec() })
  if (!res.ok) throw new Error(res.error)
  noteLoaded(key)
}

/**
 * Whether the model is resident. Synchronous and I/O-free — unlike encode() it
 * can never trigger the several-hundred-megabyte download, so a health check is
 * free to poll it.
 */
export function isModelLoaded(): boolean {
  return loadedKey !== null && loadedKey === extractorKey()
}

/**
 * Cosine similarity between two normalized vectors (already L2-normalized → just dot product)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

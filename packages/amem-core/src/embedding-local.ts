/**
 * Loading the embedding model and running it on the thread that calls this.
 *
 * embedding.ts runs it inside a worker thread (embed-worker.ts) and calls it directly only
 * when no worker can run. It reads no model choice of its own: the caller passes the spec,
 * because the model a collection is pinned to lives on the main thread.
 */
import { humanBytes } from './bytes.js'

export interface ExtractorSpec {
  model: string
  device?: string
  dtype?: string
  /**
   * Turn off onnxruntime's KleidiAI kernels. On an Apple chip with SME they run in
   * streaming mode, and a V8 CPU profiler's SIGPROF arriving there kills the process with
   * SIGILL. Set only when this runs on a thread such a profiler may sample.
   */
  disableKleidiAi?: boolean
}

let pipeline: any = null
let loaded: { key: string; ext: any } | null = null
let loading: { key: string; promise: Promise<any> } | null = null

/**
 * Where download progress lines go. The worker sends them to the main thread, because a
 * host such as OpenClaw captures console output there and not in worker threads.
 */
let progressSink: (line: string) => void = (line) => console.log(line)

export function setProgressSink(sink: (line: string) => void): void {
  progressSink = sink
}

/**
 * Where model weights are cached, and where to look for ones already on disk.
 *
 * Transformers.js caches into its own install directory and reads no environment
 * variable for it. That is per-copy-of-the-library, so the plugin's copy and any
 * `npx --package=@amemhq/core` invocation each download the same 2.27 GB
 * separately, and every fresh `npx` temp directory downloads it again. Migrating
 * a store meant downloading the model a second time for no reason.
 *
 * `AMEM_MODEL_CACHE` gives every copy one place to share.
 *
 * `AMEM_MODEL_DIR` is the other half: point it at a directory holding the repo
 * layout (`<dir>/Xenova/bge-m3/onnx/model.onnx`, …) and the model is read from
 * there. Downloading 2.27 GB over a slow link, on a machine that cannot reach
 * HuggingFace, or onto several machines from one copy are all the same problem,
 * and the fix is being allowed to put the file there yourself.
 */
function applyModelPaths(env: { cacheDir: string | null; localModelPath: string; allowLocalModels: boolean }): void {
  const cache = process.env.AMEM_MODEL_CACHE?.trim()
  if (cache) env.cacheDir = cache
  const local = process.env.AMEM_MODEL_DIR?.trim()
  if (local) {
    env.localModelPath = local
    env.allowLocalModels = true
  }
}

/**
 * Report a download rather than going silent for the length of one.
 *
 * The default model is 2.27 GB. On a slow link that is over an hour with no
 * output at all, which reads as a hang — and a migration that looks hung is one
 * somebody interrupts.
 *
 * It fires on a cached model too, as one 100% line per file, because
 * Transformers.js reports reading the cache with the same progress events it
 * reports a download with. That is why the line says a size: an instant 100% of
 * 2.27 GB is a cache hit, and the same line arriving slowly is a real download.
 */
function makeProgressReporter(): (e: { status?: string; file?: string; progress?: number; total?: number }) => void {
  const lastPct = new Map<string, number>()
  return (e) => {
    if (e.status !== 'progress' || !e.file || typeof e.progress !== 'number') return
    // Only the weights are worth reporting; configs and tokenizers are KBs.
    if (!e.file.endsWith('.onnx') && !e.file.endsWith('.onnx_data')) return
    const pct = Math.floor(e.progress / 10) * 10
    if (lastPct.get(e.file) === pct) return
    lastPct.set(e.file, pct)
    const size = e.total ? ` of ${humanBytes(e.total)}` : ''
    progressSink(`[amem] downloading ${e.file}: ${pct}%${size}`)
  }
}

const specKey = (spec: ExtractorSpec) =>
  `${spec.model}|${spec.device ?? ''}|${spec.dtype ?? ''}|${spec.disableKleidiAi ? 'nokai' : ''}`

/**
 * The pipeline for `spec`, loading it if a different one, or none, is resident. A
 * pipeline is recorded when its own load finishes, and only if no newer load started, so
 * overlapping loads of two specs cannot hand one caller the other's model.
 */
export async function loadExtractor(spec: ExtractorSpec): Promise<any> {
  const wanted = specKey(spec)
  if (loaded?.key === wanted) return loaded.ext
  // Concurrent callers share one load instead of each starting their own.
  if (loading?.key === wanted) return loading.promise
  const promise = (async () => {
    if (!pipeline) {
      const mod = await import('@huggingface/transformers')
      pipeline = mod.pipeline
      // Set once, on the same import that yields the pipeline: `env` is module
      // state, so re-applying it per call would be noise.
      applyModelPaths(mod.env)
    }
    const ext = await pipeline('feature-extraction', spec.model, {
      revision: 'main',
      progress_callback: makeProgressReporter(),
      // Omitted entirely when unset, so an unconfigured install gets exactly the
      // library defaults it got before these existed.
      ...(spec.device ? { device: spec.device } : {}),
      ...(spec.dtype ? { dtype: spec.dtype } : {}),
      // onnxruntime-node turns `extra` into session config entries: mlas.disable_kleidiai.
      ...(spec.disableKleidiAi ? { session_options: { extra: { mlas: { disable_kleidiai: '1' } } } } : {}),
    })
    if (loading?.key === wanted) loaded = { key: wanted, ext }
    return ext
  })()
  loading = { key: wanted, promise }
  try {
    return await promise
  } finally {
    if (loading?.promise === promise) loading = null
  }
}

/**
 * Pool token embeddings into one vector, then L2 normalize.
 * Matches sentence-transformers encode(normalize_embeddings=True).
 *
 * `cls` takes the first token, which is what BGE- and GTE-family models were
 * trained to read; `mean` averages over the attention mask.
 */
function poolNormalize(output: number[][], attentionMask: number[], mode: 'mean' | 'cls'): Float32Array {
  const seqLen = output.length
  const dim = output[0].length
  const pooled = new Float32Array(dim)

  if (mode === 'cls') {
    for (let j = 0; j < dim; j++) pooled[j] = output[0][j]
  } else {
    let maskSum = 0
    for (let i = 0; i < seqLen; i++) {
      const m = attentionMask[i]
      maskSum += m
      for (let j = 0; j < dim; j++) {
        pooled[j] += output[i][j] * m
      }
    }
    for (let j = 0; j < dim; j++) {
      pooled[j] /= Math.max(maskSum, 1e-9)
    }
  }

  // L2 normalize
  let norm = 0
  for (const v of pooled) norm += v * v
  norm = Math.sqrt(norm)
  for (let j = 0; j < dim; j++) pooled[j] /= Math.max(norm, 1e-9)
  return pooled
}

/** Encode `text` with the model in `spec`, on this thread. */
export async function encodeLocal(text: string, spec: ExtractorSpec, pooling: 'mean' | 'cls'): Promise<Float32Array> {
  const ext = await loadExtractor(spec)
  const result = await ext(text, { pooling, normalize: true })

  // result.data is a Float32Array of shape [dim]
  // @huggingface/transformers v3 returns already pooled+normalized when pooling+normalize options given
  if (result && result.data) {
    return Float32Array.from(result.data as Float32Array)
  }

  // Fallback: manual mean pool if result is nested
  const tensor = result as any
  if (tensor.dims && tensor.dims.length === 3) {
    // shape: [1, seq_len, dim]
    const seqLen = tensor.dims[1]
    const dim = tensor.dims[2]
    const raw: number[][] = []
    for (let i = 0; i < seqLen; i++) {
      const row: number[] = []
      for (let j = 0; j < dim; j++) {
        row.push(tensor.data[i * dim + j])
      }
      raw.push(row)
    }
    return poolNormalize(raw, new Array(seqLen).fill(1), pooling)
  }

  throw new Error('Unexpected embedding output shape')
}

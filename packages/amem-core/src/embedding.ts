/**
 * embedding.ts — Local ONNX embedding via @huggingface/transformers
 * Matches Python: SentenceTransformer.encode(text, normalize_embeddings=True)
 *
 * The model is selectable because the default is not a good retrieval model: it
 * caps at 128 tokens, so anything longer is truncated before it reaches the
 * vector. Changing it is a breaking change whenever the dimension differs —
 * Qdrant fixes a collection's vector size at creation — so the default stays put
 * and the switch is opt-in. See docs/reference/embedding-models.md.
 */

// Dynamic import to avoid issues with CJS bundling
let pipeline: any = null
let extractor: any = null
let loadedKey: string | null = null
let cachedDim: number | null = null

/** The model shipped since the beginning. Not changed here on purpose. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

/** Which model this process embeds with. */
export function getEmbeddingModel(): string {
  return process.env.AMEM_EMBED_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL
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

async function getExtractor() {
  const wanted = extractorKey()
  // Re-resolving on every call keeps the env vars honest in tests and lets a
  // long-lived process pick up a change without a restart; the cached vector
  // dimension belongs to the OLD model, so drop it with the extractor.
  if (extractor && loadedKey === wanted) return extractor
  if (!pipeline) {
    const mod = await import('@huggingface/transformers')
    pipeline = mod.pipeline
  }
  const device = getEmbeddingDevice()
  const dtype = getEmbeddingDtype()
  extractor = await pipeline('feature-extraction', getEmbeddingModel(), {
    revision: 'main',
    // Omitted entirely when unset, so an unconfigured install gets exactly the
    // library defaults it got before these existed.
    ...(device ? { device } : {}),
    ...(dtype ? { dtype } : {}),
  })
  loadedKey = wanted
  cachedDim = null
  return extractor
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
  if (cachedDim !== null && loadedKey === extractorKey()) return cachedDim
  const probe = await encode('dimension probe')
  cachedDim = probe.length
  return cachedDim
}

/**
 * Pool token embeddings into one vector, then L2 normalize.
 * Matches sentence-transformers encode(normalize_embeddings=True).
 *
 * `cls` takes the first token, which is what BGE- and GTE-family models were
 * trained to read; `mean` averages over the attention mask.
 */
function poolNormalize(output: number[][], attentionMask: number[], mode: PoolingMode): number[] {
  const seqLen = output.length
  const dim = output[0].length
  const pooled = new Array(dim).fill(0)

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
  return pooled.map((v) => v / Math.max(norm, 1e-9))
}

/**
 * Encode text to a normalized embedding vector. The width is the model's — 384
 * for the default, 1024 for bge-m3 — so nothing here should assume a number.
 * Singleton model, loaded once and reused.
 */
export async function encode(text: string): Promise<number[]> {
  const ext = await getExtractor()
  const pooling = getEmbeddingPooling()
  const result = await ext(text, { pooling, normalize: true })

  // result.data is a Float32Array of shape [dim]
  // @huggingface/transformers v3 returns already pooled+normalized when pooling+normalize options given
  if (result && result.data) {
    return Array.from(result.data as Float32Array)
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

/**
 * Load the model now rather than on the first encode(). A long-lived service
 * pays the download at startup, not on a user's first write.
 */
export async function loadModel(): Promise<void> {
  await getExtractor()
}

/**
 * Whether the model is resident. Synchronous and I/O-free — unlike encode() it
 * can never trigger the several-hundred-megabyte download, so a health check is
 * free to poll it.
 */
export function isModelLoaded(): boolean {
  return extractor !== null
}

/**
 * Cosine similarity between two normalized vectors (already L2-normalized → just dot product)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

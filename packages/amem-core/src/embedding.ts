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
let loadedModelName: string | null = null
let cachedDim: number | null = null

/** The model shipped since the beginning. Not changed here on purpose. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

/** Which model this process embeds with. */
export function getEmbeddingModel(): string {
  return process.env.AMEM_EMBED_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL
}

async function getExtractor() {
  const wanted = getEmbeddingModel()
  // Re-resolving on every call keeps the env var honest in tests and lets a
  // long-lived process pick up a change without a restart; the cached vector
  // dimension belongs to the OLD model, so drop it with the extractor.
  if (extractor && loadedModelName === wanted) return extractor
  if (!pipeline) {
    const mod = await import('@huggingface/transformers')
    pipeline = mod.pipeline
  }
  extractor = await pipeline('feature-extraction', wanted, {
    revision: 'main',
  })
  loadedModelName = wanted
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
  if (cachedDim !== null && loadedModelName === getEmbeddingModel()) return cachedDim
  const probe = await encode('dimension probe')
  cachedDim = probe.length
  return cachedDim
}

/**
 * Mean pooling over token embeddings, then L2 normalize.
 * Matches sentence-transformers encode(normalize_embeddings=True).
 */
function meanPoolingNormalize(output: number[][], attentionMask: number[]): number[] {
  const seqLen = output.length
  const dim = output[0].length

  // Mean pool with attention mask
  const pooled = new Array(dim).fill(0)
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

  // L2 normalize
  let norm = 0
  for (const v of pooled) norm += v * v
  norm = Math.sqrt(norm)
  return pooled.map((v) => v / Math.max(norm, 1e-9))
}

/**
 * Encode text to 384-dim normalized embedding vector.
 * Singleton model, loaded once and reused.
 */
export async function encode(text: string): Promise<number[]> {
  const ext = await getExtractor()
  const result = await ext(text, { pooling: 'mean', normalize: true })

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
    return meanPoolingNormalize(raw, new Array(seqLen).fill(1))
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

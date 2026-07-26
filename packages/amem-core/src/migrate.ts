/**
 * migrate.ts — rebuild a collection under a different embedding model.
 *
 * Changing the embedding model is a breaking change whenever the vector width
 * differs: Qdrant fixes a collection's size at creation and cannot alter it. So
 * the move is always build-alongside → backfill → verify → switch, never in
 * place. The source collection is read and never written, which is what makes
 * the whole thing reversible: if anything looks wrong, point AMEM_COLLECTION
 * back at it.
 *
 * Re-embedding costs no LLM calls. Every field that feeds the vector — content,
 * keywords, tags, context — is already in the payload, so a backfill is local
 * compute. The one exception is notes written before the extraction pipeline
 * filled those fields in: `refreshFields` re-runs construction for those, and
 * only those, because a vector built from a note with no keywords or tags is
 * built from less text than the same note would produce today.
 */
import {
  scrollAllRaw,
  countPointsRaw,
  collectionDimRaw,
  createCollectionRaw,
  upsertPointsRaw,
  pointToNote,
  noteToPoint,
  type MemoryNote,
} from './storage.js'
import { encode, getEmbeddingDim, getEmbeddingModel } from './embedding.js'
import { llmConstructNote } from './llm.js'
import { buildEmbedText } from './memory.js'

export interface MigrateResult {
  /** Points found in the source. */
  total: number
  /** Notes whose derived fields were empty — the pre-pipeline cohort. */
  missingDerived: number
  /** Notes whose fields were re-extracted. 0 unless refreshFields. */
  refreshed: number
  /** Notes written into the target. 0 on a dry run. */
  migrated: number
  sourceDim: number | null
  targetDim: number
  model: string
  dryRun: boolean
}

/** A note that predates the extraction pipeline filling these in. */
function missingDerivedFields(n: MemoryNote): boolean {
  return n.keywords.length === 0 || n.tags.length === 0
}

export async function migrateCollection(opts: {
  /** Source collection. Read-only; never modified. */
  from: string
  /** Target collection. Created if absent; must not already hold points. */
  to: string
  /** Re-extract keywords/tags/context for notes that never had them. Default true. */
  refreshFields?: boolean
  /** Report what would happen and write nothing. Default TRUE — opt in to writing. */
  dryRun?: boolean
  logger?: { info: (m: string) => void; warn: (m: string) => void }
}): Promise<MigrateResult> {
  const { from, to } = opts
  const refreshFields = opts.refreshFields !== false
  const dryRun = opts.dryRun !== false
  const log = opts.logger?.info ?? ((m: string) => console.log(m))
  const warn = opts.logger?.warn ?? ((m: string) => console.warn(m))

  if (from === to) throw new Error(`migrate: source and target are the same collection ("${from}")`)

  const model = getEmbeddingModel()
  const targetDim = await getEmbeddingDim()
  const sourceDim = await collectionDimRaw(from)
  if (sourceDim === null) throw new Error(`migrate: source collection "${from}" does not exist`)

  const points = await scrollAllRaw(from)
  const notes = points.map(pointToNote)
  const missingDerived = notes.filter(missingDerivedFields).length

  log(
    `[migrate] ${from} (${sourceDim}d, ${notes.length} notes) → ${to} (${targetDim}d, ${model}); ` +
      `${missingDerived} note(s) missing keywords/tags`
  )

  if (dryRun) {
    log('[migrate] dry run — nothing written. Pass dryRun: false to apply.')
    return { total: notes.length, missingDerived, refreshed: 0, migrated: 0, sourceDim, targetDim, model, dryRun: true }
  }

  // Refuse to write into a collection that already holds data. Backfilling twice
  // would be idempotent by id, but a target with UNRELATED points is a sign the
  // name is wrong, and silently mixing two stores is not recoverable by pointing
  // a config back.
  const existingTargetDim = await collectionDimRaw(to)
  if (existingTargetDim === null) {
    await createCollectionRaw(to, targetDim)
    log(`[migrate] created ${to} at ${targetDim}d`)
  } else {
    if (existingTargetDim !== targetDim) {
      throw new Error(`migrate: target "${to}" exists at ${existingTargetDim}d but the model produces ${targetDim}d`)
    }
    const existingCount = await countPointsRaw(to)
    if (existingCount > 0) {
      throw new Error(`migrate: target "${to}" already holds ${existingCount} point(s); use an empty collection`)
    }
  }

  let refreshed = 0
  let migrated = 0
  const BATCH = 64
  let buffer: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = []

  const flush = async () => {
    if (!buffer.length) return
    await upsertPointsRaw(to, buffer)
    migrated += buffer.length
    buffer = []
  }

  for (const note of notes) {
    if (refreshFields && missingDerivedFields(note)) {
      try {
        const built = await llmConstructNote(note.content)
        // Only fill gaps. A note that already has tags keeps the ones it has —
        // this is a backfill for what was never extracted, not a re-labelling of
        // everything, which would churn memories the user may have curated.
        if (note.keywords.length === 0) note.keywords = built.keywords
        if (note.tags.length === 0) note.tags = built.tags
        if (!note.context) note.context = built.context
        refreshed++
      } catch (e) {
        warn(`[migrate] re-extract failed for ${note.id.slice(0, 8)} — keeping as-is: ${(e as Error).message}`)
      }
    }

    const point = noteToPoint({ ...note, embedding: await encode(buildEmbedText(note)) })
    buffer.push(point as { id: string; vector: number[]; payload: Record<string, unknown> })
    if (buffer.length >= BATCH) {
      await flush()
      log(`[migrate] ${migrated}/${notes.length}`)
    }
  }
  await flush()

  const finalCount = await countPointsRaw(to)
  if (finalCount !== notes.length) {
    warn(`[migrate] target holds ${finalCount} point(s) but the source had ${notes.length} — check before switching`)
  }

  log(
    `[migrate] done: ${migrated} migrated, ${refreshed} re-extracted. ` +
      `"${from}" is untouched — switch with AMEM_COLLECTION=${to}, and keep the old one until you are satisfied.`
  )

  return { total: notes.length, missingDerived, refreshed, migrated, sourceDim, targetDim, model, dryRun: false }
}

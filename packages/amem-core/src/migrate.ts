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
  scrollIdsRaw,
  deleteCollectionRaw,
  snapshotCollectionRaw,
  resolveAliasRaw,
  setAliasRaw,
  createAliasRaw,
  createCollectionRaw,
  upsertPointsRaw,
  pointToNote,
  noteToPoint,
  type MemoryNote,
} from './storage.js'
import { encode, getEmbeddingDim, getEmbeddingModel } from './embedding.js'
import { llmConstructNote } from './llm.js'
import { buildEmbedText } from './memory.js'
import { warn as engineWarn } from './config.js'

export interface MigrateResult {
  /** Points found in the source. */
  total: number
  /** Notes whose derived fields were empty — the pre-pipeline cohort. */
  missingDerived: number
  /** Notes whose fields were re-extracted. 0 unless refreshFields. */
  refreshed: number
  /** Notes written into the target by THIS run. 0 on a dry run. */
  migrated: number
  /** Notes a previous interrupted run had already written. */
  skipped: number
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
  const warn = opts.logger?.warn ?? engineWarn

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
    return {
      total: notes.length,
      missingDerived,
      refreshed: 0,
      migrated: 0,
      skipped: 0,
      sourceDim,
      targetDim,
      model,
      dryRun: true,
    }
  }

  // A target that already holds points is either an interrupted run of this same
  // migration or somebody else's data. Ids are preserved across the rebuild, so
  // the two are distinguishable: everything already there must be a point we put
  // there, which is to say a subset of the source. Anything else means the name
  // is wrong, and silently mixing two stores is not recoverable by pointing a
  // config back.
  let alreadyDone = new Set<string>()
  const existingTargetDim = await collectionDimRaw(to)
  if (existingTargetDim === null) {
    await createCollectionRaw(to, targetDim)
    log(`[migrate] created ${to} at ${targetDim}d`)
  } else {
    if (existingTargetDim !== targetDim) {
      throw new Error(`migrate: target "${to}" exists at ${existingTargetDim}d but the model produces ${targetDim}d`)
    }
    const present = await scrollIdsRaw(to)
    if (present.size > 0) {
      const sourceIds = new Set(notes.map((n) => n.id))
      const foreign = [...present].filter((id) => !sourceIds.has(id))
      if (foreign.length > 0) {
        throw new Error(
          `migrate: target "${to}" holds ${foreign.length} point(s) that are not in "${from}" ` +
            `(e.g. ${foreign[0]}). That is not an interrupted migration — use a different target.`
        )
      }
      alreadyDone = present
      log(`[migrate] resuming: ${present.size} of ${notes.length} already in ${to}`)
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
    // Written by an earlier run. Skipping it is the point of resuming: for the
    // notes that need re-extraction this is an LLM call not paid twice.
    if (alreadyDone.has(note.id)) continue

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
      log(`[migrate] ${alreadyDone.size + migrated}/${notes.length}`)
    }
  }
  await flush()

  const finalCount = await countPointsRaw(to)
  if (finalCount !== notes.length) {
    warn(`[migrate] target holds ${finalCount} point(s) but the source had ${notes.length} — check before switching`)
  }

  log(`[migrate] done: ${migrated} written, ${alreadyDone.size} already present, ${refreshed} re-extracted.`)

  return {
    total: notes.length,
    missingDerived,
    refreshed,
    migrated,
    skipped: alreadyDone.size,
    sourceDim,
    targetDim,
    model,
    dryRun: false,
  }
}

/**
 * Put the migrated collection behind the name the source used, and drop the
 * source.
 *
 * This is the only irreversible step in the whole migration, which is why it is
 * a separate call rather than the tail of `migrateCollection`. Everything before
 * it leaves the original untouched and can simply be abandoned.
 *
 * Qdrant cannot rename a collection and cannot create an alias over a name a real
 * collection holds (409), so freeing the name means deleting it — after checking
 * the target holds at least as much as the source, because that check is the last
 * thing standing between a half-finished migration and a deleted store.
 */
export async function switchToMigrated(opts: {
  /** The name readers are configured with. Becomes an alias. */
  name: string
  /** The collection built by `migrateCollection`. */
  to: string
  /**
   * Snapshot the source before dropping it. Default true.
   *
   * Freeing the name means deleting the collection, but it does not have to mean
   * losing the data, and those should not be the same decision. The snapshot is
   * what makes "switch over" reversible and leaves "throw the old vectors away"
   * as a separate thing to do later, by hand, once the new store has proven
   * itself in use.
   */
  snapshot?: boolean
  logger?: { info: (m: string) => void; warn: (m: string) => void }
}): Promise<{ name: string; to: string; moved: number; snapshot?: { name: string; size: number } }> {
  const { name, to } = opts
  const log = opts.logger?.info ?? ((m: string) => console.log(m))

  if (name === to) throw new Error(`switch: "${name}" and "${to}" are the same collection`)

  let snap: { name: string; size: number } | undefined
  const already = await resolveAliasRaw(name)
  if (already === to) {
    log(`[switch] "${name}" already points at "${to}" — nothing to do`)
    return { name, to, moved: await countPointsRaw(to) }
  }

  const targetCount = await countPointsRaw(to)
  if (targetCount === 0) throw new Error(`switch: "${to}" is empty — migrate into it first`)

  if (already === null) {
    // `name` is a real collection: the pre-migration store. Verify before it goes.
    const sourceCount = await countPointsRaw(name)
    if (targetCount < sourceCount) {
      throw new Error(
        `switch: "${to}" holds ${targetCount} point(s) but "${name}" still holds ${sourceCount}. ` +
          `The migration is not finished — run it again before switching.`
      )
    }
    log(`[switch] verified ${targetCount} in "${to}" against ${sourceCount} in "${name}"`)
    if (opts.snapshot !== false) {
      snap = await snapshotCollectionRaw(name)
      log(`[switch] snapshotted "${name}" → ${snap.name} (${(snap.size / 1e6).toFixed(0)} MB)`)
    }
    await deleteCollectionRaw(name)
    log(`[switch] dropped "${name}"`)
    // create, not set: setAliasRaw deletes first, and there is no alias to
    // delete on a name that was a real collection a moment ago.
    await createAliasRaw(name, to)
  } else {
    // `name` is already an alias pointing somewhere else — a later migration.
    // Nothing to delete, and the swap is atomic.
    await setAliasRaw(name, to)
  }

  log(`[switch] "${name}" now resolves to "${to}"`)
  return { name, to, moved: targetCount, snapshot: snap }
}

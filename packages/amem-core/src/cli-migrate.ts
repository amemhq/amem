#!/usr/bin/env node
/**
 * amem-migrate — rebuild a collection under a different embedding model.
 *
 * This exists because `EmbeddingDimensionMismatchError` has to end in a command
 * someone can paste. Describing the procedure in prose is what the error message
 * used to do, and prose is not runnable at 2am when memory has stopped working.
 *
 * The engine is a library and never migrates on its own — re-embedding a whole
 * store is minutes of work and a decision the operator makes, not something an
 * import should trigger. So the policy lives here, in a command, and
 * `migrateCollection()` stays a plain function for anyone embedding the engine.
 */
import { migrateCollection } from './migrate.js'
import { getCollection } from './storage.js'
import { getEmbeddingModel } from './embedding.js'

const USAGE = `amem-migrate — rebuild a collection under the current embedding model

  npx --package=@amemhq/core amem-migrate --to <collection> [options]

Options
  --to <name>           Target collection. Required. Must not already hold points.
  --from <name>         Source collection. Defaults to AMEM_COLLECTION.
  --apply               Actually write. Without this it is a dry run.
  --no-refresh-fields   Skip re-extracting keywords/tags for notes that never
                        had them. Faster, and makes no LLM calls at all.
  -h, --help

The model is whatever AMEM_EMBED_MODEL says, so set that first:

  AMEM_EMBED_MODEL=Xenova/bge-m3 \\
    npx --package=@amemhq/core amem-migrate --to amem_notes_v2 --apply

The source is only ever read. If the result looks wrong, point AMEM_COLLECTION
back at it and nothing has been lost.`

export interface MigrateArgs {
  help: boolean
  to?: string
  from?: string
  dryRun: boolean
  refreshFields: boolean
}

/**
 * Exported so the defaults can be asserted. `dryRun` in particular: invert that
 * boolean and the command writes to a store while telling the operator it is
 * only looking.
 */
export function parseArgs(argv: string[]): MigrateArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  return {
    help: argv.includes('-h') || argv.includes('--help'),
    to: value('--to'),
    from: value('--from'),
    dryRun: !argv.includes('--apply'),
    refreshFields: !argv.includes('--no-refresh-fields'),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const to = args.to
  if (!to) {
    console.error('amem-migrate: --to <collection> is required\n')
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  const from = args.from ?? getCollection()
  const { dryRun, refreshFields } = args

  console.log(`model:  ${getEmbeddingModel()}`)
  console.log(`from:   ${from}`)
  console.log(`to:     ${to}`)
  console.log(`mode:   ${dryRun ? 'dry run — nothing will be written' : 'APPLY'}\n`)

  const result = await migrateCollection({ from, to, dryRun, refreshFields })

  console.log(`\n${result.total} notes in source (${result.sourceDim}-dim)`)
  console.log(`target is ${result.targetDim}-dim`)
  if (result.missingDerived > 0) {
    console.log(
      `${result.missingDerived} note(s) predate the extraction pipeline` +
        (refreshFields ? `, ${result.refreshed} re-extracted` : ' — skipped (--no-refresh-fields)')
    )
  }

  if (dryRun) {
    console.log(`\nNothing was written. Re-run with --apply to migrate.`)
    return
  }

  console.log(`\n${result.migrated} notes written to "${to}".`)
  console.log(`Point AMEM_COLLECTION at "${to}" to start using it. "${from}" is untouched.`)
}

main().catch((err: unknown) => {
  console.error(`amem-migrate: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})

#!/usr/bin/env node
/**
 * amem-migrate — move a memory store onto a different embedding model.
 *
 * Written for the person who got here from an error message, not for someone
 * embedding the engine. A developer using `@amemhq/core` directly has
 * `migrateCollection()` and `switchToMigrated()` and can sequence them however
 * their deployment wants; this is the other audience, who installed a plugin and
 * whose memory has stopped working.
 *
 * So it takes no decisions from the caller that it can take itself. It works out
 * which phase the store is in, does the next safe thing, and prints the one
 * command that comes after. The target collection name is derived; nobody has to
 * know Qdrant has collections at all.
 *
 * Exactly one step is irreversible — dropping the old collection to free its name
 * for the alias — and that one has its own flag rather than being the tail of a
 * run that started out read-only.
 */
import { migrateCollection, switchToMigrated } from './migrate.js'
import { getCollection, collectionDimRaw, countPointsRaw, scrollIdsRaw, resolveAliasRaw } from './storage.js'
import { getEmbeddingModel, getEmbeddingDim } from './embedding.js'

const USAGE = `amem-migrate — move a memory store onto a different embedding model

  amem-migrate              what state the store is in, and what comes next
  amem-migrate --apply      do the next step; safe to interrupt and re-run
  amem-migrate --switch     put the new store behind the old name (irreversible)

Options
  --from-collection <name>  the store to migrate. Defaults to AMEM_COLLECTION.
  --to-collection <name>    where to build it. Derived from the source if omitted.
  --no-refresh-fields       skip re-extracting keywords for notes that never had
                            them. Makes the run completely offline.
  -h, --help

  AMEM_MODEL_CACHE=<dir>    where model weights are cached. Set the same value
                            everywhere and the plugin and this command share one
                            copy instead of downloading it each.
  AMEM_MODEL_DIR=<dir>      read weights already on disk instead of downloading.

Migrates onto amem's current default unless AMEM_EMBED_MODEL says otherwise:

  AMEM_EMBED_MODEL=Alibaba-NLP/gte-multilingual-base amem-migrate --apply

Stop your agent before --apply, not before this. The bare run only downloads and
reports, and the download is the long part — leaving the agent up through it costs
nothing, while writing underneath a running agent means notes arrive after the
rebuild has read them and you have to run --apply again.

Roughly: the download is your bandwidth (2.27 GB for the default), the rebuild is
your CPU (about 3 notes a second on an M4), and notes missing keywords cost one
LLM call each.

Nothing before --switch touches the original. If a run looks wrong, delete the
target and start again.`

export interface MigrateArgs {
  help: boolean
  apply: boolean
  switchOver: boolean
  from?: string
  to?: string
  refreshFields: boolean
}

export function parseArgs(argv: string[]): MigrateArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  return {
    // `help` as a bare word too. Without it, typing what most CLIs accept starts
    // a multi-gigabyte model download instead of printing anything.
    help: argv.includes('-h') || argv.includes('--help') || argv[0] === 'help',
    apply: argv.includes('--apply'),
    switchOver: argv.includes('--switch'),
    from: value('--from-collection'),
    to: value('--to-collection'),
    refreshFields: !argv.includes('--no-refresh-fields'),
  }
}

/**
 * `amem_notes` → `amem_notes_v2`, and `amem_notes_v2` → `amem_notes_v3`.
 *
 * Derived rather than asked for: the name is an implementation detail of a
 * mechanism the user is not supposed to have to learn, and a wrong guess at it is
 * how you end up with two half-migrated stores.
 */
export function deriveTarget(source: string): string {
  const m = source.match(/^(.*)_v(\d+)$/)
  return m ? `${m[1]}_v${Number(m[2]) + 1}` : `${source}_v2`
}

/**
 * The collection flags this run was given, so every "now run …" line it prints is
 * copy-pasteable as-is.
 *
 * Without it a mode B operator who passed `--from-collection` would be told to run
 * a bare `amem-migrate --apply`, which falls back to AMEM_COLLECTION and migrates
 * a different store. Only the collection flags are carried: forgetting
 * `--no-refresh-fields` costs an LLM call, forgetting these loses the plot.
 */
export function carried(args: MigrateArgs): string {
  return (args.from ? ` --from-collection ${args.from}` : '') + (args.to ? ` --to-collection ${args.to}` : '')
}

type Phase =
  | { kind: 'no-source' }
  | { kind: 'already-current'; model: string }
  | { kind: 'not-started'; notes: number }
  | { kind: 'partial'; done: number; notes: number }
  | { kind: 'ready-to-switch'; notes: number }
  | { kind: 'switched'; points: number }

async function detect(from: string, to: string): Promise<Phase> {
  const alias = await resolveAliasRaw(from)
  if (alias !== null) return { kind: 'switched', points: await countPointsRaw(from) }

  const sourceDim = await collectionDimRaw(from)
  if (sourceDim === null) return { kind: 'no-source' }

  const modelDim = await getEmbeddingDim()
  if (sourceDim === modelDim) return { kind: 'already-current', model: getEmbeddingModel() }

  const notes = await countPointsRaw(from)
  const targetDim = await collectionDimRaw(to)
  if (targetDim === null) return { kind: 'not-started', notes }

  const done = (await scrollIdsRaw(to)).size
  return done >= notes ? { kind: 'ready-to-switch', notes } : { kind: 'partial', done, notes }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const from = args.from ?? getCollection()
  const to = args.to ?? deriveTarget(from)
  const flags = carried(args)
  const phase = await detect(from, to)

  console.log(`store:  ${from}`)
  console.log(`model:  ${getEmbeddingModel()}`)

  switch (phase.kind) {
    case 'no-source':
      console.error(`\nNo collection named "${from}". Nothing to migrate.`)
      process.exitCode = 1
      return

    case 'switched':
      console.log(`\n"${from}" is already an alias — ${phase.points} notes, nothing to do.`)
      return

    case 'already-current':
      console.log(`\nAlready on ${phase.model}. Nothing to migrate.`)
      return

    case 'not-started':
      if (!args.apply) {
        console.log(`\n${phase.notes} notes to rebuild into "${to}".`)
        console.log(`Run "amem-migrate${flags} --apply" to start. "${from}" is only read.`)
        return
      }
      break

    case 'partial':
      if (!args.apply) {
        console.log(`\n${phase.done} of ${phase.notes} rebuilt into "${to}".`)
        console.log(`Run "amem-migrate${flags} --apply" to carry on from there.`)
        return
      }
      break

    case 'ready-to-switch':
      if (!args.switchOver) {
        console.log(`\nAll ${phase.notes} notes are in "${to}". "${from}" is untouched.`)
        console.log(`Check it, then run "amem-migrate${flags} --switch" to put "${to}" behind the name "${from}".`)
        console.log(`That drops "${from}" and cannot be undone.`)
        return
      }
      {
        const res = await switchToMigrated({ name: from, to })
        console.log(`\nDone. Nothing to change in your config — "${from}" now resolves to "${to}".`)
        if (res.snapshot) {
          console.log(`\nThe old store is kept as a snapshot, ${(res.snapshot.size / 1e6).toFixed(0)} MB:`)
          console.log(`  <qdrant storage>/snapshots/${from}/${res.snapshot.name}`)
          // Not a curl: once "${from}" is an alias, the snapshot API resolves it
          // to the new collection and reports none. The file is the only handle.
          console.log(`Delete that file once the new store has proven itself. Nothing else will.`)
        }
      }
      return
  }

  if (args.switchOver) {
    console.error(`\nNot finished yet — run "amem-migrate${flags} --apply" until it is before switching.`)
    process.exitCode = 1
    return
  }

  const result = await migrateCollection({ from, to, dryRun: false, refreshFields: args.refreshFields })
  console.log(`\n${result.migrated + result.skipped} of ${result.total} rebuilt.`)
  if (result.migrated + result.skipped >= result.total) {
    console.log(`Check "${to}", then run "amem-migrate${flags} --switch".`)
  } else {
    console.log(`Run "amem-migrate${flags} --apply" again to carry on.`)
  }
}

main().catch((err: unknown) => {
  console.error(`amem-migrate: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})

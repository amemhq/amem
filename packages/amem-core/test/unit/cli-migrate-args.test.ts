/**
 * amem-migrate argument defaults.
 *
 * The one that matters is `dryRun`. Invert it and the command rebuilds a
 * collection while telling the operator it is only reporting — the failure is
 * silent, destructive to the target, and only noticed afterwards. So the default
 * is asserted rather than assumed.
 */
import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../src/cli-migrate.js'

describe('parseArgs', () => {
  it('defaults to a dry run, so writing is always something you asked for', () => {
    expect(parseArgs(['--to', 'x']).dryRun).toBe(true)
  })

  it('writes only with --apply', () => {
    expect(parseArgs(['--to', 'x', '--apply']).dryRun).toBe(false)
  })

  it('defaults to refreshing fields, and --no-refresh-fields turns it off', () => {
    expect(parseArgs(['--to', 'x']).refreshFields).toBe(true)
    expect(parseArgs(['--to', 'x', '--no-refresh-fields']).refreshFields).toBe(false)
  })

  it('reads --to and --from', () => {
    const a = parseArgs(['--from', 'old', '--to', 'new'])
    expect(a.from).toBe('old')
    expect(a.to).toBe('new')
  })

  it('leaves --from undefined so the caller can fall back to AMEM_COLLECTION', () => {
    // Resolving the default here would bake the collection name into two places.
    expect(parseArgs(['--to', 'x']).from).toBeUndefined()
  })

  it('reports missing --to rather than inventing a target', () => {
    expect(parseArgs([]).to).toBeUndefined()
    expect(parseArgs(['--apply']).to).toBeUndefined()
  })

  it('treats a trailing --to with no value as missing', () => {
    // `--to` last on the line reads argv[i+1] off the end. Must not become the
    // string "undefined" or a silent empty target.
    expect(parseArgs(['--apply', '--to']).to).toBeUndefined()
  })

  it('recognises both help spellings', () => {
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['--to', 'x']).help).toBe(false)
  })
})

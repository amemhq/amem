/**
 * amem-migrate argument and target-name handling.
 *
 * The command works out which phase the store is in and does the next safe
 * thing, so the flags are only ever confirmations: `--apply` for the work that
 * leaves the original intact, `--switch` for the one step that does not. Getting
 * either to default on would make an invocation destroy something the person
 * running it was only inspecting.
 */
import { describe, it, expect } from 'vitest'
import { parseArgs, deriveTarget, carried } from '../../src/cli-migrate.js'

describe('parseArgs', () => {
  it('does nothing without a flag, so a bare run is always safe to type', () => {
    const a = parseArgs([])
    expect(a.apply).toBe(false)
    expect(a.switchOver).toBe(false)
  })

  it('reads --apply and --switch independently', () => {
    expect(parseArgs(['--apply']).apply).toBe(true)
    expect(parseArgs(['--apply']).switchOver).toBe(false)
    expect(parseArgs(['--switch']).switchOver).toBe(true)
    expect(parseArgs(['--switch']).apply).toBe(false)
  })

  it('names the collection flags, because the short form did not say what it took', () => {
    const a = parseArgs(['--from-collection', 'old', '--to-collection', 'new'])
    expect(a.from).toBe('old')
    expect(a.to).toBe('new')
  })

  it('leaves both collections undefined so the caller can derive them', () => {
    // Resolving defaults here would put the AMEM_COLLECTION fallback and the
    // target-naming rule in two places each.
    const a = parseArgs([])
    expect(a.from).toBeUndefined()
    expect(a.to).toBeUndefined()
  })

  it('treats a trailing collection flag with no value as absent', () => {
    // Reads argv[i+1] off the end; must not become the string "undefined".
    expect(parseArgs(['--to-collection']).to).toBeUndefined()
    expect(parseArgs(['--apply', '--from-collection']).from).toBeUndefined()
  })

  it('refreshes fields unless told not to', () => {
    expect(parseArgs([]).refreshFields).toBe(true)
    expect(parseArgs(['--no-refresh-fields']).refreshFields).toBe(false)
  })

  it('recognises both help spellings', () => {
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['--apply']).help).toBe(false)
  })
})

describe('deriveTarget', () => {
  it('starts at v2', () => {
    expect(deriveTarget('amem_notes')).toBe('amem_notes_v2')
  })

  it('counts up from an existing version rather than nesting', () => {
    // amem_notes_v2_v2 would work and would be unreadable a year later.
    expect(deriveTarget('amem_notes_v2')).toBe('amem_notes_v3')
    expect(deriveTarget('amem_notes_v9')).toBe('amem_notes_v10')
  })

  it('handles a mode B collection name the same way', () => {
    expect(deriveTarget('amem_alice')).toBe('amem_alice_v2')
  })

  it('does not treat a v-like suffix that is not a version as one', () => {
    expect(deriveTarget('memories_v')).toBe('memories_v_v2')
    expect(deriveTarget('notes_vault')).toBe('notes_vault_v2')
  })
})

describe('carried', () => {
  it('adds nothing when the defaults were used', () => {
    expect(carried(parseArgs([]))).toBe('')
    expect(carried(parseArgs(['--apply']))).toBe('')
  })

  it('repeats the collection flags into the next command', () => {
    // The mode B case. "Run amem-migrate --apply" without these falls back to
    // AMEM_COLLECTION and rebuilds a store the operator was not looking at.
    expect(carried(parseArgs(['--from-collection', 'amem_alice']))).toBe(' --from-collection amem_alice')
    expect(carried(parseArgs(['--from-collection', 'a', '--to-collection', 'b']))).toBe(
      ' --from-collection a --to-collection b'
    )
  })

  it('leaves out --no-refresh-fields', () => {
    // Deliberate: forgetting it costs an LLM call on notes that never had
    // keywords, forgetting a collection migrates the wrong store.
    expect(carried(parseArgs(['--no-refresh-fields']))).toBe('')
  })
})

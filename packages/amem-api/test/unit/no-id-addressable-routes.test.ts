/**
 * The HTTP surface must not let a caller name a note by id.
 *
 * `getNote`, `updateNoteContent` and `invalidateNote` take a note id and reach
 * one note directly, bypassing the agent-filtered query that every other read
 * goes through. Today no route calls them, so no request body can steer them —
 * but that is an accident of what has been built, not a decision anything
 * records. An audit found it by grepping; the next person to add
 * `GET /v1/memories/:id` would undo it with nothing objecting.
 *
 * So this is an architecture test, and it is deliberately a source-level one: the
 * property is "these functions are not reachable from a request", and no
 * behavioural test can show the absence of a route that does not exist yet.
 *
 * If a future route genuinely needs by-id access, this test should be changed —
 * but changing it is the point. It forces the identity question to be answered
 * out loud rather than inherited from whatever the caller happened to pass.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../../src', import.meta.url).pathname

/** Every .ts file under src, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sources(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

const BY_ID = ['getNote', 'updateNoteContent', 'invalidateNote'] as const

describe('the service exposes no by-id note access', () => {
  const files = sources(SRC)

  it('finds the source files it means to check', () => {
    // Without this, a rename of src/ would turn every assertion below into a
    // vacuous pass over an empty list.
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f) => f.endsWith('app.ts'))).toBe(true)
  })

  it.each(BY_ID)('never calls %s', (fn) => {
    const callers = files.filter((f) => new RegExp(`\\b${fn}\\s*\\(`).test(readFileSync(f, 'utf8')))
    expect(callers).toEqual([])
  })

  it('never imports them from the engine either', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const imports = src.match(/import\s*\{[^}]*\}\s*from\s*['"]@amemhq\/core['"]/gs) ?? []
      for (const block of imports) {
        for (const fn of BY_ID) {
          expect(block).not.toContain(fn)
        }
      }
    }
  })
})

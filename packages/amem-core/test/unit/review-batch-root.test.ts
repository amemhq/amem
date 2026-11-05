/**
 * With AMEM_REVIEW_DIR unset, review batches go to `amem-reviews` in the data directory,
 * not to the process's working directory, which for a gateway can be the agent workspace.
 * A real temp directory, so the exclusive-create write is exercised too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Lets a test hide the directory's contents from the next readdirSync, as if another process
// wrote a batch between this one reading the directory and writing.
const fsHook = vi.hoisted(() => ({ hideNextListing: false }))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const readdirSync = ((...args: Parameters<typeof real.readdirSync>) => {
    if (!fsHook.hideNextListing) return real.readdirSync(...args)
    fsHook.hideNextListing = false
    return []
  }) as typeof real.readdirSync
  return { ...real, readdirSync }
})
vi.mock('../../src/storage.js', () => ({
  listNotes: vi.fn(async () => []),
  patchNotePayload: vi.fn(),
}))

import { configure } from '../../src/config.js'
import { generateReviewBatch } from '../../src/quality.js'

let dataDir: string

beforeEach(() => {
  vi.stubEnv('AMEM_REVIEW_DIR', '')
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amem-review-root-'))
  configure({ dataDir })
})
afterEach(() => vi.unstubAllEnvs())

describe('the review root', () => {
  it('defaults to amem-reviews in the data directory, read at call time', async () => {
    const out = await generateReviewBatch('a')
    expect(path.dirname(out)).toBe(path.join(dataDir, 'amem-reviews'))
    expect(fs.existsSync(out)).toBe(true)
  })

  it('takes the next number when another process wrote the one it picked', async () => {
    // The other process's batch1 lands between this one reading the directory and writing.
    const dir = path.join(dataDir, 'amem-reviews')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'amem-review-batch1.md'), 'theirs')
    fsHook.hideNextListing = true

    const out = await generateReviewBatch('a')

    expect(path.basename(out)).toBe('amem-review-batch2.md')
    expect(fs.readFileSync(path.join(dir, 'amem-review-batch1.md'), 'utf8')).toBe('theirs')
  })

  it('refuses to overwrite a file that already has the name', async () => {
    const target = path.join(dataDir, 'amem-reviews', 'amem-review-weekly.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'kept')

    await expect(generateReviewBatch('a', 'amem-review-weekly.md')).rejects.toThrow(/EEXIST/)
    expect(fs.readFileSync(target, 'utf8')).toBe('kept')
  })
})

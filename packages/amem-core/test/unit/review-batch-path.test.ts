import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'

// generateReviewBatch writes under AMEM_REVIEW_DIR. Point that at a temp dir.
const ROOT = vi.hoisted(() => {
  const p = require('path').join(require('os').tmpdir(), 'amem-review-batch-test')
  process.env.AMEM_REVIEW_DIR = p
  return p
})

// Mock the fs sinks so the test neither touches the disk nor constructs a real
// fs path from an env-derived root — reading mock.calls is a sharper assertion
// than probing the filesystem. scanLowQuality is mocked away too; it is only
// reached after the filename guard, so the reject-cases never hit it.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return { ...real, writeFileSync: vi.fn(), mkdirSync: vi.fn() }
})
vi.mock('../../src/storage.js', () => ({
  listNotes: vi.fn(async () => []),
  patchNotePayload: vi.fn(),
}))

import * as fs from 'fs'
import { generateReviewBatch } from '../../src/quality.js'

beforeEach(() => vi.clearAllMocks())

describe('generateReviewBatch outputPath confinement', () => {
  const reject = (p: string) => expect(generateReviewBatch('a', p)).rejects.toThrow(/amem-review-<name>\.md/)

  it('rejects an absolute path', () => reject('/etc/passwd'))
  it('rejects a ../ traversal', () => reject('../../../evil.md'))
  it('rejects a path carrying a directory component', () => reject('sub/amem-review-x.md'))
  it('rejects "." and ".." which would collapse onto the root directory', async () => {
    await reject('.')
    await reject('..')
  })
  // A bare name was enough before. ClawHub's review of 2.1.8 showed it could be AGENTS.md.
  it('rejects a bare name that is not a review batch', async () => {
    for (const name of ['AGENTS.md', '.bashrc', 'openclaw.json', 'review.md', 'amem-review-x.txt']) await reject(name)
  })

  it('writes nothing when it rejects', async () => {
    await reject('/etc/passwd')
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('accepts a review batch name and writes it into the review root', async () => {
    const out = await generateReviewBatch('a', 'amem-review-weekly.md')
    expect(out).toBe(path.join(ROOT, 'amem-review-weekly.md'))
    expect(fs.writeFileSync).toHaveBeenCalledOnce()
    expect(vi.mocked(fs.writeFileSync).mock.calls[0][0]).toBe(path.join(ROOT, 'amem-review-weekly.md'))
  })

  it('never overwrites: it writes with the exclusive-create flag', async () => {
    await generateReviewBatch('a')
    expect(vi.mocked(fs.writeFileSync).mock.calls[0][2]).toMatchObject({ flag: 'wx' })
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  msUntil,
  scheduleNightly,
  cancelNightly,
  markOwed,
  readOwed,
  settleOwed,
  utcDatesSince,
} from '../../src/nightly.js'

const SLOT = Symbol.for('openclaw-amem.nightly-timer')
const noop = () => {}
const pending = () => (globalThis as Record<symbol, unknown>)[SLOT] as NodeJS.Timeout | undefined

afterEach(() => {
  cancelNightly()
  vi.useRealTimers()
})

describe('msUntil', () => {
  it('counts to 02:30 today when it is still before it', () => {
    expect(msUntil(2, 30, new Date(2026, 8, 25, 1, 30))).toBe(60 * 60 * 1000)
  })

  it('counts to 02:30 tomorrow once it has passed, and at 02:30 exactly', () => {
    expect(msUntil(2, 30, new Date(2026, 8, 25, 3, 30))).toBe(23 * 60 * 60 * 1000)
    expect(msUntil(2, 30, new Date(2026, 8, 25, 2, 30))).toBe(24 * 60 * 60 * 1000)
  })
})

describe('scheduleNightly', () => {
  it('does not hold the process open', () => {
    // A pending 02:30 timer kept every plugin-loading CLI command from exiting.
    scheduleNightly(async () => {}, noop)
    expect(pending()?.hasRef()).toBe(false)
  })

  it('runs one job per process however many times register() schedules it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 25, 1, 0))
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})

    scheduleNightly(first, noop)
    scheduleNightly(second, noop)
    await vi.advanceTimersByTimeAsync(90 * 60 * 1000)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('schedules the next night after running', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 25, 1, 0))
    const job = vi.fn(async () => {})

    scheduleNightly(job, noop)
    await vi.advanceTimersByTimeAsync(90 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(job).toHaveBeenCalledTimes(2)
  })

  it('reports a job that throws instead of letting the rejection escape, and runs again', async () => {
    // An unhandled rejection from a timer callback exits the process: the gateway, at 02:30.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 25, 1, 0))
    const job = vi.fn(async () => {
      throw new Error('qdrant down')
    })
    const onError = vi.fn()

    scheduleNightly(job, onError)
    await vi.advanceTimersByTimeAsync(90 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(onError).toHaveBeenCalledTimes(2)
    expect(String(onError.mock.calls[0][0])).toContain('qdrant down')
    expect(job).toHaveBeenCalledTimes(2)
  })

  it('does not let a job that was running during a re-register take the slot back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 25, 1, 0))
    let finishStale!: () => void
    const stale = vi.fn(() => new Promise<void>((resolve) => (finishStale = resolve)))
    const fresh = vi.fn(async () => {})

    scheduleNightly(stale, noop)
    await vi.advanceTimersByTimeAsync(90 * 60 * 1000) // stale starts and is still running
    scheduleNightly(fresh, noop) // a config reload re-registers mid-job
    finishStale()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(stale).toHaveBeenCalledTimes(1)
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it('stops when cancelled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 25, 1, 0))
    const job = vi.fn(async () => {})

    scheduleNightly(job, noop)
    cancelNightly()
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000)

    expect(job).not.toHaveBeenCalled()
    expect(pending()).toBeUndefined()
  })
})

describe('utcDatesSince', () => {
  it('covers yesterday and today when there has been no run', () => {
    expect(utcDatesSince(undefined, new Date('2026-09-25T18:30:00Z'))).toEqual(['2026-09-24', '2026-09-25'])
  })

  it('visits the UTC day of the last run again, because 02:30 local falls partway through it', () => {
    // 02:30 in UTC+8 is 18:30 UTC. Notes written after that on the 24th were not read last night.
    expect(utcDatesSince(new Date('2026-09-24T18:30:00Z'), new Date('2026-09-25T18:30:00Z'))).toEqual([
      '2026-09-24',
      '2026-09-25',
    ])
  })

  it('covers every day a missed night skipped', () => {
    expect(utcDatesSince(new Date('2026-09-22T18:30:00Z'), new Date('2026-09-25T18:30:00Z'))).toEqual([
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ])
  })

  it('keeps only the most recent seven days after a long gap', () => {
    const days = utcDatesSince(new Date('2026-08-01T00:00:00Z'), new Date('2026-09-25T18:30:00Z'))
    expect(days).toHaveLength(7)
    expect(days[0]).toBe('2026-09-19')
    expect(days[6]).toBe('2026-09-25')
  })
})

describe('owed agents', () => {
  const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amem-owed-')), 'sub', 'owed.json')

  it('records each agent once, and creates the directory', () => {
    const file = fresh()
    markOwed(file, 'main')
    markOwed(file, 'dev')
    markOwed(file, 'main')
    expect(readOwed(file).agents.sort()).toEqual(['dev', 'main'])
    expect(readOwed(file).lastRun).toBeUndefined()
  })

  it('treats a missing or corrupt file as nothing owed', () => {
    const file = fresh()
    expect(readOwed(file)).toEqual({ agents: [], lastRun: undefined })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json')
    expect(readOwed(file).agents).toEqual([])
    markOwed(file, 'main')
    expect(readOwed(file).agents).toEqual(['main'])
  })

  it('keeps an agent that wrote after the run began, and records when the run began', () => {
    const file = fresh()
    const startedAt = new Date('2026-09-25T18:30:00Z')
    markOwed(file, 'main', new Date('2026-09-25T10:00:00Z'))
    markOwed(file, 'dev', new Date('2026-09-25T18:30:05Z')) // wrote while the run was reading

    settleOwed(file, startedAt)

    expect(readOwed(file).agents).toEqual(['dev'])
    expect(readOwed(file).lastRun?.toISOString()).toBe(startedAt.toISOString())
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { msUntil, scheduleNightly, cancelNightly } from '../../src/nightly.js'

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

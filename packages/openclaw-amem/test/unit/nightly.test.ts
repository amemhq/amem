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
  settleAgent,
  utcDatesSince,
  noteAgentEvent,
  watchAgentEvents,
  unwatchAgentEvents,
  foregroundWorkStarted,
  compactionStarted,
  compactionEnded,
  noteMessageReceived,
  foregroundBusy,
  busySinceNow,
  makeIdleWaiter,
  runStep,
  runNightly,
  type NightlyWork,
  STALE_MS,
  QUIET_MS,
  MAX_ATTEMPTS,
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

const FOREGROUND = Symbol.for('openclaw-amem.foreground')
const resetForeground = () => {
  unwatchAgentEvents()
  delete (globalThis as Record<symbol, unknown>)[FOREGROUND]
}
const freshFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amem-owed-')), 'sub', 'owed.json')

describe('owed agents', () => {
  it('records each agent once, from its earliest write not yet merged, and creates the directory', () => {
    const file = freshFile()
    markOwed(file, 'main', new Date('2026-09-23T10:00:00Z'))
    markOwed(file, 'dev', new Date('2026-09-24T10:00:00Z'))
    markOwed(file, 'main', new Date('2026-09-25T10:00:00Z'))
    const owed = readOwed(file)
    expect([...owed.keys()].sort()).toEqual(['dev', 'main'])
    expect(owed.get('main')?.toISOString()).toBe('2026-09-23T10:00:00.000Z')
  })

  it('reads from when the writes began, so a write that straddles UTC midnight keeps its day', () => {
    // A note is dated when its write starts; the record is made after the writes end.
    const file = freshFile()
    markOwed(file, 'dev', new Date('2026-09-25T23:59:50Z'), new Date('2026-09-26T00:00:10Z'))
    expect(utcDatesSince(readOwed(file).get('dev'), new Date('2026-09-26T18:30:00Z'))).toEqual([
      '2026-09-25',
      '2026-09-26',
    ])
  })

  it('treats a missing or corrupt file as nothing owed', () => {
    const file = freshFile()
    expect(readOwed(file).size).toBe(0)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json')
    expect(readOwed(file).size).toBe(0)
    markOwed(file, 'main', new Date())
    expect([...readOwed(file).keys()]).toEqual(['main'])
  })

  it('settles one agent at a time, and keeps one that wrote after the run began, from then', () => {
    const file = freshFile()
    const startedAt = new Date('2026-09-25T18:30:00Z')
    const at = (iso: string) => new Date(iso)
    markOwed(file, 'main', at('2026-09-25T10:00:00Z'), at('2026-09-25T10:00:00Z'))
    markOwed(file, 'dev', at('2026-09-24T10:00:00Z'), at('2026-09-24T10:00:00Z'))
    markOwed(file, 'dev', at('2026-09-25T18:30:05Z'), at('2026-09-25T18:30:05Z')) // wrote while the run was reading

    settleAgent(file, 'main', startedAt)
    expect([...readOwed(file).keys()]).toEqual(['dev'])

    settleAgent(file, 'dev', startedAt)
    expect(readOwed(file).get('dev')?.toISOString()).toBe(startedAt.toISOString())
  })
})

describe('what the gateway is doing', () => {
  const start = (runId: string, now?: number) =>
    noteAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' } }, now)
  const end = (runId: string, phase = 'end', session?: string) =>
    noteAgentEvent({ runId, stream: 'lifecycle', data: { phase }, sessionKey: session })

  afterEach(resetForeground)

  it('counts a run from its lifecycle start to its end or error', () => {
    start('r1')
    start('r2')
    expect(foregroundBusy()).toBe(true)
    end('r1')
    end('r2', 'error')
    expect(foregroundBusy()).toBe(false)
  })

  it('keeps a long run counted while it is doing anything', () => {
    const t0 = Date.now()
    start('long', t0)
    noteAgentEvent({ runId: 'long', stream: 'tool' }, t0 + STALE_MS - 1000)
    expect(foregroundBusy(t0 + STALE_MS + 1000)).toBe(true)
  })

  it('stops counting a run that has been silent past STALE_MS, in case its end never came', () => {
    const t0 = Date.now()
    start('lost', t0)
    expect(foregroundBusy(t0 + STALE_MS + 1)).toBe(false)
  })

  it('does not bring a run back for an event after its end', () => {
    // A memory flush reports its model after its end, and a fallback reports the switch.
    start('flush')
    end('flush')
    noteAgentEvent({ runId: 'flush', stream: 'lifecycle', data: { phase: 'model' } })
    noteAgentEvent({ runId: 'flush', stream: 'lifecycle', data: { phase: 'fallback' } })
    expect(foregroundBusy()).toBe(false)
  })

  it('does not count a run it never saw start', () => {
    noteAgentEvent({ runId: 'codex-thread:1', stream: 'execution' })
    expect(foregroundBusy()).toBe(false)
  })

  it("counts this plugin's agent_end until it is done, and each call on its own", () => {
    const doneA = foregroundWorkStarted()
    const doneB = foregroundWorkStarted()
    doneA()
    expect(foregroundBusy()).toBe(true)
    doneB()
    expect(foregroundBusy()).toBe(false)
  })

  it('counts a compaction until it ends, or until its session has a run that ends', () => {
    compactionStarted({ sessionKey: 's1' })
    expect(foregroundBusy()).toBe(true)
    compactionEnded({ sessionKey: 's1' })
    expect(foregroundBusy()).toBe(false)

    // after_compaction fires only when the compaction succeeds.
    compactionStarted({ sessionKey: 's2' })
    start('r1')
    end('r1', 'error', 's2')
    expect(foregroundBusy()).toBe(false)
  })

  it('keeps one subscription per process however many times it subscribes', () => {
    const listeners = new Set<(evt: object) => void>()
    const subscribe = (l: (evt: object) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
    watchAgentEvents(subscribe)
    watchAgentEvents(subscribe)
    expect(listeners.size).toBe(1)

    for (const l of listeners) l({ runId: 'r1', stream: 'lifecycle', data: { phase: 'start' } })
    expect(foregroundBusy()).toBe(true)

    unwatchAgentEvents()
    expect(listeners.size).toBe(0)
  })

  describe("a step's busy check", () => {
    it('stays false while nothing happens', () => {
      const busy = busySinceNow()
      expect(busy()).toBe(false)
    })

    it('turns true for good once a run has come and gone since the step began', () => {
      const busy = busySinceNow()
      start('short')
      end('short')
      expect(busy()).toBe(true)
    })

    it('turns true for a channel message, and for the end of agent_end', () => {
      const afterMessage = busySinceNow()
      noteMessageReceived({ providerUpdate: { kind: 'message' } })
      expect(afterMessage()).toBe(true)

      const done = foregroundWorkStarted()
      const afterWrites = busySinceNow()
      done()
      expect(afterWrites()).toBe(true)
    })
  })

  it('ignores an edited message, such as a live-location update, which starts no turn', () => {
    const busy = busySinceNow()
    noteMessageReceived({ providerUpdate: { kind: 'edited_message', editedTimestamp: 1 } })
    noteMessageReceived({ providerUpdate: { kind: 'edited_channel_post' } })
    expect(busy()).toBe(false)
  })

  describe('the wait between nightly steps', () => {
    it('lets the job through at once when the gateway has been quiet', async () => {
      const idle = makeIdleWaiter()
      expect(await idle.untilIdle()).toBe(true)
      expect(idle.waitedMs()).toBe(0)
    })

    it('waits for a run to end, then for QUIET_MS more, and adds up the wait', async () => {
      vi.useFakeTimers()
      start('r1')
      const idle = makeIdleWaiter(1000)
      let through = false
      const waiting = idle.untilIdle().then(() => (through = true))

      await vi.advanceTimersByTimeAsync(3000)
      end('r1')
      await vi.advanceTimersByTimeAsync(QUIET_MS - 1000)
      expect(through).toBe(false) // not in the pause between two turns

      await vi.advanceTimersByTimeAsync(2000)
      await waiting
      expect(through).toBe(true)
      expect(idle.waitedMs()).toBe(3000 + QUIET_MS)
    })

    it('waits QUIET_MS after agent_end finishes writing', async () => {
      vi.useFakeTimers()
      foregroundWorkStarted()() // started and done just now
      const idle = makeIdleWaiter(1000)
      let through = false
      const waiting = idle.untilIdle().then(() => (through = true))

      await vi.advanceTimersByTimeAsync(QUIET_MS - 1000)
      expect(through).toBe(false)
      await vi.advanceTimersByTimeAsync(2000)
      await waiting
      expect(through).toBe(true)
    })

    it("gives up once the night's waiting passes the cap", async () => {
      vi.useFakeTimers()
      start('r1')
      const idle = makeIdleWaiter(1000, 5000)
      const result = idle.untilIdle()

      await vi.advanceTimersByTimeAsync(6000)
      expect(await result).toBe(false)
    })

    it('does not hold the process open while it waits', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      start('r1')
      void makeIdleWaiter().untilIdle()
      await Promise.resolve()
      const timer = setTimeoutSpy.mock.results[0].value as NodeJS.Timeout
      expect(timer.hasRef()).toBe(false)
      clearTimeout(timer)
      setTimeoutSpy.mockRestore()
    })
  })
})

const PREEMPTED = new Error('preempted')
const isPreempted = (err: unknown) => err === PREEMPTED
const alwaysIdle = () => ({ untilIdle: vi.fn(async () => true), waitedMs: () => 0 })

describe('runStep', () => {
  it('runs a stopped step again from the start, after waiting for idle each time', async () => {
    const idle = alwaysIdle()
    const onPreempted = vi.fn()
    const attempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(PREEMPTED)
      .mockRejectedValueOnce(PREEMPTED)
      .mockResolvedValueOnce(undefined)

    expect(await runStep(idle, attempt, isPreempted, onPreempted)).toBe('done')
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(idle.untilIdle).toHaveBeenCalledTimes(3)
    expect(onPreempted).toHaveBeenCalledTimes(2)
  })

  it(`gives up after ${MAX_ATTEMPTS} attempts, so steady traffic cannot make it repeat all night`, async () => {
    const attempt = vi.fn(async () => {
      throw PREEMPTED
    })
    expect(await runStep(alwaysIdle(), attempt, isPreempted, noop)).toBe('stopped too often')
    expect(attempt).toHaveBeenCalledTimes(MAX_ATTEMPTS)
  })

  it('throws a real failure without running the step again', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('qdrant down')
    })
    await expect(runStep(alwaysIdle(), attempt, isPreempted, noop)).rejects.toThrow('qdrant down')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it("does not start the step once the night's waiting is used up", async () => {
    const attempt = vi.fn(async () => {})
    const idle = { untilIdle: async () => false }
    expect(await runStep(idle, attempt, isPreempted, noop)).toBe('out of waiting')
    expect(attempt).not.toHaveBeenCalled()
  })
})

describe('runNightly', () => {
  const NOW = new Date('2026-09-25T18:30:00Z') // 02:30 in UTC+8
  const logger = () => ({ info: vi.fn(), warn: vi.fn() })

  function night(over: Partial<NightlyWork> & Pick<NightlyWork, 'owedFile'>) {
    const calls: string[] = []
    const work: NightlyWork = {
      defaultAgent: 'main',
      mergeDay: async (agent, day) => void calls.push(`merge ${agent} ${day}`),
      after: [
        { name: 'consolidation', run: async () => void calls.push('consolidation') },
        { name: 'contradiction sweep', run: async () => void calls.push('sweep') },
      ],
      inBackground: (run) => run(),
      preempted: isPreempted,
      logger: logger(),
      idle: alwaysIdle(),
      ...over,
    }
    return { work, calls }
  }

  it('merges the default agent and every owed agent from its first unmerged day, then the other steps', async () => {
    const file = freshFile()
    const nine = new Date('2026-09-24T09:00:00Z')
    markOwed(file, 'dev', nine, nine)
    const { work, calls } = night({ owedFile: file })

    await runNightly(work, NOW)

    expect(calls).toEqual([
      'merge main 2026-09-24',
      'merge main 2026-09-25',
      'merge dev 2026-09-24',
      'merge dev 2026-09-25',
      'consolidation',
      'sweep',
    ])
    expect(readOwed(file).size).toBe(0)
  })

  it('keeps what a stopped night finished, and the next night goes on from the agents it did not settle', async () => {
    const file = freshFile()
    const nine = new Date('2026-09-25T09:00:00Z')
    markOwed(file, 'dev', nine, nine)
    markOwed(file, 'ops', nine, nine)
    const { work, calls } = night({
      owedFile: file,
      mergeDay: async (agent, day) => {
        if (agent === 'ops') throw PREEMPTED
        calls.push(`merge ${agent} ${day}`)
      },
    })

    await runNightly(work, NOW)

    expect(calls).not.toContain('consolidation') // the night ended at ops
    expect([...readOwed(file).keys()]).toEqual(['ops'])
    expect(work.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`stopped ${MAX_ATTEMPTS} times`))

    const next = night({ owedFile: file })
    await runNightly(next.work, new Date('2026-09-26T18:30:00Z'))
    expect(next.calls.filter((c) => c.startsWith('merge dev'))).toEqual([])
    expect(next.calls).toContain('merge ops 2026-09-25')
    expect(readOwed(file).size).toBe(0)
  })

  it('runs a stopped step again and finishes the night', async () => {
    const file = freshFile()
    let first = true
    const { work, calls } = night({
      owedFile: file,
      after: [
        {
          name: 'consolidation',
          run: async () => {
            if (first) {
              first = false
              throw PREEMPTED
            }
            calls.push('consolidation')
          },
        },
      ],
    })

    await runNightly(work, NOW)

    expect(calls).toContain('consolidation')
    expect(work.logger.info).toHaveBeenCalledWith(expect.stringContaining('consolidation stopped for a running task'))
  })

  it('logs a failed day and goes on, and a failed step does not stop the ones after it', async () => {
    const file = freshFile()
    const nine = new Date('2026-09-24T09:00:00Z')
    markOwed(file, 'dev', nine, nine)
    const { work, calls } = night({
      owedFile: file,
      mergeDay: async (agent, day) => {
        if (day === '2026-09-24') throw new Error('qdrant down')
        calls.push(`merge ${agent} ${day}`)
      },
      after: [
        {
          name: 'consolidation',
          run: async () => {
            throw new Error('boom')
          },
        },
        { name: 'contradiction sweep', run: async () => void calls.push('sweep') },
      ],
    })

    await runNightly(work, NOW)

    expect(calls).toEqual(['merge main 2026-09-25', 'merge dev 2026-09-25', 'sweep'])
    expect(work.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('merge failed (main, 2026-09-24) — qdrant down')
    )
    // Not settled: the next night reads the failed day again.
    expect(readOwed(file).get('dev')?.toISOString()).toBe(nine.toISOString())
    expect(work.logger.warn).toHaveBeenCalledWith(expect.stringContaining('nightly consolidation failed — boom'))
  })

  it('runs no further step once the waiting is used up, and settles nothing it did not merge', async () => {
    const file = freshFile()
    const nine = new Date('2026-09-25T09:00:00Z')
    markOwed(file, 'dev', nine, nine)
    const { work, calls } = night({ owedFile: file, idle: { untilIdle: async () => false, waitedMs: () => 3_600_000 } })

    await runNightly(work, NOW)

    expect(calls).toEqual([])
    expect([...readOwed(file).keys()]).toEqual(['dev'])
    expect(work.logger.warn).toHaveBeenCalledWith(expect.stringContaining('waited 60 min'))
  })
})

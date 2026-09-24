/**
 * The 02:30 job: one timer per process, and a timer that never holds the process open.
 *
 * register() can run more than once in a process. The gateway has been seen loading this
 * plugin as two module graphs 50-75 ms apart, and each call used to start its own timer
 * chain, which ran the nightly job 2-4 times concurrently every night, each copy
 * re-reading the same pairs and racing to merge the same notes. A module-level variable
 * cannot deduplicate across module graphs, so the handle lives on globalThis and the
 * latest registration owns it.
 *
 * The timer is unref'd. Every CLI command that loads plugins calls register() too, and a
 * pending 02:30 timer kept those processes from exiting: with the plugin enabled
 * `openclaw --help` was still running after 91 s, and with it disabled it exited in 5 s.
 * The gateway is held open by its own server, so this changes nothing there.
 *
 * Split out of index.ts with no engine imports so it can be unit-tested, like scope.ts.
 */

import * as fs from 'fs'
import * as path from 'path'

const SLOT = Symbol.for('openclaw-amem.nightly-timer')

type Holder = { [SLOT]?: ReturnType<typeof setTimeout> }

/** Milliseconds from `now` until the next hour:minute, local time. Now or past means tomorrow. */
export function msUntil(hour: number, minute: number, now: Date = new Date()): number {
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

/**
 * Run `job` at the next 02:30 and every 02:30 after it, replacing any job already
 * scheduled in this process.
 */
export function scheduleNightly(job: () => Promise<void>, onError: (err: unknown) => void): void {
  const holder = globalThis as Holder
  if (holder[SLOT]) clearTimeout(holder[SLOT])
  const timer = setTimeout(
    async () => {
      try {
        await job()
      } catch (err) {
        // A rejection escaping a timer callback is unhandled, and Node exits the process on
        // an unhandled rejection. The job reports its own failures; this is the backstop.
        onError(err)
      } finally {
        // A register() that ran while this job was running has already scheduled its own
        // next run. Rescheduling this closure would replace it with a stale one.
        if (holder[SLOT] === timer) scheduleNightly(job, onError)
      }
    },
    msUntil(2, 30)
  )
  timer.unref()
  holder[SLOT] = timer
}

export function cancelNightly(): void {
  const holder = globalThis as Holder
  if (holder[SLOT]) clearTimeout(holder[SLOT])
  delete holder[SLOT]
}

/**
 * Which agents the nightly merge owes, and when it last ran.
 *
 * The merge used to run inside agent_end, once per turn, for that turn's agent. The
 * nightly job has no session, so it has to be told which agents wrote. This is a file
 * rather than memory because the gateway restarts often, and an agent that wrote before
 * a restart and not after would otherwise never be merged. Writes are synchronous, so two
 * module graphs in one process cannot interleave a read-modify-write.
 */
interface Owed {
  lastRun?: string
  /** raw agent id → when it last wrote */
  agents: Record<string, string>
}

function readFile(file: string): Owed {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<Owed>
    return {
      lastRun: typeof data.lastRun === 'string' ? data.lastRun : undefined,
      agents: data.agents && typeof data.agents === 'object' ? { ...data.agents } : {},
    }
  } catch {
    return { agents: {} }
  }
}

function writeFile(file: string, owed: Owed): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(owed))
}

/** Record that `rawAgentId` wrote, so the next run merges it. Throws if the file cannot be written. */
export function markOwed(file: string, rawAgentId: string, now: Date = new Date()): void {
  const owed = readFile(file)
  owed.agents[rawAgentId] = now.toISOString()
  writeFile(file, owed)
}

export function readOwed(file: string): { agents: string[]; lastRun?: Date } {
  const owed = readFile(file)
  return { agents: Object.keys(owed.agents), lastRun: owed.lastRun ? new Date(owed.lastRun) : undefined }
}

/**
 * Close a run that started at `startedAt`. An agent that wrote after the run began stays
 * owed, because the run may have read that agent's notes before the write landed.
 */
export function settleOwed(file: string, startedAt: Date): void {
  const owed = readFile(file)
  for (const [id, at] of Object.entries(owed.agents)) {
    if (new Date(at).getTime() < startedAt.getTime()) delete owed.agents[id]
  }
  owed.lastRun = startedAt.toISOString()
  writeFile(file, owed)
}

/**
 * The UTC dates a run covers: from the day of the last run to today, at most `maxDays`.
 *
 * Notes are dated by their UTC timestamp, and 02:30 local time falls partway through a
 * UTC day in most zones, so the day a run happens on is visited again the next night.
 * With no previous run it covers yesterday and today. A gap longer than `maxDays`, such
 * as a gateway that was off for weeks, keeps only the most recent days.
 */
export function utcDatesSince(lastRun: Date | undefined, now: Date, maxDays = 7): string[] {
  const DAY = 86_400_000
  const utcMidnight = (t: number) => t - (t % DAY)
  const last = utcMidnight(now.getTime())
  const earliest = last - (maxDays - 1) * DAY
  const first = Math.max(utcMidnight(lastRun ? lastRun.getTime() : now.getTime() - DAY), earliest)
  const days: string[] = []
  for (let t = first; t <= last; t += DAY) days.push(new Date(t).toISOString().slice(0, 10))
  return days
}

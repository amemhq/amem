/**
 * The 02:30 job: one timer per process, and a timer that never holds the process open.
 *
 * The service's start() schedules it, not register(). OpenClaw also runs register() in
 * CLI commands and in the gateway's model-catalog worker threads, which never exit and
 * each have their own globalThis, so a timer scheduled there was a second nightly job.
 *
 * Within one thread the plugin can still start more than once. The gateway has been seen
 * loading it as two module graphs 50-75 ms apart, and each used to start its own timer
 * chain, which ran the nightly job 2-4 times concurrently every night, each copy
 * re-reading the same pairs and racing to merge the same notes. A module-level variable
 * cannot deduplicate across module graphs, so the handle lives on globalThis and the
 * latest start owns it.
 *
 * The timer is unref'd. One-shot diagnostics start services too, and a pending 02:30
 * timer kept such processes from exiting: `openclaw --help` was once still running after
 * 91 s. The gateway is held open by its own server, so this changes nothing there.
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
 * Which agents the nightly merge owes, and from when.
 *
 * The merge used to run inside agent_end, once per turn, for that turn's agent. The
 * nightly job has no session, so it has to be told which agents wrote. This is a file
 * rather than memory because the gateway restarts often, and an agent that wrote before
 * a restart and not after would otherwise never be merged. Writes are synchronous, so two
 * module graphs in one process cannot interleave a read-modify-write.
 *
 * Each agent carries `from`, its earliest write not yet merged, and `wrote`, its latest
 * write. The job settles each agent on its own as soon as all of its days are merged, so a
 * night that stops partway loses nothing: the next night picks up the agents it did not
 * settle.
 */
interface OwedAgent {
  from: string
  wrote: string
}

interface Owed {
  agents: Record<string, OwedAgent>
}

function readFile(file: string): Owed {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { agents?: Record<string, Partial<OwedAgent>> }
    const agents: Record<string, OwedAgent> = {}
    for (const [id, entry] of Object.entries(data.agents ?? {})) {
      if (typeof entry?.from === 'string' && typeof entry.wrote === 'string') {
        agents[id] = { from: entry.from, wrote: entry.wrote }
      }
    }
    return { agents }
  } catch {
    return { agents: {} }
  }
}

function writeFile(file: string, owed: Owed): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(owed))
}

/**
 * Record that `rawAgentId` wrote, so the next run merges it. `since` is taken before the
 * writes and `now` after them: a note is dated when its write starts, and a write that
 * straddles UTC midnight must keep the earlier day. Throws if the file cannot be written.
 */
export function markOwed(file: string, rawAgentId: string, since: Date, now: Date = new Date()): void {
  const owed = readFile(file)
  owed.agents[rawAgentId] = {
    from: owed.agents[rawAgentId]?.from ?? since.toISOString(),
    wrote: now.toISOString(),
  }
  writeFile(file, owed)
}

/** Owed agents, each with its earliest write not yet merged. */
export function readOwed(file: string): Map<string, Date> {
  return new Map(Object.entries(readFile(file).agents).map(([id, entry]) => [id, new Date(entry.from)]))
}

/**
 * Settle one agent once a run that started at `startedAt` has merged all of its days. An
 * agent that wrote after the run began stays owed from `startedAt`, because the run may
 * have read its notes before the write landed.
 */
export function settleAgent(file: string, rawAgentId: string, startedAt: Date): void {
  const owed = readFile(file)
  const entry = owed.agents[rawAgentId]
  if (!entry) return
  if (Date.parse(entry.wrote) < startedAt.getTime()) delete owed.agents[rawAgentId]
  else entry.from = startedAt.toISOString()
  writeFile(file, owed)
}

/**
 * The UTC dates a merge covers: from the day of `since` to today, at most `maxDays`.
 *
 * Notes are dated by their UTC timestamp, and 02:30 local time falls partway through a
 * UTC day in most zones, so a day a run has read can gain notes afterwards. `since` is
 * the earliest write not yet merged, and its whole day is read again. With no `since` it
 * covers yesterday and today. A gap longer than `maxDays`, such as a gateway that was off
 * for weeks, keeps only the most recent days.
 */
export function utcDatesSince(since: Date | undefined, now: Date, maxDays = 7): string[] {
  const DAY = 86_400_000
  const utcMidnight = (t: number) => t - (t % DAY)
  const last = utcMidnight(now.getTime())
  const earliest = last - (maxDays - 1) * DAY
  const first = Math.max(utcMidnight(since ? since.getTime() : now.getTime() - DAY), earliest)
  const days: string[] = []
  for (let t = first; t <= last; t += DAY) days.push(new Date(t).toISOString().slice(0, 10))
  return days
}

/**
 * What the gateway is doing, so the nightly job can stay out of the way (#158).
 *
 * Runs come from the host's own lifecycle events, api.runtime.events.onAgentEvent. A run
 * is in flight from its lifecycle "start" to its "end" or "error". Its other events keep
 * it fresh, so a long run stays counted while it does anything, and a run silent for
 * STALE_MS stops counting, in case its end never arrives. An event after the end does not
 * bring a run back: a memory flush reports its model after its end, and a model fallback
 * reports the switch after it, and neither is work.
 *
 * Two kinds of work that are not runs count too. This plugin's own agent_end writes notes,
 * and the host does not order it against the lifecycle end. A compaction runs the user's
 * model before a turn, with no run events. A channel message counts as activity only: a
 * channel turn bound to an ACP session reaches plugins as that and nothing else.
 *
 * `events` counts everything, so a step can tell that something happened since it began,
 * even a run that started and ended between two of its checks.
 *
 * The state lives on globalThis, because the plugin can be loaded as two module graphs
 * and both register. There is one listener per process: a new subscription replaces the
 * last.
 */
const FOREGROUND = Symbol.for('openclaw-amem.foreground')

interface Foreground {
  /** run id, compaction key or agent_end token → when it was last seen */
  inFlight: Map<string | symbol, number>
  lastActivity: number
  events: number
  unsubscribe?: () => void
}

type ForegroundHolder = { [FOREGROUND]?: Foreground }

export const STALE_MS = 30 * 60_000
/** A step does not start until nothing has happened for this long, so not between two turns. */
export const QUIET_MS = 60_000
/** Past this much waiting in one night, the job starts no further step. */
export const NIGHTLY_WAIT_CAP_MS = 60 * 60_000
/** A step stopped this many times by running tasks ends the night. */
export const MAX_ATTEMPTS = 3

function foreground(): Foreground {
  const holder = globalThis as ForegroundHolder
  return (holder[FOREGROUND] ??= { inFlight: new Map(), lastActivity: 0, events: 0 })
}

function touch(fg: Foreground, now: number): void {
  fg.lastActivity = now
  fg.events++
}

const compactionKey = (session: string) => `compaction:${session}`

type SessionCtx = { sessionKey?: string; sessionId?: string }

/** The fields of the host's agent event that this reads. */
export interface AgentEvent extends SessionCtx {
  runId?: string
  stream?: string
  data?: { phase?: unknown }
}

export function noteAgentEvent(evt: AgentEvent, now: number = Date.now()): void {
  const fg = foreground()
  touch(fg, now)
  if (!evt.runId) return
  const phase = evt.stream === 'lifecycle' ? evt.data?.phase : undefined
  if (phase === 'start') {
    fg.inFlight.set(evt.runId, now)
  } else if (phase === 'end' || phase === 'error') {
    fg.inFlight.delete(evt.runId)
    // after_compaction fires only when a compaction succeeds. The session's run still ends.
    for (const session of [evt.sessionKey, evt.sessionId]) if (session) fg.inFlight.delete(compactionKey(session))
  } else if (fg.inFlight.has(evt.runId)) {
    fg.inFlight.set(evt.runId, now)
  }
}

/** Subscribe to the host's agent events, replacing this process's last subscription. */
export function watchAgentEvents(subscribe: (listener: (evt: AgentEvent) => void) => () => void): void {
  const fg = foreground()
  fg.unsubscribe?.()
  fg.unsubscribe = subscribe((evt) => noteAgentEvent(evt))
}

export function unwatchAgentEvents(): void {
  const fg = foreground()
  fg.unsubscribe?.()
  delete fg.unsubscribe
}

/** Counts one agent_end call as in flight until the returned function is called. */
export function foregroundWorkStarted(now: number = Date.now()): () => void {
  const fg = foreground()
  const token = Symbol('agent_end')
  fg.inFlight.set(token, now)
  touch(fg, now)
  return () => {
    fg.inFlight.delete(token)
    touch(fg, Date.now())
  }
}

export function compactionStarted(ctx?: SessionCtx, now: number = Date.now()): void {
  const fg = foreground()
  touch(fg, now)
  const session = ctx?.sessionKey ?? ctx?.sessionId
  if (session) fg.inFlight.set(compactionKey(session), now)
}

export function compactionEnded(ctx?: SessionCtx, now: number = Date.now()): void {
  const fg = foreground()
  touch(fg, now)
  const session = ctx?.sessionKey ?? ctx?.sessionId
  if (session) fg.inFlight.delete(compactionKey(session))
}

/**
 * A channel message counts as activity, but an edit does not. Telegram sends each
 * live-location update as an edit, about every 40 s while a share is on, and it starts
 * no turn, so it would keep the job waiting all night.
 */
export function noteMessageReceived(
  event?: { providerUpdate?: { kind?: string; editedTimestamp?: number } },
  now: number = Date.now()
): void {
  const update = event?.providerUpdate
  if (update?.editedTimestamp !== undefined || update?.kind?.startsWith('edited_')) return
  touch(foreground(), now)
}

/** True while a run or other foreground work is in flight. Drops entries silent past STALE_MS. */
export function foregroundBusy(now: number = Date.now()): boolean {
  const { inFlight } = foreground()
  for (const [key, seen] of inFlight) if (now - seen > STALE_MS) inFlight.delete(key)
  return inFlight.size > 0
}

/**
 * The busy check for one attempt at a step: true while anything is in flight, and true
 * for good once anything has happened since the attempt began. The notes the step read
 * can predate that activity's writes.
 */
export function busySinceNow(): () => boolean {
  const fg = foreground()
  const seen = fg.events
  return () => foregroundBusy() || fg.events !== seen
}

/**
 * The nightly job's wait between steps: until nothing is in flight and nothing has
 * happened for QUIET_MS, checking every `pollMs`. Resolves false once the night's
 * waiting passes `capMs`. The poll timer is unref'd, like the nightly timer.
 */
export function makeIdleWaiter(
  pollMs = 15_000,
  capMs = NIGHTLY_WAIT_CAP_MS
): { untilIdle: () => Promise<boolean>; waitedMs: () => number } {
  let waited = 0
  return {
    async untilIdle() {
      for (;;) {
        const now = Date.now()
        if (!foregroundBusy(now) && now - foreground().lastActivity >= QUIET_MS) return true
        if (waited >= capMs) return false
        await new Promise((resolve) => setTimeout(resolve, pollMs).unref())
        waited += Date.now() - now
      }
    },
    waitedMs: () => waited,
  }
}

export type StepResult = 'done' | 'out of waiting' | 'stopped too often'

/**
 * One step of the nightly job. It starts once the gateway is idle. If a run stops it, it
 * starts again from the beginning once the gateway is idle, so it never goes on from notes
 * it read before the run, up to MAX_ATTEMPTS attempts. `attempt` runs the step and throws
 * when stopped, which `preempted` recognises. A real failure is thrown.
 */
export async function runStep(
  idle: { untilIdle: () => Promise<boolean> },
  attempt: () => Promise<void>,
  preempted: (err: unknown) => boolean,
  onPreempted: () => void
): Promise<StepResult> {
  for (let tries = 1; ; tries++) {
    if (!(await idle.untilIdle())) return 'out of waiting'
    try {
      await attempt()
      return 'done'
    } catch (err) {
      if (!preempted(err)) throw err
      if (tries >= MAX_ATTEMPTS) return 'stopped too often'
      onPreempted()
    }
  }
}

export interface NightlyWork {
  owedFile: string
  /** Always merged, as the nightly jobs always have been, whether or not it is owed. */
  defaultAgent: string
  /** Merges one agent's notes for one UTC day. */
  mergeDay: (rawAgentId: string, day: string) => Promise<void>
  /** The steps after the merge, in order: the consolidation and the contradiction sweep. */
  after: Array<{ name: string; run: () => Promise<void> }>
  /** Runs a step so that it throws once the gateway is busy. `preempted` recognises the throw. */
  inBackground: (work: () => Promise<void>) => Promise<void>
  preempted: (err: unknown) => boolean
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
  idle?: { untilIdle: () => Promise<boolean>; waitedMs: () => number }
}

/**
 * The 02:30 job. Same-day merging used to run inside agent_end, once per turn. It carries
 * the one uncapped term in that hook (an evolution judgment per pending note) and up to
 * ten merge checks, so it runs here instead, for every agent that wrote (#158).
 *
 * Every step stays out of the way of the user's runs, see runStep. Once one step gives up,
 * the night ends. The agents already settled stay settled, and the rest run tomorrow.
 */
export async function runNightly(work: NightlyWork, startedAt: Date = new Date()): Promise<void> {
  const { logger } = work
  const idle = work.idle ?? makeIdleWaiter()
  let stopped = false
  const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
    if (stopped) return false
    const result = await runStep(
      idle,
      () => work.inBackground(run),
      work.preempted,
      () =>
        logger.info(`openclaw-amem: nightly ${name} stopped for a running task; it runs again when the gateway is idle`)
    )
    if (result === 'done') return true
    stopped = true
    logger.warn(
      result === 'out of waiting'
        ? `openclaw-amem: nightly job waited ${Math.round(idle.waitedMs() / 60_000)} min for running tasks; the rest runs tomorrow`
        : `openclaw-amem: nightly ${name} was stopped ${MAX_ATTEMPTS} times by running tasks; the rest runs tomorrow`
    )
    return false
  }

  try {
    const owed = readOwed(work.owedFile)
    merging: for (const agent of new Set([work.defaultAgent, ...owed.keys()])) {
      let failed = false
      for (const day of utcDatesSince(owed.get(agent), startedAt)) {
        try {
          if (!(await step(`merge (${agent}, ${day})`, () => work.mergeDay(agent, day)))) break merging
        } catch (err) {
          failed = true
          logger.warn(`openclaw-amem: merge failed (${agent}, ${day}) — ${(err as Error).message}`)
        }
      }
      // A failed day stays owed, so the next night reads it again, until it is 7 days old.
      if (!failed) settleAgent(work.owedFile, agent, startedAt)
    }
  } catch (err) {
    logger.warn(`openclaw-amem: nightly merge failed — ${(err as Error).message}`)
  }

  for (const { name, run } of work.after) {
    try {
      await step(name, run)
    } catch (err) {
      logger.warn(`openclaw-amem: nightly ${name} failed — ${(err as Error).message}`)
    }
  }

  if (idle.waitedMs() > 0) {
    logger.info(`openclaw-amem: nightly job waited ${Math.round(idle.waitedMs() / 1000)} s for running tasks`)
  }
}

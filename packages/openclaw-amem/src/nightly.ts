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

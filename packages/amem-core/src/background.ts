/**
 * Background work that stops for the user's own work.
 *
 * The nightly job shares the gateway, the API key and the notes with the user's agent,
 * and people do run tasks at night. The host passes `busy`, which turns true when the
 * user's work could have changed the notes the step read. Inside runInBackground, llmCall
 * throws BackgroundPreempted before and after a call while busy() is true, and so does
 * pauseForForeground() in the long CPU loops. The step that was running stops there. The
 * host waits until the gateway is idle and runs the step again from a fresh read.
 *
 * It throws rather than waits in place because a step holds notes it read before the
 * wait. After a wait they can be stale, and a merge would then delete or overwrite what
 * the user's run just wrote. It throws rather than skips the remaining calls because a
 * skipped call looks like a failed one, and some failures write: an evolution judgment
 * with no answer clears pending_merge.
 *
 * The throw comes before a call, or after one and before the caller writes anything from
 * its answer, so each item is either fully written or not written at all. Calls outside
 * runInBackground, such as agent_end's, never throw: they belong to the run.
 *
 * AsyncLocalStorage rather than a parameter, so every engine function the nightly job
 * reaches is covered without each of them threading an option through, including ones
 * added later.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const current = new AsyncLocalStorage<() => boolean>()

export class BackgroundPreempted extends Error {
  constructor() {
    super('stopped for a run in the foreground')
    this.name = 'BackgroundPreempted'
  }
}

export function runInBackground<T>(busy: () => boolean, job: () => Promise<T>): Promise<T> {
  return current.run(busy, job)
}

/** Throws BackgroundPreempted inside runInBackground while the host is busy. */
export function stopIfForegroundBusy(): void {
  if (current.getStore()?.()) throw new BackgroundPreempted()
}

/**
 * For a long synchronous loop: lets the event loop run, then stops as llmCall would.
 * Does nothing outside runInBackground.
 */
export async function pauseForForeground(): Promise<void> {
  if (!current.getStore()) return
  await new Promise((resolve) => setImmediate(resolve))
  stopIfForegroundBusy()
}

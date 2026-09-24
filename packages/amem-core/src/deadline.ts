/**
 * Deadlines for LLM work inside a hook the host stops waiting for.
 *
 * OpenClaw gives agent_end a fixed budget and, when it runs out, stops waiting without
 * cancelling the work. Work that carries on past that point races the next turn's hook
 * over the same notes. A deadline is epoch milliseconds. Work that has one checks it
 * before each LLM call, and stops rather than start a call it cannot finish.
 *
 * Its own module, not llm.ts, because most engine tests mock llm.js wholesale and
 * memory.ts needs this to stay real under those mocks.
 */

/** A call started with less time than this left would almost certainly not finish. */
export const MIN_CALL_MS = 3000

export interface CallOptions {
  /** Epoch ms. Absent means no deadline: the client's own timeout and retries apply. */
  deadline?: number
}

/** True while a call started now still has MIN_CALL_MS before `deadline`. No deadline: always. */
export function hasTimeFor(deadline?: number): boolean {
  return deadline === undefined || deadline - Date.now() >= MIN_CALL_MS
}

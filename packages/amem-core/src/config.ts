/**
 * config.ts — runtime configuration for the amem engine.
 *
 * `dataDir` holds the evolution-throttle counter, consolidation logs and, unless
 * AMEM_REVIEW_DIR is set, quality review batches (`amem-reviews/`).
 * Defaults to ~/.amem so the engine stays framework-agnostic; the OpenClaw
 * plugin calls configure({ dataDir: '<home>/.openclaw' }) to preserve its
 * existing on-disk location. Override via AMEM_DATA_DIR env var or configure().
 *
 * `warn` is where the engine reports a failure it recovered from. stderr is the
 * right default for a CLI, and the wrong one for a host: OpenClaw runs the
 * gateway under launchd with StandardErrorPath=/dev/null, so through 2.1.1 every
 * warning the engine wrote went nowhere. An LLM outage that stored notes with
 * empty keywords for eleven days looked exactly like eleven quiet days. A host
 * passes its own logger to claim these.
 *
 * `error` is for a failure that stops the engine doing its job until someone acts, such as
 * an endpoint that refuses every call. A host routes it to its error level, so that it does
 * not scroll by with the warnings.
 */
import * as os from 'os'
import * as path from 'path'

let _dataDir = process.env.AMEM_DATA_DIR || path.join(os.homedir(), '.amem')

let _warn: (msg: string) => void = (msg) => console.warn(msg)
let _error: (msg: string) => void = (msg) => console.error(msg)

export function configure(opts: {
  dataDir?: string
  warn?: (msg: string) => void
  error?: (msg: string) => void
}): void {
  if (opts.dataDir) _dataDir = opts.dataDir
  if (opts.warn) _warn = opts.warn
  if (opts.error) _error = opts.error
}

export function getDataDir(): string {
  return _dataDir
}

/**
 * Report a failure the engine handled. Use it wherever the code recovers and
 * carries on — a failed LLM call, an unparseable response, a store that needs
 * migrating — because those are the failures nobody is watching for.
 */
export function warn(msg: string): void {
  _warn(msg)
}

/** Report a failure that stops the engine doing its job until someone acts. */
export function error(msg: string): void {
  _error(msg)
}

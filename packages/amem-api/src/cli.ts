#!/usr/bin/env node
import { loadModel } from '@amemhq/core'
import { createApp } from './app.js'
import { assertBindable } from './net.js'

const host = process.env.AMEM_API_HOST ?? '127.0.0.1'
const port = Number(process.env.AMEM_API_PORT ?? 7788)

const app = createApp()

// Fail fast, before the model loads: binding a public interface with no token
// would expose everyone's memories. createApp() has already wired the token
// check when one is set; this refuses the one combination that must never run.
try {
  assertBindable(host, process.env.AMEM_API_TOKEN)
} catch (err) {
  app.log.error((err as Error).message)
  process.exit(1)
}

// A single-writer service must let go of Qdrant cleanly on the way out, so the
// next instance can take over without waiting for a stale connection to lapse.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'failed to shut down cleanly')
        process.exit(1)
      }
    )
  })
}

// Load the model before the port opens. Otherwise /healthz reports `degraded`
// from boot until the first write happens to load it — and anything gated on
// /healthz would never send that write. A service that owns the model loads it.
app.log.info('loading embedding model')
loadModel()
  .then(() => app.listen({ host, port }))
  .catch((err: unknown) => {
    app.log.error({ err }, 'failed to start')
    process.exit(1)
  })

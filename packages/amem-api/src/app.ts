import { timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import {
  addEpisodic,
  addMemory,
  consolidateMemories,
  isModelLoaded,
  listMemories,
  pingQdrant,
  scanLowQuality,
  searchMemory,
} from '@amemhq/core'
import { classify, errorBody } from './errors.js'

/** Constant-time compare, so a wrong token cannot be found byte-by-byte from
 * response timing. Length is allowed to differ (and to leak) — timingSafeEqual
 * requires equal-length buffers, and a token's length is not the secret. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Mirrors amem-core's own default. The maintenance routes have to name an agent
 * explicitly — consolidateMemories() and scanLowQuality() take no default — so
 * the API applies one uniformly rather than defaulting in some routes but not
 * others.
 */
const DEFAULT_AGENT = 'main'

interface WriteBody {
  text: string
  agentId?: string
  scope?: 'private' | 'shared'
}

interface SearchBody {
  query: string
  limit?: number
  agentId?: string
  topicsFilter?: string[]
}

interface AgentBody {
  agentId?: string
}

const writeSchema = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: {
    // An empty string is rejected here, at 400. Content that is merely too
    // short passes the schema and reaches the quality gate, which is a 422.
    text: { type: 'string', minLength: 1 },
    agentId: { type: 'string', minLength: 1 },
    scope: { type: 'string', enum: ['private', 'shared'] },
  },
}

const searchSchema = {
  type: 'object',
  required: ['query'],
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1 },
    agentId: { type: 'string', minLength: 1 },
    topicsFilter: { type: 'array', items: { type: 'string' } },
  },
}

const agentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agentId: { type: 'string', minLength: 1 },
  },
}

const countSchema = {
  type: 'object',
  properties: {
    agentId: { type: 'string', minLength: 1 },
  },
}

/**
 * Build the Fastify app.
 *
 * Kept separate from the process entrypoint so tests can drive it with
 * `app.inject()` without opening a socket, and so the MCP bridge can later
 * mount the same handlers.
 */
export function createApp(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.AMEM_API_LOG_LEVEL ?? 'info' },
    // Fastify's AJV defaults include `removeAdditional: true`, which quietly
    // deletes any field a schema does not declare. A misspelled key in a memory
    // write would vanish without a word. `additionalProperties: false` should
    // mean refuse, not discard.
    ajv: { customOptions: { removeAdditional: false } },
    ...opts,
  })

  // Bearer auth, when a token is configured. Reading it once at construction is
  // deliberate: the token is fixed for the process's life, and this also lets a
  // test build an authed or an open app by setting the env before createApp().
  // With no token the service is open — which is safe only on loopback, a rule
  // the entrypoint enforces by refusing to bind elsewhere without one.
  const token = process.env.AMEM_API_TOKEN
  if (token) {
    app.addHook('onRequest', async (req, reply) => {
      // /healthz stays open: orchestrators and load balancers probe it
      // unauthenticated, and it reveals liveness, never memory content.
      if (req.routeOptions.url === '/healthz') return

      const header = req.headers.authorization
      const provided = header?.startsWith('Bearer ') ? header.slice(7) : ''
      if (!tokenMatches(provided, token)) {
        return reply.status(401).send(errorBody(401, new Error('missing or invalid Authorization bearer token')))
      }
    })
  }

  // No handler catches anything: Fastify funnels every rejection here, so the
  // mapping from failure to status code lives in exactly one place.
  app.setErrorHandler((err, req, reply) => {
    const statusCode = classify(err)
    if (statusCode === 503) req.log.warn({ err }, 'dependency unavailable')
    else if (statusCode >= 500) req.log.error({ err }, 'request failed')
    return reply.status(statusCode).send(errorBody(statusCode, err))
  })

  /**
   * Readiness, not liveness. Both dependencies are re-checked on every call:
   * pingQdrant() really talks to Qdrant, and isModelLoaded() reads a resident
   * flag without ever triggering the model download.
   */
  app.get('/healthz', async (req, reply) => {
    let qdrant = false
    try {
      await pingQdrant()
      qdrant = true
    } catch (err) {
      req.log.warn({ err }, 'qdrant unreachable')
    }

    const model = isModelLoaded()
    const ok = qdrant && model
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', qdrant, model })
  })

  // The full pipeline: LLM note construction, link generation, evolution.
  app.post<{ Body: WriteBody }>('/v1/memories', { schema: { body: writeSchema } }, async (req, reply) => {
    const { text, agentId = DEFAULT_AGENT, scope = 'private' } = req.body
    const id = await addMemory(text, agentId, { scope })
    req.log.info({ noteId: id, agentId }, 'memory written')
    return reply.status(201).send({ id })
  })

  // The cheap path: embed and store, no LLM. An append-only event log.
  app.post<{ Body: WriteBody }>('/v1/memories/episodic', { schema: { body: writeSchema } }, async (req, reply) => {
    const { text, agentId = DEFAULT_AGENT, scope = 'private' } = req.body
    const id = await addEpisodic(text, agentId, { scope })
    req.log.info({ noteId: id, agentId }, 'episodic event written')
    return reply.status(201).send({ id })
  })

  // A search is a read, but its query travels in a body: it carries a topic
  // filter array, and memory content does not belong in a URL or an access log.
  app.post<{ Body: SearchBody }>('/v1/memories/search', { schema: { body: searchSchema } }, async (req) => {
    const { query, limit = 5, agentId = DEFAULT_AGENT, topicsFilter } = req.body
    const results = await searchMemory(query, limit, agentId, { topicsFilter })
    return { results }
  })

  app.get<{ Querystring: AgentBody }>('/v1/memories/count', { schema: { querystring: countSchema } }, async (req) => {
    const { agentId = DEFAULT_AGENT } = req.query
    return listMemories(agentId)
  })

  app.post<{ Body: AgentBody }>('/v1/maintenance/consolidate', { schema: { body: agentSchema } }, async (req) => {
    const { agentId = DEFAULT_AGENT } = req.body
    // consolidateMemories() reports progress through whatever logger it is
    // handed. req.log is the pino child, so its lines carry this request's id.
    const merged = await consolidateMemories(agentId, req.log)
    req.log.info({ merged, agentId }, 'consolidation complete')
    return { merged }
  })

  app.post<{ Body: AgentBody }>('/v1/maintenance/quality-scan', { schema: { body: agentSchema } }, async (req) => {
    const { agentId = DEFAULT_AGENT } = req.body
    const flagged = await scanLowQuality(agentId)
    // A MemoryNote carries its full embedding, its evolution history and
    // its ACL. The caller needs to know which notes are suspect, not to be
    // handed the notes themselves.
    return { items: flagged.map(({ note, reasons }) => ({ noteId: note.id, reasons })) }
  })

  return app
}

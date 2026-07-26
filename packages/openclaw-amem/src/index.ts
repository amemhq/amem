/**
 * amem-plugin v2 — A-MEM agentic memory backend for OpenClaw
 * TypeScript rewrite — Story 5: native TS implementation (no Python daemon)
 *
 * Depends on:
 *   - src/memory.ts  (addMemory, searchMemory, listMemories)
 *   - src/storage.ts (Qdrant)
 *   - src/embedding.ts (Transformers.js)
 *   - src/llm.ts (Anthropic SDK)
 */

import * as os from 'os'
import * as path from 'path'
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import {
  addMemory,
  searchMemory,
  listMemories,
  mergeSimilarNotes,
  consolidateMemories,
  ensureCollection,
  createStorageContext,
  encode,
  generateReviewBatch,
  configure,
  configureLlm,
  conflictSweep,
  isPlausibleUpdateTarget,
  type AmemPluginConfig,
} from '@heichaowo/amem-core'
import { createHash } from 'crypto'
import { isConvAccessBlocked, BLOCKED_WARNING_LOG, BLOCKED_WARNING_SUFFIX } from './conv-access.js'
import {
  resolveAgentId as resolveAgentIdWith,
  buildScope as buildScopeWith,
  type AgentCtx,
  type AgentScope,
} from './scope.js'

// ── Config ────────────────────────────────────────────────────────────────────
let _config: Record<string, unknown> = {}

// ── OpenClaw plugin registration ──────────────────────────────────────────────
function register(api: {
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  pluginConfig?: Record<string, unknown>
  agentId?: string
  registerMemoryCapability?: (cap: unknown) => void
  registerTool?: (tool: unknown, opts?: unknown) => void
  registerService?: (svc: unknown) => void
}) {
  const logger = api.logger
  _config = (api.pluginConfig as Record<string, unknown>) || {}
  const pluginConfig = _config as AmemPluginConfig

  // Is automatic memory write-back (the agent_end hook) allowed? The flag lives in
  // the FULL openclaw.json (`api.config`), not `api.pluginConfig`. Read it once, at
  // startup, so we know for certain — no timer, no heuristic (see conv-access.ts).
  const pluginId = (api as unknown as { id?: string }).id ?? 'openclaw-amem'
  const convBlocked = isConvAccessBlocked((api as unknown as { config?: unknown }).config, pluginId)
  if (convBlocked) logger.warn(BLOCKED_WARNING_LOG)

  // Preserve the plugin's existing on-disk data location (evo counter + consolidation logs).
  configure({ dataDir: path.join(os.homedir(), '.openclaw') })

  // Story 35: let openclaw.json pick the model without setting env vars. Env
  // vars still win, and an unset key falls through to the engine's default, so
  // configuring none of these leaves behaviour exactly as it was.
  // Story 42 adds the optional `strong` tier and the CRUD role on top.
  const hasStrong = !!(pluginConfig.llmStrongProvider || pluginConfig.llmStrongModel || pluginConfig.llmStrongBaseURL)
  if (
    pluginConfig.llmProvider ||
    pluginConfig.llmModel ||
    pluginConfig.llmBaseURL ||
    pluginConfig.llmCrudRole ||
    hasStrong
  ) {
    configureLlm({
      provider: pluginConfig.llmProvider,
      model: pluginConfig.llmModel,
      baseURL: pluginConfig.llmBaseURL,
      crudRole: pluginConfig.llmCrudRole,
      // Omit the whole block when unset so `strong` transparently falls back to
      // `fast` — the zero-config path stays byte-for-byte today's behaviour.
      ...(hasStrong && {
        strong: {
          provider: pluginConfig.llmStrongProvider,
          model: pluginConfig.llmStrongModel,
          baseURL: pluginConfig.llmStrongBaseURL,
        },
      }),
    })
  }

  // Story 43: the nightly contradiction sweep. On by default — it is the safety
  // net for running the per-turn CRUD decision on the fast model, and a net that
  // is off by default is not a net. It is cheap because it only re-reads batches
  // that gained a note, and it runs on whatever tier is configured: with no
  // `strong` model set it uses the fast one, so an existing install does not
  // silently start spending more.
  const conflictSweepEnabled = pluginConfig.conflictSweep !== false

  // Story 41: similarity floor for accepting an LLM-chosen CRUD UPDATE target.
  // Undefined here just means "use the engine default"; the env var still wins.
  const crudUpdateMinSim = pluginConfig.crudUpdateMinSim

  // ── Story 32 (Issue 1): per-agent scope resolved PER CALL, not at register ────
  // The runtime per-session agentId is only present on each interface's ctx, not
  // on `api` at register time. The resolution logic lives in scope.ts (pure, unit
  // tested); these closures bind it to this instance's config + storage factory.
  const resolveAgentId = (ctx?: AgentCtx): string => resolveAgentIdWith(ctx, pluginConfig)
  const buildScope = (rawAgentId: string): AgentScope => buildScopeWith(rawAgentId, pluginConfig, createStorageContext)

  // Background tasks (daily consolidation, service lifecycle) have no per-session
  // ctx — they run on the default agent scope (preserves pre-Story-32 behavior).
  const defaultScope = buildScope(resolveAgentId())
  const dbPath = path.join(os.homedir(), '.openclaw', 'amem_db')

  logger.info(
    `openclaw-amem: registered (native TS, Qdrant, default agent_id=${defaultScope.agentId}, default collection=${pluginConfig.collection ?? 'amem_notes (default)'}, per-agent scope resolved per call)`
  )

  // Pre-warm: ensure the default Qdrant collection exists
  ensureCollection(pluginConfig.collection).catch((e) =>
    logger.warn(`openclaw-amem: ensureCollection failed — ${e.message}`)
  )

  // ── registerMemoryCapability ─────────────────────────────────────────────
  if (typeof api.registerMemoryCapability === 'function') {
    api.registerMemoryCapability({
      publicArtifacts: {
        async listArtifacts(_p: unknown) {
          return { items: [] }
        },
        async getArtifact(_p: unknown) {
          return null
        },
      },
      runtime: {
        async getMemorySearchManager(params: AgentCtx) {
          try {
            const scope = buildScope(resolveAgentId(params))
            return {
              manager: {
                status() {
                  return {
                    backend: 'amem-qdrant',
                    files: 0,
                    chunks: 0,
                    dirty: false,
                    workspaceDir: dbPath,
                  }
                },
                async search(query: string, opts: { limit?: number; topK?: number } = {}) {
                  try {
                    const topK = opts.limit || opts.topK || 5
                    const results = await searchMemory(query, topK, scope.agentId, { storageCtx: scope.storageCtx })
                    return results.map((r) => ({
                      id: r.id,
                      memory: r.content,
                      score: r.similarity,
                      context: r.context,
                      tags: r.tags.join(', '),
                    }))
                  } catch (err) {
                    logger.warn(`openclaw-amem: search failed — ${(err as Error).message}`)
                    return []
                  }
                },
                async add(text: string) {
                  try {
                    await addMemory(text, scope.agentId, { storageCtx: scope.storageCtx })
                    return { ok: true }
                  } catch (err) {
                    logger.warn(`openclaw-amem: add failed — ${(err as Error).message}`)
                    return { ok: false, error: (err as Error).message }
                  }
                },
                async probeEmbeddingAvailability() {
                  return { ok: true }
                },
                async close() {},
              },
            }
          } catch (err) {
            logger.warn(`openclaw-amem: getMemorySearchManager failed — ${(err as Error).message}`)
            return { manager: null, error: `amem backend unavailable: ${String(err)}` }
          }
        },
        resolveMemoryBackendConfig(params: AgentCtx) {
          const scope = buildScope(resolveAgentId(params))
          return { backend: 'amem-qdrant', baseUrl: '', userId: scope.agentId }
        },
        async closeAllMemorySearchManagers() {},
      },
    })
  } else {
    logger.warn('openclaw-amem: api.registerMemoryCapability not available')
  }

  // ── registerTool: memory_search ──────────────────────────────────────────
  if (typeof api.registerTool === 'function') {
    api.registerTool(
      (ctx: AgentCtx) => {
        const scope = buildScope(resolveAgentId(ctx))
        return {
          name: 'memory_search',
          label: 'Memory Search (A-MEM)',
          description: 'Search long-term memories stored in A-MEM / Qdrant.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              limit: { type: 'number', description: 'Max results (default: 5)' },
              topicsFilter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Story 26B: filter knowledge notes by topics (all must match)',
              },
              subject: {
                type: 'string',
                description:
                  'Who you are talking to or about (e.g. a player name). Returns memories about them plus memories about nobody in particular. Omit to search everything.',
              },
            },
            required: ['query'],
          },
          async execute(
            _toolCallId: string,
            params: { query: string; limit?: number; topicsFilter?: string[]; subject?: string }
          ) {
            const { query, limit = 5, topicsFilter, subject } = params
            const start = Date.now()
            // If write-back is off, append the notice so the assistant relays it to
            // the user (a plugin's most user-visible channel). Determined at startup.
            const hookWarning = convBlocked ? BLOCKED_WARNING_SUFFIX : ''
            try {
              const results = await searchMemory(query, limit, scope.agentId, {
                topicsFilter,
                subject,
                storageCtx: scope.storageCtx,
              })
              logger.info(
                `openclaw-amem: memory_search "${query}" → ${results.length} results (${Date.now() - start}ms)`
              )
              if (!results.length) {
                return {
                  content: [{ type: 'text', text: 'No relevant memories found.' + hookWarning }],
                  details: { count: 0 },
                }
              }
              const text = results
                .map((r, i) => `${i + 1}. ${r.content} (score: ${(r.similarity * 100).toFixed(0)}%, id: ${r.id})`)
                .join('\n')
              return {
                content: [{ type: 'text', text: `Found ${results.length} memories:\n\n${text}${hookWarning}` }],
                details: { count: results.length, memories: results },
              }
            } catch (err) {
              logger.warn(`openclaw-amem: memory_search error — ${(err as Error).message}`)
              return {
                content: [{ type: 'text', text: `Memory search failed: ${(err as Error).message}` }],
                details: { error: String(err) },
              }
            }
          },
        }
      },
      { optional: false }
    )

    // ── registerTool: memory_add ─────────────────────────────────────────────
    api.registerTool(
      (ctx: AgentCtx) => {
        const scope = buildScope(resolveAgentId(ctx))
        return {
          name: 'memory_add',
          label: 'Memory Add (A-MEM)',
          description: 'Save important information into long-term A-MEM memory.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Fact or information to remember' },
              subjects: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Who this memory is about (e.g. player names). Use several for a shared experience — it will surface for each of them. Leave empty for a fact about the world or about yourself.',
              },
            },
            required: ['text'],
          },
          async execute(_toolCallId: string, params: { text: string; subjects?: string[] }) {
            const { text, subjects } = params
            const start = Date.now()
            try {
              const id = await addMemory(text, scope.agentId, { subjects, storageCtx: scope.storageCtx })
              logger.info(`openclaw-amem: memory_add OK id=${id} (${Date.now() - start}ms)`)
              return {
                content: [{ type: 'text', text: 'Memory saved successfully.' }],
                details: { ok: true, id },
              }
            } catch (err) {
              logger.warn(`openclaw-amem: memory_add error — ${(err as Error).message}`)
              return {
                content: [{ type: 'text', text: `Memory add failed: ${(err as Error).message}` }],
                details: { ok: false, error: String(err) },
              }
            }
          },
        }
      },
      { optional: false }
    )

    // ── registerTool: memory_list ─────────────────────────────────────────────
    api.registerTool(
      (ctx: AgentCtx) => {
        const scope = buildScope(resolveAgentId(ctx))
        return {
          name: 'memory_list',
          label: 'Memory List (A-MEM)',
          description: 'Show total memory count in A-MEM.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
          async execute(_toolCallId: string, _params: Record<string, never>) {
            try {
              const { count } = await listMemories(scope.agentId, scope.storageCtx)
              return {
                content: [{ type: 'text', text: `Total memories: ${count}` }],
                details: { count },
              }
            } catch (err) {
              return {
                content: [{ type: 'text', text: `Memory list failed: ${(err as Error).message}` }],
                details: { error: String(err) },
              }
            }
          },
        }
      },
      { optional: true }
    )

    // ── registerTool: memory_consolidate ──────────────────────────────────────
    api.registerTool(
      (ctx: AgentCtx) => {
        const scope = buildScope(resolveAgentId(ctx))
        return {
          name: 'memory_consolidate',
          label: 'Memory Consolidate (A-MEM)',
          description: 'Trigger daily consolidation to merge semantic duplicates.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
          async execute(_toolCallId: string, _params: Record<string, never>) {
            const start = Date.now()
            try {
              const merged = await consolidateMemories(scope.agentId, logger, scope.storageCtx)
              logger.info(`openclaw-amem: memory_consolidate OK merged=${merged} (${Date.now() - start}ms)`)
              return {
                content: [{ type: 'text', text: `Consolidation completed. Merged ${merged} memory pairs.` }],
                details: { ok: true, mergedCount: merged },
              }
            } catch (err) {
              logger.warn(`openclaw-amem: memory_consolidate failed — ${(err as Error).message}`)
              return {
                content: [{ type: 'text', text: `Consolidation failed: ${(err as Error).message}` }],
                details: { ok: false, error: String(err) },
              }
            }
          },
        }
      },
      { optional: true }
    )

    // ── registerTool: memory_quality_scan ────────────────────────────────────
    api.registerTool(
      (ctx: AgentCtx) => {
        const scope = buildScope(resolveAgentId(ctx))
        return {
          name: 'memory_quality_scan',
          label: 'Memory Quality Scan (A-MEM)',
          description:
            'Scan all memories for quality issues (too short, expired ephemeral, conflicts) and generate a review batch file.',
          parameters: {
            type: 'object',
            properties: {
              outputPath: {
                type: 'string',
                description:
                  'Custom filename for the review batch (optional, auto-generates if omitted). A bare filename only — it is written under AMEM_REVIEW_DIR; a path with directories is rejected.',
              },
            },
            required: [],
          },
          async execute(_toolCallId: string, params: { outputPath?: string }) {
            const start = Date.now()
            try {
              const filePath = await generateReviewBatch(scope.agentId, params.outputPath)
              logger.info(`openclaw-amem: memory_quality_scan OK path=${filePath} (${Date.now() - start}ms)`)
              return {
                content: [{ type: 'text', text: `Quality scan complete. Review batch saved to: ${filePath}` }],
                details: { ok: true, path: filePath },
              }
            } catch (err) {
              logger.warn(`openclaw-amem: memory_quality_scan failed — ${(err as Error).message}`)
              return {
                content: [{ type: 'text', text: `Quality scan failed: ${(err as Error).message}` }],
                details: { ok: false, error: String(err) },
              }
            }
          },
        }
      },
      { optional: true }
    )

    logger.info(
      'openclaw-amem: memory_search, memory_add, memory_list, memory_consolidate, memory_quality_scan tools registered'
    )
  } else {
    logger.warn('openclaw-amem: api.registerTool not available — tools not registered')
  }

  // ── agent_end hook: auto-capture memories after each turn ─────────────────
  if (typeof (api as any).registerHook === 'function' || typeof (api as any).on === 'function') {
    const hookFn = (typeof (api as any).on === 'function' ? (api as any).on : (api as any).registerHook).bind(api)
    hookFn(
      'agent_end',
      async (
        event: {
          messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
          success?: boolean
        },
        ctx?: AgentCtx
      ) => {
        // Story 32 (Issue 1): resolve the per-session agent scope from the hook ctx.
        const scope = buildScope(resolveAgentId(ctx))
        const agentId = scope.agentId
        const storageCtx = scope.storageCtx
        logger.info(
          `openclaw-amem: agent_end hook triggered (agent_id=${agentId}, success=${event.success}, messages=${event.messages?.length ?? 0})`
        )
        try {
          if (!event.success) {
            logger.info('openclaw-amem: agent_end skipped — event.success is false')
            return
          }
          // Extract last user + assistant exchange
          const msgs = event.messages || []
          const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
          const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
          if (!lastUser || !lastAssistant) return

          const userText =
            typeof lastUser.content === 'string'
              ? lastUser.content
              : lastUser.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join(' ')
          const assistantText =
            typeof lastAssistant.content === 'string'
              ? lastAssistant.content
              : lastAssistant.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join(' ')

          // ── Step 1: 规则前置过滤 ──────────────────────────────────────────────────
          function shouldProcessTurn(text: string): boolean {
            if (text.trim().length < 10) return false
            const skipWords = ['好', '嗯', '明白', '明白了', '收到', 'ok', 'OK', '好的', '知道了', '了解', '谢谢', '谢']
            const trimmed = text.trim()
            if (skipWords.some((w) => trimmed === w || trimmed === w + '。' || trimmed === w + '！')) return false
            return true
          }

          if (!userText || !shouldProcessTurn(userText)) return

          // ── Step 2: 检索 Top5 已有相关记忆 ─────────────────────────────────────────
          const searchResults = await searchMemory(userText, 5, agentId, { storageCtx })
          const existingMemories = searchResults.map((r, idx) => ({
            idx,
            id: r.id,
            content: r.content,
          }))

          // ── Step 3: 调用 llmCrudDecision ────────────────────────────────────────────
          const { llmCrudDecision } = await import('@heichaowo/amem-core')
          const operations = await llmCrudDecision(
            userText,
            assistantText,
            existingMemories.map((m) => ({ idx: m.idx, content: m.content }))
          )

          if (!operations || operations.length === 0) return

          // ── Step 4: 执行 CRUD 操作 ───────────────────────────────────────────────
          for (const op of operations) {
            if (op.action === 'NEW') {
              await addMemory(op.fact, agentId, { storageCtx })
              logger.info(`openclaw-amem: CRUD NEW: "${op.fact.slice(0, 60)}${op.fact.length > 60 ? '...' : ''}"`)
            } else if (op.action === 'UPDATE' && op.existingIdx !== undefined) {
              const target = existingMemories[op.existingIdx]
              if (target) {
                const newEmbedding = await encode(op.fact)
                const hash = createHash('md5').update(op.fact).digest('hex')

                // Story 41: an in-range but WRONG index passes every structural
                // check — it is a valid position and usually a note we own — and
                // would overwrite an unrelated memory irreversibly. Confirm the
                // replacement is plausibly about this note first. Failing that,
                // the fact is not lost: it is captured as a new memory instead,
                // and consolidation can merge it later.
                const targetNote = await storageCtx.getNote(target.id, agentId)
                if (!targetNote || !isPlausibleUpdateTarget(newEmbedding, targetNote.embedding, crudUpdateMinSim)) {
                  await addMemory(op.fact, agentId, { storageCtx })
                  logger.warn(
                    `openclaw-amem: CRUD UPDATE on ${target.id.slice(0, 8)} looks mis-targeted — stored as a new memory instead`
                  )
                  continue
                }

                // Story 33: search also returns other agents' shared notes; passing
                // agentId makes the engine refuse to write ones we do not own.
                const ok = await storageCtx.updateNoteContent(target.id, op.fact, newEmbedding, hash, agentId)
                if (!ok) {
                  logger.warn(
                    `openclaw-amem: CRUD UPDATE denied id=${target.id.slice(0, 8)} — ${agentId} not in writers`
                  )
                  continue
                }
                logger.info(
                  `openclaw-amem: CRUD UPDATE id=${target.id.slice(0, 8)}: "${op.fact.slice(0, 60)}${op.fact.length > 60 ? '...' : ''}"`
                )
              }
            } else if (op.action === 'DELETE' && op.existingIdx !== undefined) {
              const target = existingMemories[op.existingIdx]
              if (target) {
                const ok = await storageCtx.invalidateNote(target.id, agentId)
                if (!ok) {
                  logger.warn(
                    `openclaw-amem: CRUD DELETE denied id=${target.id.slice(0, 8)} — ${agentId} not in writers`
                  )
                  continue
                }
                logger.info(
                  `openclaw-amem: CRUD INVALIDATE id=${target.id.slice(0, 8)}: "${op.fact.slice(0, 60)}${op.fact.length > 60 ? '...' : ''}"`
                )
              }
            }
            // NONE: skip
          }

          // 同步触发碎片合并（Story 29: 改为 await 确保执行完毕）
          const today = new Date().toISOString().slice(0, 10)
          logger.info(`openclaw-amem: starting mergeSimilarNotes for agent=${agentId}, date=${today}`)
          try {
            const merged = await mergeSimilarNotes(agentId, storageCtx)
            if (merged > 0) {
              logger.info(`openclaw-amem: merged ${merged} similar notes today (${today})`)
            } else {
              logger.info(`openclaw-amem: mergeSimilarNotes completed, 0 pairs merged (${today})`)
            }
          } catch (mergeErr) {
            logger.error(
              `openclaw-amem: mergeSimilarNotes FAILED — ${(mergeErr as Error).message}\n${(mergeErr as Error).stack}`
            )
          }
        } catch (e) {
          logger.warn(`openclaw-amem: agent_end CRUD hook failed — ${(e as Error).message}`)
        }
      },
      { timeoutMs: 30000 }
    )
    logger.info('openclaw-amem: agent_end CRUD decision hook registered')
  }

  // ── scheduleNextRun ──────────────────────────────────────────────────────
  function scheduleNextRun() {
    const now = new Date()
    const target = new Date()
    target.setHours(2, 30, 0, 0)
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1)
    }
    const delay = target.getTime() - now.getTime()
    setTimeout(async () => {
      try {
        logger.info('openclaw-amem: Running scheduled daily consolidation...')
        // Background task — no per-session ctx, operate on the default agent scope.
        const merged = await consolidateMemories(defaultScope.agentId, logger, defaultScope.storageCtx)
        if (merged > 0) {
          logger.info(`openclaw-amem: Scheduled daily consolidation merged ${merged} pairs.`)
        }
      } catch (err) {
        logger.warn(`openclaw-amem: Scheduled daily consolidation failed — ${(err as Error).message}`)
      }

      // Story 43: the cold half of the tiering split. The per-turn CRUD decision
      // runs on the fast model, which is safe but misses contradictions; this is
      // what catches them. Runs AFTER consolidation, and in its own try/catch, so
      // neither task can take the other down.
      //
      // Only batches that gained a note since the last run are re-read, so a
      // steady-state night costs a call or two rather than a full re-read.
      if (conflictSweepEnabled) {
        try {
          const res = await conflictSweep(defaultScope.agentId, {
            storageCtx: defaultScope.storageCtx,
            logger,
          })
          if (res.pairsFound > 0) {
            logger.info(
              `openclaw-amem: Contradiction sweep flagged ${res.pairsFound} pair(s)` +
                (res.retired > 0 ? `, retired ${res.retired}` : '') +
                ` (${res.batchesScanned} batch(es) read, ${res.batchesSkipped} unchanged).`
            )
          }
        } catch (err) {
          logger.warn(`openclaw-amem: Scheduled contradiction sweep failed — ${(err as Error).message}`)
        }
      }
      scheduleNextRun()
    }, delay)
  }
  scheduleNextRun()

  // ── registerService ──────────────────────────────────────────────────────
  if (typeof api.registerService === 'function') {
    api.registerService({
      id: 'amem-plugin',
      start() {
        logger.info(`openclaw-amem: started (backend: amem-qdrant, default agentId: ${defaultScope.agentId})`)
      },
      stop() {
        logger.info('openclaw-amem: stopped')
      },
    })
  } else {
    logger.info(`openclaw-amem: initialized (backend: amem-qdrant, default agentId: ${defaultScope.agentId})`)
  }
}

const plugin = definePluginEntry({
  id: 'openclaw-amem',
  name: 'amem — agentic memory',
  description:
    'Agentic memory for OpenClaw — memories evolve, link into a graph, and stay separated per agent and per person.',
  register,
})

export default plugin
export { register }
export {
  addMemory,
  searchMemory,
  listMemories,
  mergeSimilarNotes,
  consolidateMemories,
  checkQuality,
  ensureCollection,
  getNote,
  updateNote,
  deleteNote,
  invalidateNote,
  listNotes,
  patchNotePayload,
  scanLowQuality,
  generateReviewBatch,
} from '@heichaowo/amem-core'

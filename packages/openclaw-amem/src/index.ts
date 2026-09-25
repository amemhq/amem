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
  EmbeddingDimensionMismatchError,
  EmbeddingModelMismatchError,
  MixedEmbeddingModelsError,
  isPlausibleUpdateTarget,
  hasTimeFor,
  runInBackground,
  BackgroundPreempted,
  type AmemPluginConfig,
} from '@amemhq/core'
import { createHash } from 'crypto'
import { isConvAccessBlocked, BLOCKED_WARNING_LOG, BLOCKED_WARNING_SUFFIX } from './conv-access.js'
import {
  scheduleNightly,
  cancelNightly,
  markOwed,
  runNightly,
  watchAgentEvents,
  unwatchAgentEvents,
  foregroundWorkStarted,
  compactionStarted,
  compactionEnded,
  noteMessageReceived,
  busySinceNow,
  type AgentEvent,
} from './nightly.js'
import {
  resolveAgentId as resolveAgentIdWith,
  buildScope as buildScopeWith,
  type AgentCtx,
  type AgentScope,
} from './scope.js'

// ── Config ────────────────────────────────────────────────────────────────────
let _config: Record<string, unknown> = {}

// agent_end's budget, declared to the host below. The host stops waiting at this point
// but does not cancel the work, so the hook stops itself a little before it (#158).
const HOOK_BUDGET_MS = 30_000
const HOOK_MARGIN_MS = 2_000

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
  // `warn` is the important half: the engine's default is stderr, and the gateway
  // runs under launchd with StandardErrorPath=/dev/null, so without this every
  // recovered failure it reports is discarded before anything can read it.
  configure({
    dataDir: path.join(os.homedir(), '.openclaw'),
    warn: (msg: string) => logger.warn(msg),
  })

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
    pluginConfig.llmThinking ||
    hasStrong
  ) {
    configureLlm({
      provider: pluginConfig.llmProvider,
      model: pluginConfig.llmModel,
      baseURL: pluginConfig.llmBaseURL,
      crudRole: pluginConfig.llmCrudRole,
      thinking: pluginConfig.llmThinking,
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

  // The nightly merge visits only the agents that wrote since it last ran (nightly.ts).
  // Recorded by raw agent id, because the night rebuilds each scope with buildScope.
  // A failure here must not cost the write it follows, so it only warns.
  const owedFile = path.join(os.homedir(), '.openclaw', 'amem_nightly_owed.json')
  const owe = (rawAgentId: string, since: Date) => {
    try {
      markOwed(owedFile, rawAgentId, since)
    } catch (err) {
      logger.warn(`openclaw-amem: could not record ${rawAgentId} for the nightly merge — ${(err as Error).message}`)
    }
  }

  logger.info(
    `openclaw-amem: registered (native TS, Qdrant, default agent_id=${defaultScope.agentId}, default collection=${pluginConfig.collection ?? 'amem_notes (default)'}, per-agent scope resolved per call)`
  )

  // Pre-warm: ensure the default Qdrant collection exists. Run from the service's start().
  // An embedding mismatch is not a transient startup hiccup — memory is simply
  // broken until someone acts — so it is logged as an error with the fix, not as
  // one more warning to scroll past. All three qualify: the model one does not
  // stop writes, but it silently mixes two vector geometries, which is worse to
  // discover late than a hard failure.
  const checkCollection = () =>
    ensureCollection(pluginConfig.collection).catch((e) => {
      if (
        e instanceof EmbeddingDimensionMismatchError ||
        e instanceof EmbeddingModelMismatchError ||
        e instanceof MixedEmbeddingModelsError
      ) {
        logger.error(`openclaw-amem: memory is UNUSABLE — ${e.message}`)
      } else {
        logger.warn(`openclaw-amem: ensureCollection failed — ${e.message}`)
      }
    })

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
                    const since = new Date()
                    await addMemory(text, scope.agentId, { storageCtx: scope.storageCtx })
                    owe(resolveAgentId(params), since)
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
              // Labelled "similarity", not "score". It is the cosine distance to
              // the query and it did NOT order this list — matches are ranked by
              // the fused BM25+dense score, and the linked ones are not ranked at
              // all. Calling it "score" invited exactly the reading that the
              // ranking was broken because the percentages are not monotonic.
              const linked = results.filter((r) => r.via === 'link').length
              const text = results
                .map(
                  (r, i) =>
                    `${i + 1}. ${r.content} (similarity ${(r.similarity * 100).toFixed(0)}%` +
                    `${r.via === 'link' ? ', linked — did not match the query itself' : ''}, id: ${r.id})`
                )
                .join('\n')
              const header = linked
                ? `Found ${results.length - linked} matching memories, plus ${linked} linked to them:`
                : `Found ${results.length} memories:`
              return {
                content: [{ type: 'text', text: `${header}\n\n${text}${hookWarning}` }],
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
              owe(resolveAgentId(ctx), new Date(start))
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

    // Foreground work that sends no run events, so the nightly job cannot see it otherwise
    // (#158). A compaction runs the user's model before a turn. A channel turn bound to an
    // ACP session reaches plugins only as the incoming message.
    hookFn('before_compaction', (_event: unknown, ctx?: { sessionKey?: string; sessionId?: string }) =>
      compactionStarted(ctx)
    )
    hookFn('after_compaction', (_event: unknown, ctx?: { sessionKey?: string; sessionId?: string }) =>
      compactionEnded(ctx)
    )
    hookFn('message_received', (event?: { providerUpdate?: { kind?: string; editedTimestamp?: number } }) =>
      noteMessageReceived(event)
    )

    hookFn(
      'agent_end',
      async (
        event: {
          messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
          success?: boolean
        },
        ctx?: AgentCtx
      ) => {
        const deadline = Date.now() + HOOK_BUDGET_MS - HOOK_MARGIN_MS
        // Story 32 (Issue 1): resolve the per-session agent scope from the hook ctx.
        const scope = buildScope(resolveAgentId(ctx))
        const agentId = scope.agentId
        const storageCtx = scope.storageCtx
        logger.info(
          `openclaw-amem: agent_end hook triggered (agent_id=${agentId}, success=${event.success}, messages=${event.messages?.length ?? 0})`
        )
        // The nightly job does not start a step while this writes (#158).
        const done = foregroundWorkStarted()
        // Set just before the first write. The nightly merge reads from here on.
        let since: Date | undefined
        try {
          if (!event.success) {
            logger.info('openclaw-amem: agent_end skipped — event.success is false')
            return
          }
          // Extract last user + assistant exchange
          const msgs = event.messages || []
          const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
          const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
          // Not the ordinary quiet turn — the hook fired on an exchange with a
          // side missing, so there was nothing to consider storing.
          if (!lastUser || !lastAssistant) {
            logger.info(
              `openclaw-amem: agent_end skipped — no ${!lastUser ? 'user' : 'assistant'} message in ${msgs.length} messages`
            )
            return
          }

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
          const { llmCrudDecision } = await import('@amemhq/core')
          const operations = await llmCrudDecision(
            userText,
            assistantText,
            existingMemories.map((m) => ({ idx: m.idx, content: m.content })),
            { deadline }
          )

          if (!operations || operations.length === 0) return

          // ── Step 4: 执行 CRUD 操作 ───────────────────────────────────────────────
          since = new Date()
          for (const [i, op] of operations.entries()) {
            // What has been stored stays stored. The rest of this turn's facts are lost,
            // which is the price of not racing the next turn's hook over the same notes.
            if (!hasTimeFor(deadline)) {
              logger.warn(`openclaw-amem: agent_end out of time, stored ${i} of ${operations.length} operations`)
              break
            }
            if (op.action === 'NEW') {
              await addMemory(op.fact, agentId, { storageCtx, deadline })
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
                  await addMemory(op.fact, agentId, { storageCtx, deadline })
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
        } catch (e) {
          logger.warn(`openclaw-amem: agent_end CRUD hook failed — ${(e as Error).message}`)
        } finally {
          // Also after an operation that threw: the ones before it may have stored notes.
          if (since) owe(resolveAgentId(ctx), since)
          done()
        }
      },
      { timeoutMs: HOOK_BUDGET_MS }
    )
    logger.info('openclaw-amem: agent_end CRUD decision hook registered')
  }

  // ── nightly job (02:30) — one per process, see nightly.ts ─────────────────
  // It stays out of the way of the user's runs (#158). Inside runInBackground an LLM call
  // throws BackgroundPreempted once anything has happened in the gateway since the step
  // began, and the step runs again from a fresh read when the gateway is idle. Scheduled
  // from the service's start().
  const nightlyJob = () =>
    runNightly({
      owedFile,
      defaultAgent: resolveAgentId(),
      mergeDay: async (rawAgentId, day) => {
        const scope = buildScope(rawAgentId)
        const merged = await mergeSimilarNotes(scope.agentId, scope.storageCtx, day)
        if (merged > 0) logger.info(`openclaw-amem: merged ${merged} similar notes (${scope.agentId}, ${day})`)
      },
      after: [
        {
          name: 'consolidation',
          run: async () => {
            logger.info('openclaw-amem: Running scheduled daily consolidation...')
            // Background task — no per-session ctx, operate on the default agent scope.
            const merged = await consolidateMemories(defaultScope.agentId, logger, defaultScope.storageCtx)
            if (merged > 0) {
              logger.info(`openclaw-amem: Scheduled daily consolidation merged ${merged} pairs.`)
            }
          },
        },
        // Story 43: the cold half of the tiering split. The per-turn CRUD decision
        // runs on the fast model, which is safe but misses contradictions; this is
        // what catches them. Runs AFTER consolidation, as its own step, so neither
        // task can take the other down.
        //
        // Only batches that gained a note since the last run are re-read, so a
        // steady-state night costs a call or two rather than a full re-read.
        ...(conflictSweepEnabled
          ? [
              {
                name: 'contradiction sweep',
                run: async () => {
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
                },
              },
            ]
          : []),
      ],
      inBackground: (work) => runInBackground(busySinceNow(), work),
      preempted: (err) => err instanceof BackgroundPreempted,
      logger,
    })

  // ── registerService ──────────────────────────────────────────────────────
  if (typeof api.registerService === 'function') {
    api.registerService({
      id: 'amem-plugin',
      start() {
        // Everything with a side effect starts here and not in register(). OpenClaw also runs
        // register() in CLI commands, in a cli-metadata mode where reading api.runtime
        // throws, and in the gateway's model-catalog worker threads, which never exit and
        // each have their own globalThis, so a timer there is a second nightly job that sees
        // no runs. It starts services only in the gateway and in one-shot diagnostics.
        const events = (api as any).runtime?.events
        if (typeof events?.onAgentEvent === 'function') {
          watchAgentEvents((listener: (evt: AgentEvent) => void) => events.onAgentEvent(listener))
        } else {
          logger.warn(
            'openclaw-amem: this OpenClaw does not report runs to plugins, so the nightly job cannot wait for them'
          )
        }
        scheduleNightly(nightlyJob, (err) =>
          logger.warn(`openclaw-amem: nightly job failed — ${(err as Error).message}`)
        )
        void checkCollection()
        logger.info(`openclaw-amem: started (backend: amem-qdrant, default agentId: ${defaultScope.agentId})`)
      },
      stop() {
        cancelNightly()
        unwatchAgentEvents()
        logger.info('openclaw-amem: stopped')
      },
    })
  } else {
    logger.info(`openclaw-amem: initialized (backend: amem-qdrant, default agentId: ${defaultScope.agentId})`)
  }
}

const plugin = definePluginEntry({
  id: 'openclaw-amem',
  name: 'amem',
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
} from '@amemhq/core'

/**
 * llm.ts — LLM helpers for A-MEM note construction, linking, evolution
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { t } from './prompts.js'

// ── Provider selection ────────────────────────────────────────────────────────
// The engine's LLM calls are all "prompt in, text out" — no streaming, tools, or
// vision — so one switch covers every backend. `anthropic` (default) keeps the
// native Messages API; `openai` speaks the Chat Completions API, which every
// OpenAI-compatible gateway implements (OpenAI, DeepSeek, OpenRouter, Groq,
// Together, Ollama, vLLM, LM Studio…). Point the base URL at whichever one.
//
// Story 35: these used to be top-level consts, which froze the choice at import
// and left a host with no way in short of relaunching the process. They are now
// resolved per call, so a host can hand the engine a model through
// `configureLlm()` after import. Precedence, highest first:
//
//   1. environment variable        — the operator's override, always wins
//   2. configureLlm()              — what the host (e.g. openclaw.json) asked for
//   3. built-in default            — per provider
//
// Note what is deliberately absent: there is no way to inject an API key. Keys
// come from the environment only. Configuration arrives from a host config file,
// and an apiKey field here would be an invitation to pipe a user's credentials
// out of that file and into the memory engine. Endpoint and model, yes; secrets,
// no.

/**
 * Which tier a call runs on (Story 42).
 *
 * The engine's calls split cleanly by how much model capability they actually
 * need. Published results are consistent that memory quality is mostly
 * architecture-bound — extraction differs ~2 points between a cheap and a strong
 * model — with ONE exception: judging whether a new fact CONTRADICTS a stored
 * one, where the gap is large. So the frequent, easy calls run `fast`, and the
 * rare, genuinely hard judgements can run `strong` if the operator configures
 * one. See docs/guide/design-rationale.md for the evidence.
 */
export type LlmRole = 'fast' | 'strong'

/** Provider/model/endpoint for one role. */
export interface LlmRoleConfig {
  provider?: string
  model?: string
  baseURL?: string
}

/** Runtime LLM settings a host may inject. See the precedence note above. */
export interface LlmConfig extends LlmRoleConfig {
  /** Per-request timeout in ms for the SDK client. Guards against a slow or
   * stuck endpoint hanging the whole addMemory pipeline. Default 30000.
   * Shared by both roles — it is a transport concern, not a tier one. */
  timeoutMs?: number
  /**
   * Optional `strong` tier. Each field falls back to the `fast` value
   * INDIVIDUALLY, so all three useful shapes work:
   *   - only `model`      → same endpoint, better model (gpt-4o-mini → gpt-4o)
   *   - all three         → a wholly separate backend (local Ollama + cloud Claude)
   *   - nothing           → strong IS fast, i.e. today's single-model behaviour
   * There is deliberately no built-in strong default: inventing one would start
   * spending an existing user's money on a pricier model without them asking.
   */
  strong?: LlmRoleConfig
  /** Which role the agent_end CRUD decision uses. Default `fast`. */
  crudRole?: LlmRole
}

let _override: LlmConfig = {}

/**
 * Point the engine's LLM calls at a provider/model/endpoint chosen by the host.
 *
 * Environment variables still win over anything passed here, and any field left
 * undefined falls through to the default — so `configureLlm({ model })` changes
 * only the model. Safe to call before or after the first LLM call.
 */
export function configureLlm(cfg: LlmConfig): void {
  _override = { ...cfg }
  // The clients capture the base URL and key chain at construction, so a cached
  // one would keep talking to the old endpoint. Drop them and let the next call
  // rebuild against the new settings.
  _anthropicClients.clear()
  _openaiClients.clear()
}

// Resolution runs on every call, so a bad provider value would log on every call.
const _warned = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (_warned.has(key)) return
  _warned.add(key)
  console.error(message)
}

// `||`, not `??`, on purpose: an env var set to the empty string means "unset"
// here. With `??` an exported-but-empty AMEM_LLM_MODEL would outrank a perfectly
// valid model from openclaw.json and silently win, which is a miserable thing to
// debug.
function resolveProvider(role: LlmRole = 'fast'): string {
  // Strong falls back to fast per field, so an operator who only names a strong
  // MODEL keeps the same provider and endpoint — the common "same API, better
  // model" case.
  const raw =
    role === 'strong' ? process.env.AMEM_LLM_STRONG_PROVIDER || _override.strong?.provider || undefined : undefined
  const p = (raw || process.env.AMEM_LLM_PROVIDER || _override.provider || 'anthropic').trim().toLowerCase()
  if (p !== 'anthropic' && p !== 'openai') {
    // An unrecognised value silently routes to the anthropic path with the wrong
    // model/endpoint — surface it instead of failing invisibly on every call.
    warnOnce(`provider:${p}`, `[amem] unknown LLM provider "${p}"; falling back to anthropic`)
  }
  return p
}

function resolveModel(role: LlmRole = 'fast'): string {
  const strong =
    role === 'strong' ? process.env.AMEM_LLM_STRONG_MODEL || _override.strong?.model || undefined : undefined
  return (
    strong ||
    process.env.AMEM_LLM_MODEL ||
    _override.model ||
    (resolveProvider(role) === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-6')
  )
}

function resolveBaseURL(role: LlmRole = 'fast'): string | undefined {
  const strong =
    role === 'strong' ? process.env.AMEM_LLM_STRONG_BASE_URL || _override.strong?.baseURL || undefined : undefined
  return strong || process.env.AMEM_LLM_BASE_URL || _override.baseURL || undefined
}

/**
 * Which role the agent_end CRUD decision runs on. Defaults to `fast` — see the
 * note at its call site. An unrecognised value falls back to `fast` rather than
 * failing, and warns once.
 */
function resolveCrudRole(): LlmRole {
  const raw = (process.env.AMEM_LLM_CRUD_ROLE || _override.crudRole || 'fast').trim().toLowerCase()
  if (raw === 'strong') return 'strong'
  if (raw !== 'fast') {
    warnOnce(`crudRole:${raw}`, `[amem] unknown AMEM_LLM_CRUD_ROLE "${raw}"; using fast`)
  }
  return 'fast'
}

const DEFAULT_TIMEOUT_MS = 30_000
function resolveTimeoutMs(): number {
  const envVal = Number(process.env.AMEM_LLM_TIMEOUT)
  if (Number.isFinite(envVal) && envVal > 0) return envVal
  if (_override.timeoutMs && _override.timeoutMs > 0) return _override.timeoutMs
  return DEFAULT_TIMEOUT_MS
}

// ── Clients (lazy, keyed by endpoint) ─────────────────────────────────────────
// Constructed on first use, not at import, so loading the engine never builds a
// client for the provider you are not using — nor demands its API key. Local
// OpenAI-compatible servers (Ollama, vLLM) accept any key, so a placeholder lets
// them run keyless.
//
// Keyed by base URL rather than held as a singleton: the two roles may point at
// different backends (a local Ollama for `fast`, a hosted API for `strong`), and
// a single cached client would silently send one role's calls to the other's
// endpoint.
const _anthropicClients = new Map<string, Anthropic>()
function anthropic(baseURL: string | undefined): Anthropic {
  const key = baseURL ?? ''
  let client = _anthropicClients.get(key)
  if (!client) {
    client = new Anthropic({
      ...(process.env.AMEM_LLM_API_KEY && { apiKey: process.env.AMEM_LLM_API_KEY }),
      ...(baseURL && { baseURL }),
      timeout: resolveTimeoutMs(),
    })
    _anthropicClients.set(key, client)
  }
  return client
}

const _openaiClients = new Map<string, OpenAI>()
function openai(baseURL: string | undefined): OpenAI {
  const key = baseURL ?? ''
  let client = _openaiClients.get(key)
  if (!client) {
    client = new OpenAI({
      // AMEM_LLM_API_KEY first (engine convention), then the SDK's own
      // OPENAI_API_KEY (the standard) — passing an explicit key blocks the SDK's
      // env fallback, so read it here. Placeholder last, so keyless local servers
      // (Ollama, vLLM) still work.
      apiKey: process.env.AMEM_LLM_API_KEY || process.env.OPENAI_API_KEY || 'sk-no-key-required',
      ...(baseURL && { baseURL }),
      timeout: resolveTimeoutMs(),
    })
    _openaiClients.set(key, client)
  }
  return client
}

// ── Base LLM call ─────────────────────────────────────────────────────────────
export async function llmCall(prompt: string, maxTokens = 500, role: LlmRole = 'fast'): Promise<string | null> {
  const provider = resolveProvider(role)
  const model = resolveModel(role)
  const baseURL = resolveBaseURL(role)
  // Gemini thinking models consume extra tokens for reasoning; scale up automatically
  const isThinking = model.includes('gemini') || model.includes('pro-agent')
  const effectiveMaxTokens = isThinking ? Math.max(maxTokens * 8, 4000) : maxTokens
  try {
    return provider === 'openai'
      ? await openaiCall(prompt, model, effectiveMaxTokens, baseURL)
      : await anthropicCall(prompt, model, effectiveMaxTokens, baseURL)
  } catch (e) {
    console.error(`[amem] LLM call failed: ${(e as Error).message}`)
    return null
  }
}

async function anthropicCall(
  prompt: string,
  model: string,
  maxTokens: number,
  baseURL: string | undefined
): Promise<string | null> {
  const resp = await anthropic(baseURL).messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  for (const block of resp.content) {
    if (block.type === 'text') return block.text.trim()
  }
  return null
}

async function openaiCall(
  prompt: string,
  model: string,
  maxTokens: number,
  baseURL: string | undefined
): Promise<string | null> {
  // OpenAI's own reasoning models (o1/o3, gpt-5) reject `max_tokens` and require
  // `max_completion_tokens`; everything else takes `max_tokens`. Same budget for
  // our single-shot completions — only the parameter name differs. Match OpenAI
  // names narrowly: a broad `includes('reason')` would wrongly catch other
  // gateways' models (e.g. DeepSeek's `deepseek-reasoner`, which uses max_tokens).
  const isReasoning = /^o\d/.test(model) || model.startsWith('gpt-5')
  const resp = await openai(baseURL).chat.completions.create({
    model,
    ...(isReasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    messages: [{ role: 'user', content: prompt }],
  })
  return resp.choices[0]?.message?.content?.trim() ?? null
}

// ── Response cleaning + tolerant JSON parsing ─────────────────────────────────

/**
 * Remove reasoning-model scaffolding that would otherwise break JSON.parse:
 * `<think>…</think>` blocks and chat special tokens (`<|eot_id|>`, `<|im_end|>`,
 * …). Open-weight models reachable via any OpenAI-compatible `baseURL`
 * (DeepSeek-R1, Qwen, LLaMA-3 through Ollama/vLLM) emit these around otherwise
 * valid JSON. Without stripping them every JSON task silently falls back to its
 * default on a good response — and nothing in the logs says why.
 */
function stripReasoning(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|(?:eot_id|im_start|im_end|begin_of_text|end_of_text|endoftext)\|>/g, '')
    .trim()
}

function stripFences(raw: string): string {
  raw = stripReasoning(raw)
  if (raw.startsWith('```')) {
    const lines = raw.split('\n')
    lines.shift()
    if (lines[lines.length - 1] === '```') lines.pop()
    raw = lines.join('\n').trim()
  }
  // Handle models that wrap JSON in outer quotes: "{ ... }" or "[...]"
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    try {
      raw = JSON.parse(raw)
    } catch {
      /* keep as-is */
    }
  }
  return raw
}

/**
 * Parse a JSON object from an LLM response, tolerant of a leading preamble
 * sentence before the object (common with smaller instruction-tuned models).
 * Drop-in for `JSON.parse(stripFences(raw))`: it still THROWS when nothing
 * parses, so every caller's existing try/catch → default still fires, and it
 * returns `any` for the same reason JSON.parse does — callers guard each field.
 */
function parseJsonLoose(raw: string): any {
  const cleaned = stripFences(raw)
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) return JSON.parse(m[0]) // may throw again → caller's catch handles it
    throw e
  }
}

// ── Note construction ─────────────────────────────────────────────────────────

/**
 * Valid category values (Story 13-E).
 * "General" is the fallback for anything that doesn't fit a specific bucket.
 */
export type NoteCategory = 'Technical' | 'Business' | 'Personal' | 'Project' | 'Research' | 'System' | 'General'

export interface NoteStructure {
  keywords: string[]
  tags: string[]
  context: string
  /** Story 13-E: coarse-grained category */
  category: NoteCategory
  /** Story 26A: episodic memory vs durable knowledge */
  note_type: 'memory' | 'knowledge'
  /** Story 26B: topic tags, non-empty only for knowledge notes */
  topics: string[]
  /** Story 27: LLM self-reported confidence in note_type classification */
  confidence: 'high' | 'medium' | 'low'
}

const VALID_CONFIDENCE = new Set<string>(['high', 'medium', 'low'])

const VALID_CATEGORIES = new Set<string>([
  'Technical',
  'Business',
  'Personal',
  'Project',
  'Research',
  'System',
  'General',
])

export async function llmConstructNote(content: string): Promise<NoteStructure> {
  const prompt = `Analyze the following text and respond with valid JSON only (no markdown fences, no explanation, no comments). All string values must use standard double quotes and be properly escaped:
{
  "keywords": ["keyword1", "keyword2"],
  "tags": ["tag1", "tag2"],
  "context": "one sentence summary in the same language as the input",
  "category": "Technical|Business|Personal|Project|Research|System|General",
  "note_type": "memory|knowledge",
  "topics": ["Topic1", "Topic2"],
  "confidence": "high|medium|low"
}

Category guide:
- Technical: code, tools, configuration, APIs, debugging
- Business: company, finance, compliance, contracts, invoices
- Personal: personal state, habits, preferences, emotions
- Project: project progress, decisions, milestones
- Research: research, literature, evaluation, comparison
- System: system services, monitoring, operations
- General: anything that does not fit the above

note_type guide:
- knowledge: books, methodologies, tools, domain knowledge, reference material — durable, no strong time component
- memory: events, decisions, preferences, states, observations — episodic, time-sensitive

topics guide (Story 26B):
- Only populate for knowledge notes (note_type=knowledge). For memory notes, return [].
- List 1-5 concise subject tags representing the main topics of this knowledge, e.g. ["TypeScript", "Qdrant", "Vector DB"].

confidence guide (Story 27):
- high: note_type is unambiguous — clearly episodic (event/decision/state) or clearly durable knowledge (tool doc/methodology)
- medium: some ambiguity — e.g. "learned X method" could be either memory or knowledge
- low: LLM is uncertain — vague, fragmentary, or mixed content

Text: ${content}`

  const raw = await llmCall(prompt, 400)
  if (!raw)
    return {
      keywords: [],
      tags: [],
      context: '',
      category: 'General',
      note_type: 'memory',
      topics: [],
      confidence: 'medium',
    }

  try {
    const data = parseJsonLoose(raw)
    const rawCategory = typeof data.category === 'string' ? data.category : 'General'
    const category: NoteCategory = VALID_CATEGORIES.has(rawCategory) ? (rawCategory as NoteCategory) : 'General'
    const note_type: 'memory' | 'knowledge' = data.note_type === 'knowledge' ? 'knowledge' : 'memory'
    const topics: string[] =
      note_type === 'knowledge' && Array.isArray(data.topics)
        ? (data.topics as unknown[]).filter((v): v is string => typeof v === 'string')
        : []
    const rawConfidence = typeof data.confidence === 'string' ? data.confidence : 'medium'
    const confidence: 'high' | 'medium' | 'low' = VALID_CONFIDENCE.has(rawConfidence)
      ? (rawConfidence as 'high' | 'medium' | 'low')
      : 'medium'
    return {
      keywords: Array.isArray(data.keywords) ? data.keywords : [],
      tags: Array.isArray(data.tags) ? data.tags : [],
      context: typeof data.context === 'string' ? data.context : '',
      category,
      note_type,
      topics,
      confidence,
    }
  } catch (e) {
    console.error(`[amem] Note construction parse failed: ${(e as Error).message}`)
    return {
      keywords: [],
      tags: [],
      context: '',
      category: 'General',
      note_type: 'memory',
      topics: [],
      confidence: 'medium',
    }
  }
}

// ── Link judgment ─────────────────────────────────────────────────────────────
export async function llmShouldLink(noteContent: string, candidateContent: string): Promise<boolean> {
  const prompt = `Do these two memory notes have a meaningful relationship that would be useful to link?
Reply with only "yes" or "no".

Note A: ${noteContent}
Note B: ${candidateContent}`

  const raw = await llmCall(prompt, 10)
  if (!raw) return false
  return raw.toLowerCase().startsWith('yes')
}

// ── CRUD Decision ────────────────────────────────────────────────────────────
export interface MemoryOperation {
  action: 'NEW' | 'UPDATE' | 'DELETE' | 'NONE'
  fact: string
  existingIdx?: number // For UPDATE/DELETE: integer index into existingMemories (guards against hallucination)
  reason?: string
}

export async function llmCrudDecision(
  userText: string,
  assistantText: string,
  existingMemories: Array<{ idx: number; content: string }>
): Promise<MemoryOperation[]> {
  const memoryList =
    existingMemories.length > 0 ? existingMemories.map((m) => `[${m.idx}] ${m.content}`).join('\n') : '(none)'

  const prompt = t.crudDecision(userText.slice(0, 500), assistantText.slice(0, 500), memoryList)

  try {
    // Story 42: defaults to `fast`. It IS a contradiction judgement, but it runs
    // on every turn, and its one destructive failure mode (overwriting the wrong
    // memory) is already handled architecturally by the Story 41 guard rather
    // than by buying a bigger model. Operators who want it on `strong` can say so.
    const raw = await llmCall(prompt, 400, resolveCrudRole())
    if (!raw) return []
    // Strip reasoning scaffolding first — this path extracts the array straight
    // from the response and would otherwise trip over a <think> block.
    const match = stripReasoning(raw).match(/\[.*\]/s)
    if (!match) return []
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    const ops: MemoryOperation[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const action = item.action
      if (!['NEW', 'UPDATE', 'DELETE', 'NONE'].includes(action)) continue
      if (action === 'NONE') continue
      const op: MemoryOperation = {
        action,
        fact: typeof item.fact === 'string' ? item.fact : '',
        reason: typeof item.reason === 'string' ? item.reason : undefined,
      }
      if (typeof item.existingIdx === 'number') {
        op.existingIdx = item.existingIdx
      }
      ops.push(op)
    }
    return ops.slice(0, 3)
  } catch (e) {
    console.error(`[amem] llmCrudDecision failed: ${(e as Error).message}`)
    return []
  }
}

// ── Merge judgment ───────────────────────────────────────────────────────────
export async function llmShouldMerge(
  contentA: string,
  contentB: string
): Promise<{ shouldMerge: boolean; merged?: string }> {
  const prompt = t.shouldMerge(contentA, contentB)

  // Story 42: merge adjudication is the contradiction class — the one place a
  // stronger model measurably helps. Runs on `strong` when one is configured.
  const raw = await llmCall(prompt, 300, 'strong')
  if (!raw) return { shouldMerge: false }

  try {
    const data = parseJsonLoose(raw)
    if (typeof data.shouldMerge !== 'boolean') return { shouldMerge: false }
    if (data.shouldMerge && typeof data.merged === 'string') {
      return { shouldMerge: true, merged: data.merged }
    }
    return { shouldMerge: false }
  } catch (e) {
    console.error(`[amem] llmShouldMerge parse failed: ${(e as Error).message}`)
    return { shouldMerge: false }
  }
}

// ── Note evolution ────────────────────────────────────────────────────────────

// ── Story 30: Evolution type judgment ────────────────────────────────────────
export type EvolutionType = 'EVOLVE' | 'CONFLICT' | 'EXPAND' | 'NEW'

const VALID_EVOLUTION_TYPES = new Set<string>(['EVOLVE', 'CONFLICT', 'EXPAND', 'NEW'])

export async function llmEvolutionJudge(
  oldContent: string,
  newContent: string
): Promise<{ type: EvolutionType; mergedContent?: string }> {
  const prompt = t.evolutionJudge(oldContent, newContent)

  // Story 42: EVOLVE/CONFLICT/EXPAND/NEW is literally contradiction
  // classification — the tier-sensitive call. Runs on `strong` when configured.
  const raw = await llmCall(prompt, 300, 'strong')
  if (!raw) return { type: 'NEW' }

  try {
    const data = parseJsonLoose(raw)
    const type: EvolutionType = VALID_EVOLUTION_TYPES.has(data.type) ? (data.type as EvolutionType) : 'NEW'
    return {
      type,
      mergedContent: typeof data.mergedContent === 'string' ? data.mergedContent : undefined,
    }
  } catch (e) {
    console.error(`[amem] llmEvolutionJudge parse failed: ${(e as Error).message}`)
    return { type: 'NEW' }
  }
}

// ── Note evolution (legacy) ──────────────────────────────────────────────────
export interface EvolvedNote {
  tags: string[] | null
  context: string | null
  shouldStrengthen: boolean
  suggestedConnections: string[]
  tagsToUpdate: string[]
}

export async function llmEvolveNote(
  content: string,
  linkedNotes: Array<{ id: string; content: string }>
): Promise<EvolvedNote> {
  const linkedStr = linkedNotes.map((n) => `- ID: ${n.id}\n  Content: ${n.content}`).join('\n')
  const prompt = `A memory note has gained new connections. Update its context, tags, and decide whether to strengthen connections with specific neighbors.
Reply with JSON only (no markdown):
{
  "tags": ["tag1", "tag2", ...],
  "context": "updated one sentence summary",
  "should_strengthen": true|false,
  "suggested_connections": ["neighbor_id_1", "neighbor_id_2", ...],
  "tags_to_update": ["tag_1", ..., "tag_n"]
}

Guidelines:
- "tags" and "context" are for updating the original note based on new connections.
- "should_strengthen" is a decision whether this note should strengthen its connections to any of the newly linked notes (neighbors).
- "suggested_connections" must contain only IDs from the newly linked notes (neighbors) listed below.
- "tags_to_update" are updated tags for the original note itself if we strengthen connections.

Original note content: ${content}

Newly linked notes (neighbors):
${linkedStr}`

  const raw = await llmCall(prompt, 500)
  if (!raw) return { tags: null, context: null, shouldStrengthen: false, suggestedConnections: [], tagsToUpdate: [] }

  try {
    const data = parseJsonLoose(raw)
    return {
      tags: Array.isArray(data.tags) ? data.tags : null,
      context: typeof data.context === 'string' ? data.context : null,
      shouldStrengthen: typeof data.should_strengthen === 'boolean' ? data.should_strengthen : false,
      suggestedConnections: Array.isArray(data.suggested_connections) ? data.suggested_connections.map(String) : [],
      tagsToUpdate: Array.isArray(data.tags_to_update) ? data.tags_to_update.map(String) : [],
    }
  } catch (e) {
    console.error(`[amem] Evolution parse failed: ${(e as Error).message}`)
    return { tags: null, context: null, shouldStrengthen: false, suggestedConnections: [], tagsToUpdate: [] }
  }
}

// ── Story 43: batched contradiction scan ──────────────────────────────────────

/** One contradicting pair, as indices into the batch that was scanned. */
export interface ConflictPair {
  a: number
  b: number
  reason: string
  /**
   * Which side the model judged to be SUPERSEDED — the one no longer true.
   * `null` when it could not tell, which is common and must be respected.
   *
   * This is deliberately a semantic judgement rather than a timestamp
   * comparison. A note carries only its INGESTION time, and the two clocks come
   * apart constantly: "back in 2019 I was vegetarian", written today, is newer
   * on the wall clock and older in fact. The evidence for which fact is current
   * lives in the TEXT ("moved last month", "used to", "switched to"), which is
   * exactly what the model is already reading.
   */
  supersededIndex: number | null
}

/**
 * Ask the model which memories in a batch contradict each other.
 *
 * Deliberately NOT pairwise. The engine's existing consolidation pairs notes by
 * cosine similarity, which structurally cannot surface the contradictions that
 * matter here — "is vegetarian" and "loved the steak" sit far apart in embedding
 * space. Handing the model the whole batch at once is what lets it notice a pair
 * that no similarity gate would have put together.
 *
 * Runs on the `strong` tier: this is the contradiction-judgement class, the one
 * place where model capability measurably pays.
 *
 * Indices are validated against the batch size, so a hallucinated number is
 * dropped rather than mis-targeting a note (the Story 41 lesson).
 */
export async function llmConflictScan(contents: string[]): Promise<ConflictPair[]> {
  if (contents.length < 2) return []
  const numbered = contents.map((c, i) => `[${i}] ${c}`).join('\n')

  try {
    const raw = await llmCall(t.conflictScan(numbered), 600, 'strong')
    if (!raw) return []
    const cleaned = stripReasoning(raw)
    const match = cleaned.match(/\[[\s\S]*\]/)
    if (!match) return []
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []

    const pairs: ConflictPair[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const { a, b } = item as { a: unknown; b: unknown }
      if (typeof a !== 'number' || typeof b !== 'number') continue
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue
      // A hallucinated index must never reach a note. Bounds-check both.
      if (a < 0 || b < 0 || a >= contents.length || b >= contents.length) continue
      if (a === b) continue
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      if (seen.has(key)) continue
      seen.add(key)
      // Only accept a superseded marker that names one of THIS pair. Anything
      // else (a hallucinated index, a third note, a non-number) means "unknown",
      // which callers must treat as "do not retire".
      const rawSup = (item as { superseded?: unknown }).superseded
      const supersededIndex = rawSup === a || rawSup === b ? (rawSup as number) : null

      pairs.push({
        a,
        b,
        reason: typeof (item as { reason?: unknown }).reason === 'string' ? (item as { reason: string }).reason : '',
        supersededIndex,
      })
    }
    return pairs
  } catch (e) {
    console.error(`[amem] llmConflictScan failed: ${(e as Error).message}`)
    return []
  }
}

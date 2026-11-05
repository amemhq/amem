/**
 * Per-agent scope resolution (Story 32, Issue 1).
 *
 * The runtime per-session agentId is only present on each interface's ctx — it
 * does NOT exist on `api` at register time. These helpers turn a per-call ctx
 * plus the static plugin config into the concrete agentId and storage scope a
 * call should operate on.
 *
 * They are split out of index.ts and kept free of any runtime dependency on the
 * `amem` engine (the `amem` imports below are type-only, and buildScope takes
 * `createStorageContext` as an injected argument) so they can be unit-tested
 * without loading the heavy embedding / storage / LLM modules — the same reason
 * conv-access.ts lives on its own.
 */

import type { AmemPluginConfig, StorageContext } from '@amemhq/core'

/** Per-call context carrying the runtime per-session agent identity. */
export interface AgentCtx {
  agentId?: string
  sessionKey?: string
  /** Channel id for channel-originated runs, e.g. `discord`. */
  channel?: string
  messageProvider?: string
  /** Channel-scoped sender id. Absent for cron, heartbeat and CLI runs. */
  senderId?: string
  channelContext?: { sender?: { id?: string } }
  /** Tool ctx only: the channel of the current run. Tools get no `channel` or `senderId`. */
  messageChannel?: string
  /** Tool ctx only: the trusted sender id of the current run. */
  requesterSenderId?: string
}

/**
 * True when the session key is a group or room: `agent:<id>:<channel>:group:<id>` or
 * `...:channel:<id>`. OpenClaw's hook ctx has no group flag, so the key is the only signal. A group
 * routed into the main session (`session.groupScope: "main"`) is therefore not detected.
 */
export function isGroupSession(sessionKey?: string): boolean {
  if (!sessionKey) return false
  const parts = sessionKey.split(':').filter(Boolean)
  return parts.slice(3).some((p) => p === 'group' || p === 'channel')
}

/** OpenClaw's `session.identityLinks`: canonical identity name -> `<channel>:<peer id>` entries. */
export type IdentityLinks = Record<string, string[]>

/** Reads `session.identityLinks` out of the full OpenClaw config. Anything malformed is ignored. */
export function readIdentityLinks(config: unknown): IdentityLinks | undefined {
  const links = (config as { session?: { identityLinks?: unknown } } | undefined)?.session?.identityLinks
  return links && typeof links === 'object' ? (links as IdentityLinks) : undefined
}

/**
 * The canonical name of the person `<channel>:<id>` is linked to, or undefined. Same matching as
 * OpenClaw's own resolver (not exported for plugins, so copied): case-insensitive, entries are
 * trimmed, an entry may also be a bare peer id, the first match in config order wins.
 */
function linkedIdentity(links: IdentityLinks | undefined, channel: string, id: string): string | undefined {
  if (!links) return undefined
  const candidates = new Set([id.toLowerCase(), `${channel}:${id}`.toLowerCase()])
  for (const [canonical, entries] of Object.entries(links)) {
    const name = canonical.trim()
    if (!name || !Array.isArray(entries)) continue
    if (entries.some((e) => typeof e === 'string' && candidates.has(e.trim().toLowerCase()))) return name
  }
  return undefined
}

/**
 * The key a memory about one person is tagged with. Normally `<channel>:<senderId>`: the id is
 * only unique inside its channel, so the channel is part of the key. Display names are not used.
 * When the operator linked that account to an identity in `session.identityLinks`, the key is
 * `identity:<canonical name, trimmed, lowercased>` instead, so one person on two channels has one
 * key. Returns undefined when there is no identified single speaker: no channel or sender id
 * (cron, heartbeat, CLI), or a group chat, where only the last sender is known.
 */
export function resolveSpeakerKey(ctx: AgentCtx | undefined, links?: IdentityLinks): string | undefined {
  if (!ctx || isGroupSession(ctx.sessionKey)) return undefined
  // The hook ctx and the tool ctx name these fields differently; one of the two sets is present.
  const channel = (ctx.channel ?? ctx.messageProvider ?? ctx.messageChannel)?.trim().toLowerCase()
  const id = (ctx.channelContext?.sender?.id ?? ctx.senderId ?? ctx.requesterSenderId)?.trim()
  if (!channel || !id) return undefined
  const person = linkedIdentity(links, channel, id)
  return person ? `identity:${person.toLowerCase()}` : `${channel}:${id}`
}

/**
 * Whether a note may be shown to, or changed on behalf of, the speaker. With a speaker key: notes
 * about nobody, or about exactly that speaker. Without one: notes about nobody. A note that also
 * names someone else is never visible this way.
 */
export function visibleToSpeaker(subjects: string[] | undefined, speaker: string | undefined): boolean {
  const s = subjects ?? []
  if (s.length === 0) return true
  return speaker !== undefined && s.every((x) => x === speaker)
}

/** The resolved per-agent config + storage context for a single call. */
export interface AgentScope {
  agentId: string
  collection?: string
  storageCtx: StorageContext
}

/**
 * Parse the agentId out of a session key shaped `agent:<AGENTID>:<REST>`.
 * Returns undefined for any other shape (including too-few segments).
 */
export function parseAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined
  const parts = sessionKey.split(':').filter(Boolean)
  if (parts.length >= 3 && parts[0] === 'agent') return parts[1] || undefined
  return undefined
}

/**
 * An empty agentId is not a namespace. Refuse it rather than fall through to
 * another identity.
 */
function nonEmpty(agentId: string): string {
  if (agentId === '') {
    throw new Error('amem: agentId is empty; set a non-empty agentId in the plugin config or the host context')
  }
  return agentId
}

/**
 * Resolve the agentId for a call, in precedence order:
 *   ctx.agentId → parse(ctx.sessionKey) → pluginConfig.agentId → 'main'
 * Throws when the result is empty.
 */
export function resolveAgentId(ctx: AgentCtx | undefined, pluginConfig: AmemPluginConfig): string {
  return nonEmpty(ctx?.agentId ?? parseAgentIdFromSessionKey(ctx?.sessionKey) ?? pluginConfig.agentId ?? 'main')
}

/**
 * Build the per-agent scope (effective agentId, collection, storage context) for
 * a resolved agentId. `createStorageContext` is injected so this stays free of a
 * runtime `amem` dependency.
 *
 * Mode B (agent has its own dedicated collection) skips the shared-agent filter.
 * Throws when the effective agentId is empty.
 */
export function buildScope(
  rawAgentId: string,
  pluginConfig: AmemPluginConfig,
  createStorageContext: (collection?: string, modeBIsolated?: boolean) => StorageContext
): AgentScope {
  const agentCfg = pluginConfig.agents?.[rawAgentId] ?? {}
  const effectiveAgentId = nonEmpty(agentCfg.agentId ?? rawAgentId)
  const effectiveCollection = agentCfg.collection ?? pluginConfig.collection ?? undefined
  // Mode B: agent has its own dedicated collection → skip the shared-agent filter.
  const modeBIsolated = !!agentCfg.collection
  return {
    agentId: effectiveAgentId,
    collection: effectiveCollection,
    storageCtx: createStorageContext(effectiveCollection, modeBIsolated),
  }
}

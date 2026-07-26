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
 * Resolve the agentId for a call, in precedence order:
 *   ctx.agentId → parse(ctx.sessionKey) → pluginConfig.agentId → 'main'
 */
export function resolveAgentId(ctx: AgentCtx | undefined, pluginConfig: AmemPluginConfig): string {
  return ctx?.agentId ?? parseAgentIdFromSessionKey(ctx?.sessionKey) ?? pluginConfig.agentId ?? 'main'
}

/**
 * Build the per-agent scope (effective agentId, collection, storage context) for
 * a resolved agentId. `createStorageContext` is injected so this stays free of a
 * runtime `amem` dependency.
 *
 * Mode B (agent has its own dedicated collection) skips the shared-agent filter.
 */
export function buildScope(
  rawAgentId: string,
  pluginConfig: AmemPluginConfig,
  createStorageContext: (collection?: string, modeBIsolated?: boolean) => StorageContext
): AgentScope {
  const agentCfg = pluginConfig.agents?.[rawAgentId] ?? {}
  const effectiveAgentId = agentCfg.agentId ?? rawAgentId
  const effectiveCollection = agentCfg.collection ?? pluginConfig.collection ?? undefined
  // Mode B: agent has its own dedicated collection → skip the shared-agent filter.
  const modeBIsolated = !!agentCfg.collection
  return {
    agentId: effectiveAgentId,
    collection: effectiveCollection,
    storageCtx: createStorageContext(effectiveCollection, modeBIsolated),
  }
}

/**
 * The host's neutral memory reader (`providerRuntime`). Registering it makes amem a native
 * memory provider, and only a native provider gets a host-minted `memoryAudience` on the
 * agent_end ctx, which gates CRUD UPDATE. It reads exactly what manager.search returns:
 * active notes about nobody, for every caller.
 */
import { searchMemory, pingQdrant } from '@amemhq/core'
import type { AgentScope } from './scope.js'

interface CallerContext {
  assertCurrent(): void
  signal?: AbortSignal
}

export function createProviderRuntime(providerId: string, scopeFor: (agentId: string) => AgentScope) {
  return {
    async open({ agentId, context }: { agentId: string; context: CallerContext }) {
      const scope = scopeFor(agentId)
      // The host checks currency around each call too; this covers our own awaits.
      const check = () => {
        context.assertCurrent()
        context.signal?.throwIfAborted()
      }
      return {
        provider: {
          capabilities: { sources: ['memory'], pagination: false, candidates: [], projectFilter: false },
          async search(request: { query: string; maxResults?: number; minScore?: number }) {
            check()
            const results = await searchMemory(request.query, request.maxResults || 5, scope.agentId, {
              storageCtx: scope.storageCtx,
              worldOnly: true,
            })
            check()
            const minScore = request.minScore ?? 0
            return {
              hits: results
                .filter((r) => r.similarity >= minScore)
                .map((r) => ({
                  reference: { providerId, id: r.id },
                  excerpt: r.content,
                  score: r.similarity,
                  source: 'memory' as const,
                })),
              coverage: 'complete' as const,
            }
          },
          async get(request: { reference: { id: string } }) {
            check()
            const note = await scope.storageCtx.getNote(request.reference.id, scope.agentId)
            check()
            // Same notes as search: a retired note or one about someone reads as absent.
            if (!note || !note.is_active || (note.subjects ?? []).length > 0) return { status: 'not_found' as const }
            return { status: 'ok' as const, reference: { providerId, id: note.id }, text: note.content }
          },
          async health() {
            try {
              await pingQdrant()
              return { status: 'ready' as const }
            } catch {
              return { status: 'unavailable' as const, message: 'Qdrant is not reachable' }
            }
          },
          async close() {},
        },
      }
    },
  }
}

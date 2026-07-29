/**
 * auth.ts — write authorization for the Access Protocol (Story 33).
 *
 * Story 32 gave every note `owner` / `readers` / `writers` and enforced `readers`
 * at query time. It deliberately left `writers` unenforced. The consequence: the
 * agent filter matches `agent_id == caller OR agent_id == 'shared'`, so ANY query
 * can return another agent's shared note — and every mutation then wrote to it
 * unchecked. An audit found eight such write sites (dedup, link generation,
 * evolution ×2, CRUD update/delete, quality scan, link rewriting).
 *
 * This is the one rule they all gate on. Kept pure and dependency-free so the
 * policy is unit-testable on its own and identical everywhere it is applied.
 */
import type { MemoryNote } from './storage.js'

/**
 * The engine acting as itself, rather than on behalf of any agent.
 *
 * `getNote`, `updateNoteContent` and `invalidateNote` all used to take an
 * *optional* identity, and omitting it skipped the authorization check. That put
 * the safe behaviour behind remembering to ask for it, and made "no check here"
 * invisible — an absent argument looks the same as an oversight. The identity is
 * now required, and this is what a call declares when it genuinely has no agent
 * on whose behalf it acts.
 *
 * Two call sites use it, both inside storage.ts: the fetch that
 * `updateNoteContent` and `invalidateNote` perform in order to *evaluate* the
 * write policy. Gating that read on the policy it exists to check would be
 * circular. Everything else passes a real agent id — the audit that prompted this
 * found the identity was already in scope at every one of them.
 *
 * The prefix keeps it from colliding with any plausible agent id. It is not a
 * secret and does not need to be: amem is self-hosted, the operator owns every
 * memory in the store, and there is no privilege boundary here to defend. This
 * guards against a call site forgetting to pass an identity, not against a user.
 */
export const SYSTEM_ACTOR = '__amem_system__'

/**
 * May `callerAgentId` mutate `note`?
 *
 * True when the caller owns it, is listed in `writers`, or `writers` is open
 * (`'*'`). Everything else — notably another agent's shared note, which is
 * readable but not writable — is denied.
 */
export function canWrite(note: Pick<MemoryNote, 'owner' | 'writers'>, callerAgentId: string): boolean {
  return note.owner === callerAgentId || note.writers.includes(callerAgentId) || note.writers.includes('*')
}

/**
 * May `callerAgentId` read `note`? (Story 36 — the read half of the protocol.)
 *
 * True when the caller owns it, is listed in `readers`, or the note is public
 * (`readers` contains `'*'`, which is how a shared-scope write is stored).
 *
 * Queries already filter by `agent_id`, so list/search paths never surface an
 * unreadable note. This guards the one primitive that bypasses that filter —
 * `getNote(id)` fetches straight by UUID — and the link-neighbourhood walks that
 * use it: a shared note's `links[]` can name its owner's PRIVATE notes, so
 * following those links would otherwise read memory the caller may not see.
 */
export function canRead(note: Pick<MemoryNote, 'owner' | 'readers'>, callerAgentId: string): boolean {
  return note.owner === callerAgentId || note.readers.includes(callerAgentId) || note.readers.includes('*')
}

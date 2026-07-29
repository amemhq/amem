---
'@amemhq/core': major
'openclaw-amem': patch
---

Require an identity on `getNote`, `updateNoteContent` and `invalidateNote`.

All three took an *optional* caller id, and omitting it skipped the authorization
check entirely. That put the safe behaviour behind remembering to ask for it, and
made "no check here" invisible — an absent argument reads exactly like an
oversight. A ClawHub scan flagged the shape; tracing it found no reachable path
where an outside note id met an identity-less call, so it was a design weakness
rather than a vulnerability. It is also the wrong foundation to keep building on.

The id is now required. `SYSTEM_ACTOR` is what a call passes when it genuinely
acts as the engine rather than on behalf of an agent — two places, both the fetch
that `updateNoteContent` and `invalidateNote` perform in order to evaluate the
write policy, where gating the read on the policy it exists to check would be
circular. Every other call site already had a real agent id in scope and now
passes it.

**Breaking** for anyone calling these from `@amemhq/core` directly. The fix is to
pass the identity you already have, or `SYSTEM_ACTOR` if you genuinely have none —
and having to write that down is the point.

Also stops `amem-api` from ever exposing by-id access without deciding to. No
route calls these functions today, but that was an accident of what had been
built; a test now records it.

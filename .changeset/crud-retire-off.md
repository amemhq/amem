---
'@amemhq/core': patch
'openclaw-amem': patch
---

agent_end now rewrites a note only with authority from outside the model, and
retires none unless crudRetire is auto. UPDATE, and the 0.85 fold inside
addMemory (new `rewriteExisting` option), apply only when the host-minted
ctx.memoryAudience is owner-private and ctx.trigger is user or absent: the host
also mints owner-private for a heartbeat on the owner's main session. Other
turns, and turns without an audience, are add-only. The host mints the audience
only for a native memory provider, so the plugin now also registers a minimal
providerRuntime (search and get over notes about nobody, same as
manager.search). Gateway memory.search v1 errors for a native provider and needs
version: 2. Only the audience kind is read: the hook runs after the turn
released the audience, so assertMemoryAudienceCurrent throws there.

New `crudRetire` (off | auto, default off) governs DELETE and the retag path.
invalidateNote takes the retiring path and a reason and records retired_at,
retired_by and retire_reason; every engine caller passes them. New restoreNote,
listRetired and revertNote, exposed as `openclaw amem retired`, `restore` and
`revert` through registerCli and manifest cliCommands. restoreNote clears
pending_merge, which the nightly EVOLVE/EXPAND path leaves set, and records
restored_at; conflictSweep in auto mode marks a restored note but does not
retire it again.

llmCall takes an optional system message. All seven internal prompts send their
rules there and the conversation or note text as an escaped data block in the
user message. The escaping moved from format-memories.ts to core.

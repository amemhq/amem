---
'@amemhq/core': patch
'openclaw-amem': patch
---

Never read the whole collection for an empty agentId.

`listNotes()` and `countNotes()` added the agent filter only for a truthy
agentId, so `''` sent a scroll with no filter: no agent clause and no
`is_active` clause. `searchMemory('')` then BM25-ranked every note in the
collection, other agents' private and invalidated notes included, and
`consolidateMemories('')` merged other agents' private notes. The vector half
always filters. Both now filter whenever agentId is not `undefined`; only
`undefined` reads the whole collection.

The plugin passed `''` through, because `resolveAgentId()` uses `??`.
`resolveAgentId()` and `buildScope()` now throw on an empty agentId. An empty
`agentId` in the config fails registration. An empty `ctx.agentId` fails that
call rather than falling through to the session key, the config or `main`. The
manifest gets no `minLength`: OpenClaw treats a plugin config that fails its
schema as an invalid config and does not start the gateway at all.

An empty agentId that an earlier version wrote to the nightly owed file could
never settle, so it failed every night. The owed file now drops it on read.

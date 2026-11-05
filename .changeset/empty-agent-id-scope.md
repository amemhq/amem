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

The plugin passed `''` through: `resolveAgentId()` uses `??`, and the manifest
set no `minLength`. `resolveAgentId()` and `buildScope()` now throw on an empty
agentId, and `agentId` and `agents.*.agentId` get `minLength: 1`. An empty
`agentId` in the config fails registration. An empty `ctx.agentId` fails that
call rather than falling through to the session key, the config or `main`.

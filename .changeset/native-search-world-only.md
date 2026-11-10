---
'openclaw-amem': patch
---

`manager.search` of the memory capability now always searches with `worldOnly:
true` and returns the host's `MemorySearchResult` shape.

OpenClaw calls `getMemorySearchManager` with `{cfg, agentId, purpose?,
inspectSources?}` (2026.10.9 types) and never a session key, so the
`isGroupSession(params?.sessionKey)` check never fired and every caller searched
all subjects. There is no sender to scope by, and the host docs forbid deriving
an audience from the session-key format, so every call now reads only notes
without subjects.

Hits were `{id, memory, score, context, tags}`. The host reads `path` and
`snippet`, and memory-wiki's `path.basename(hit.path)` threw when
`search.corpus` was `memory` or `all`. Hits are now `{path: 'amem/<id>',
startLine: 1, endLine: 1, score, snippet, source: 'memory'}`. The scope change
and the shape fix ship in one commit: the shape fix alone would have started
delivering every subject's text to the host. `maxResults` is read before `limit`
and `topK`. `readFile` is still missing. The `providerRuntime` contract, whose
host-minted audience can tell the owner's direct chat apart, is left for later.

---
'@amemhq/core': patch
'openclaw-amem': patch
---

A search with no subject in a group session returns only notes with no subjects.

The speaker tagging let notes about one person coexist with notes about
nobody, but a group has no known speaker, so an unscoped search there returned
every person's tagged notes. `searchMemory` takes `worldOnly: true`, and
`queryByEmbedding` and `listNotes` take the scope `{ worldOnly: true }` in
place of a subject string. The filter is `is_empty` on `subjects` inside the
Qdrant query, so the vector search and the keyword scroll (BM25 and link
expansion) both honour it, in mode A and mode B. An explicit `subject` wins.
`subject` is now typed `SubjectScope`, a string or `{ worldOnly: true }`.

The plugin sets `worldOnly` when `isGroupSession(sessionKey)` is true, in the
`memory_search` tool, the memory capability's `manager.search` (from the
`sessionKey` the host passes to `getMemorySearchManager`) and the candidate
search in `agent_end`. Cron, heartbeat, CLI and direct chats are unchanged.
The group test is the same session-key check as for speaker tagging, so a group
routed into the main session (`session.groupScope: "main"`) is not detected.
Not access control: a model can still pass any subject. Notes tagged before
this version stay hidden from group searches.

---
'@amemhq/core': patch
'openclaw-amem': patch
---

The nightly merge and consolidation no longer lose the text they replace.

In `mergeSimilarNotes`, EVOLVE and EXPAND wrote `evolution_history` from a copy
read before `updateNoteContent`, which overwrote the `crud_update` entry holding
the neighbour's previous content. They now read the note back after the update
and append the `consolidate` entry to what is stored. If the read returns
nothing, the entry carries `oldContent` itself.

`consolidateMemories` wrote its `consolidate` entry without `oldContent` and
then replaced the whole point with `updateNote`. The entry now carries the keep
note's previous content.

The three `deleteNote` calls in `mergeSimilarNotes`, for the pending note after
EVOLVE or EXPAND and for the shorter note of a merged pair, are now
`invalidateNote(id, agentId)`, as consolidation already did. These notes stay in
the collection with `is_active: false`, one point per merge. `getNote` returns
retired notes, so links to them would have fed their text into write-time
evolution. Each merge now calls `replaceLinkReferences` as consolidation does.

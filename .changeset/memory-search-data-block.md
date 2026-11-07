---
'@amemhq/core': patch
'openclaw-amem': patch
---

`memory_search` returns notes inside a `<memories>` block that is labelled as
data.

Notes are text from earlier turns, so one can carry an instruction aimed at the
model that reads the result. The text now has the count, one sentence saying the
notes are saved data and must not be obeyed, then `<memories>` with one `<memory
id subjects created similarity via>` per note. `subjects` is left out when
empty; `via="link"` replaces the old ", linked — did not match" wording. Any
`<memories`, `</memories`, `<memory`, `</memory` in a note (any case, optional
space after `<` or `</`) gets its `<` written as `&lt;`; attribute values escape
`& < > "`. Other text is kept verbatim so Chinese stays readable. The hook
warning and "No relevant memories found." stay outside the block, and
`details.memories` is unchanged apart from the new field. The tool description
says the same thing in one sentence.

`SearchResult` gains `subjects`, copied from the note `searchMemory` already
holds, so amem-api's `/v1/memories/search` returns it too. This is a label, not
a filter: nothing is dropped at write time, and a model can still follow what it
reads. Any other consumer that parses the old "N. text (similarity 84%, id: x)"
lines breaks.

---
'@amemhq/core': patch
'openclaw-amem': patch
---

Tag auto-captured memories with the speaker and scope the capture search.

The package described memories as separate per person, but `agent_end` capture
never set `subjects`, so every captured note was visible to everyone. Its
candidate search was also unscoped: a turn with one person could update or
invalidate a note tagged for another.

With a speaker key (`<channel>:<sender id>`, from `ctx.channel` or
`ctx.messageProvider` and `ctx.channelContext.sender.id` or `ctx.senderId`),
capture now asks the CRUD model whether each fact is about the speaker or a
general fact. `llmCrudDecision` takes `{ speaker: true }` and returns
`aboutSpeaker` per operation, `true` when the answer is missing or invalid.
Speaker facts get `subjects: [key]`, the candidate search uses `subject: key`,
and `memory_search` defaults to it when the model passes no `subject`.
`aboutSpeaker` is set only when the speaker question was asked.

The candidate list for the CRUD model holds only notes with no subjects or
exactly `[key]`, and only no-subject notes when there is no key. UPDATE and
DELETE check the target again with the same rule. A failing UPDATE is stored
with `addMemory` (tagged if about the speaker), a failing DELETE is skipped. An
UPDATE about the speaker that hits an untagged note is stored as a tagged note
and the untagged note is invalidated.

If `session.identityLinks` in the OpenClaw config lists the sender, the key is
`identity:<name>` (trimmed, lowercased) instead of `<channel>:<id>`, so one
person on two channels has one key. The matching copies OpenClaw's resolver:
case-insensitive, entries trimmed, a bare id also matches. Read once at register
time.

`addMemory` now folds into or links to a note only when its subjects are
equal. Evolution and strengthening skip, and never back-link, a note with other
subjects. `mergeSimilarNotes`, `consolidateMemories` and `conflictSweep` pair
notes only with equal subjects, so captured notes about different people are
not merged back together. Tools receive `messageChannel` and `requesterSenderId`
instead of the hook fields, and `resolveSpeakerKey` reads both sets.

Group chats and rooms, found from the `:group:` and `:channel:` session key
segments because the hook ctx has no group flag, and runs with no sender (cron,
heartbeat, CLI) are not tagged. A group routed into the main session
(`session.groupScope: "main"`) has no group session key and is not detected.
Subjects are not access control: a model can name another key in `memory_search`
or `memory_add`, a search with no speaker sees every note, and the memory
capability's `manager.search` passes no subject. Existing notes stay untagged.
An untagged note replaced by an UPDATE judged about the speaker is lost to
other people.

---
'@amemhq/core': patch
'openclaw-amem': patch
---

Refuse a by-id write when the writers check cannot read the note.

`updateNoteContent()` and `invalidateNote()` read the note with
`getNote(id, SYSTEM_ACTOR)` and refused only if the note was found and the
caller was not a writer. `getNote()` turns every read error into `null`, so a
failed read skipped the check and the write went ahead for any caller. The
plugin's CRUD DELETE path calls `invalidateNote()` with no read before it.
ClawHub's review reproduced this with mocked storage and has rated the plugin
suspicious since 2.1.5. The check dates from Story 33.

Both writes now read the note through a fetch that does not catch. A failed
read throws, and the callers already treat a throw as a failure. A missing note
returns false, the same as a caller who is not a writer. `getNote()` itself
still returns `null` for a failed read, which is safe for a read.

A missing note used to make the vector write throw, which stopped whatever came
next. Now that it returns false, the callers check it. The nightly merge
deletes the pending or shorter note only after the merged text is written, so a
note that vanished between the scan and the write no longer takes the other
note with it. The add-time dedup inserts a new note instead of returning the id
of a note that is gone.

---
'@amemhq/core': minor
---

Rework `amem-migrate` into one command that works out its own next step, and make
a migration resumable.

The CLI had `--apply` and `--finalize` — two verbs wearing one command name, with
the destructive one reachable by adding a flag to a read-only invocation. It now
detects which phase the store is in and does the next safe thing: bare reports,
`--apply` advances, `--switch` performs the one irreversible step. The target
collection name is derived (`amem_notes` → `amem_notes_v2`) rather than asked for.

`migrateCollection` resumes. Ids survive the rebuild, so anything already in the
target is a point this migration wrote — that makes an interrupted run
distinguishable from somebody else's data, and finishing one costs only the notes
that were missed. A target holding anything the source does not is still refused.

`switchToMigrated` is new: it verifies the target holds at least as much as the
source, drops the source, and puts an alias in its place. That alias is the point
— after the first migration nobody has to change any configuration again, because
the name readers use stops being tied to a particular collection.

The CLI is written for someone who arrived from an error message rather than for
someone embedding the engine. Anyone using `@amemhq/core` directly gets both
functions exported and can sequence them however they like.

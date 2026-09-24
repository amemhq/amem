---
'@amemhq/core': patch
'openclaw-amem': patch
---

Keep the 02:30 job out of the way of the user's own runs.

The nightly job shares the gateway, the API key and the notes with the user's
agent. A task that ran at 02:30 competed with it for the model, and a merge
could delete or overwrite a note that the task had just written.

The plugin now tracks what the gateway does. A run counts from its lifecycle
`start` to its `end` or `error` on `api.runtime.events.onAgentEvent`, and its
other events keep it fresh. An event after the end does not count the run
again, because a memory flush and a model fallback both send one. A run that is
silent for 30 minutes stops counting. The plugin's own agent_end counts while it
writes, and so does a compaction, from `before_compaction` to
`after_compaction`. A channel message (`message_received`) counts as activity,
because a channel turn bound to an ACP session sends nothing else. An edited
message does not count: Telegram sends a live-location update as an edit about
every 40 s, and it starts no turn. The subscription starts in the service's
`start()`, because reading `api.runtime` throws when OpenClaw registers plugins
in its cli-metadata mode.

The job starts a step only when nothing is in flight and nothing has happened
for 60 s. A step is one agent's merge for one UTC day, the consolidation, or the
contradiction sweep. Inside the engine's `runInBackground`, `llmCall` throws
`BackgroundPreempted` before and after each call once anything has happened
since the step began. The consolidation's similarity loop yields to the event
loop after each row and stops the same way. The step then runs again from a
fresh read when the gateway is idle. It does not wait in place, because the
notes it read can be stale after the wait. A step that stops three times, or 60
minutes of waiting in one night, ends the night.

Progress is kept per agent. The owed file records, for each agent, its earliest
write not yet merged and its latest write. The earliest is taken before the
writes begin, because a note is dated when its write starts, and a write that
crosses UTC midnight must keep the earlier day. An agent is settled as soon as
all of its days are merged, so the next night goes on with the agents that a
stopped night did not reach. An agent with a day that failed stays owed, and
the next night reads that day again, until it is outside the 7-day window.

The contradiction sweep no longer marks a batch as scanned when the model gave
no usable answer. `llmConflictScan` returns null in that case, and also when
every entry in the answer fails the checks. The next run reads the batch again.
Before, one failed call meant that the sweep never read that batch again.

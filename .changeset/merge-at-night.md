---
'@amemhq/core': patch
'openclaw-amem': patch
---

Merge similar notes in the 02:30 job instead of after every turn.

mergeSimilarNotes ran inside agent_end, once per turn, for that turn's agent. It
held the one uncapped term in that hook, an evolution judgment for every
pending_merge note written that day, plus up to 10 merge checks. It also read
the agent's whole store with vectors on every turn and filtered by date in
memory. It now runs in the 02:30 job.

The nightly job has no session, so it cannot tell which agents wrote. The
plugin records each agent that writes, by raw agent id, in
`~/.openclaw/amem_nightly_owed.json`, and merges every one of them. The default
agent is always included. The record is a file because the gateway restarts
often. An agent that wrote before a restart and never after would otherwise be
missed. An agent that writes while the run is reading stays on the record for
the next night.

mergeSimilarNotes takes an optional UTC date. Note timestamps are UTC, and
02:30 local time falls partway through a UTC day, so a run covers every UTC day
from the day of the previous run to today, at most seven.

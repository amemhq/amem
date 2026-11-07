---
'openclaw-amem': patch
---

`memory_search` and `memory_add` check the model's `subject` / `subjects`
against the gateway identity.

The tool ctx falls into three cases. Direct chat (`resolveSpeakerKey` returns a
key): `memory_search` takes only the speaker key or no subject, `memory_add`
takes `subjects` that are empty or only the speaker key, normalised to the exact
key and deduped. The comparison is trimmed and case-insensitive; a blank
`subject` counts as omitted. Group (`isGroupSession`): any non-blank `subject`
or `subjects` is refused, and a call without them behaves as before (`worldOnly`
search, untagged add). No speaker (cron, heartbeat, CLI, no sender): unchanged,
the model's subjects are honoured. A refusal is a normal tool result with
`details.error`, not a throw, and the text names the speaker key so the model
can retry. Nothing is searched or saved on refusal. The descriptions state the
rule for the current case.

Still not general access control. `manager.search` is unchanged, so host tools
in a direct chat are unscoped. A group routed into the main session
(`session.groupScope: "main"`) is not detected as a group, so it gets the
direct-chat rule for the last sender. Runs with no sender can still name anyone.

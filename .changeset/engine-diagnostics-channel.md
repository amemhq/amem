---
'@amemhq/core': patch
'openclaw-amem': patch
---

Send engine warnings to the host logger instead of stderr.

The engine reported every recovered failure with `console.error` or
`console.warn`. Both write to stderr. The OpenClaw gateway runs under launchd
with `StandardErrorPath` set to `/dev/null`, so none of them arrived anywhere.

The gateway log on a real store shows what that costs. Over 11 days the
`agent_end` hook fired 684 times and wrote no memory at all, because
`AMEM_LLM_PROVIDER` was wrong and every LLM call failed. `llmCall` logged each
failure and the log kept none of them. Writes resumed when the provider was
fixed. In the log the 11 days look the same as 11 quiet days.

The lost lines are worse than a lost error. `llmConstructNote` returns an empty
structure when the call fails, and the note is still stored, with no keywords,
no tags and no context. `storage.ts` prints the notice that tells an operator
to migrate a legacy store, and the comment above it says that being told is the
only way the operator finds out.

`configure({ warn })` now takes the sink. The plugin passes `logger.warn`. The
default is still stderr, which is correct for `amem-migrate` and for any CLI
that uses the engine directly.

A unit test reads every engine module and fails on a new `console.error` or
`console.warn`. `cli-migrate.ts` is exempt because it writes to a terminal that
somebody is watching.

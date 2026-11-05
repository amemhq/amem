---
'@amemhq/core': patch
'openclaw-amem': patch
---

Write quality review batches only as new `amem-review-*.md` files in a
dedicated directory, and check `readers` on list and search results.

ClawHub's review of 2.1.8 showed that `memory_quality_scan` accepted any bare
file name and truncated an existing file, in a directory that defaulted to
`process.cwd()`. For a gateway that can be the agent workspace, so a
prompt-injected agent with the optional tool allowlisted could replace
`AGENTS.md`. The plugin tool now takes no file name. `generateReviewBatch()`
accepts only names matching `amem-review-<name>.md`, writes with the `wx` flag,
and defaults to `amem-reviews` in the data directory (`~/.openclaw/amem-reviews`
in the plugin). `AMEM_REVIEW_DIR` still overrides it, and is now read per call.

The same review noted that searches filter on `agent_id` and never call
`canRead()`. Every write keeps `readers` in step with `agent_id`, so nothing
leaked. List and search results in a mode A collection now also drop what
`canRead()` denies. A shared note with no `readers` field reads as readable by
everyone, matching what search already returned for it.

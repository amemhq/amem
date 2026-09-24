---
'@amemhq/core': patch
'openclaw-amem': patch
---

Stop agent_end at its budget instead of running past it.

The hook declares a 30 s budget. The host stops waiting at that point but does
not cancel the work, so a slow turn kept running and raced the next turn's hook
over the same notes. On one store, 172 of 6104 hooks ran past the budget.

agent_end now takes a deadline 2 s before the budget. Every LLM call inside it
gets the time left as its timeout, and no retries. Both SDKs retry twice by
default and retry a timeout too, so one slow call could run to about three times
the per-call timeout. A call is not started with less than 3 s left. Linking and
evolution stop early, so a note is stored with fewer links rather than not at
all. An operation that has not started when the time runs out is skipped. What
was already stored stays stored.

Calls without a deadline, for example in the nightly job, keep the client's
timeout and retries.

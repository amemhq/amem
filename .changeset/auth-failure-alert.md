---
'@amemhq/core': patch
'openclaw-amem': patch
---

Report an endpoint that refuses every call as unauthenticated as an error.

A failed LLM call is one warning, and warnings scroll by. On 2026-10-28 the
endpoint, a local proxy, lost its Claude login. Every call returned 401, and in
six days no note was stored. Nobody noticed.

After three calls in a row to the same endpoint and model fail authentication
or are denied, the engine now reports an error through a new
`configure({ error })` sink, which defaults to `console.error`. The plugin
routes it to the host's error level. While the problem lasts, the error repeats
at most once an hour. The first call that works logs a warning.

A failure counts if it is a 401 or 403, or if its message mentions
authentication. One relay wrapped its backend's 403 in a 500 that said "Failed
to authenticate", and the SDK's own error for a missing key says it too. Other
failures do not count and do not end a run. Runs are counted per endpoint and
model, because a relay can deny one model and serve another. The error says
what stops: turn capture for a fast-tier model, the nightly checks for a
strong-tier one. It names the endpoint by scheme and host only. With no base URL
set in amem, it names the SDK's own variable instead of reading it. It ends with
the last error, cut to 200 characters.

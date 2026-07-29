---
'@amemhq/core': patch
---

Pin that a Qdrant alias serves the underlying collection's config.

No behaviour change — a test only. amem reads both of its embedding guards out of
`GET /collections/{name}`: the vector width and the recorded model. Qdrant
documents that *queries* work identically through an alias and says nothing about
that endpoint, and if either field came back empty through one, both guards would
stop guarding silently rather than fail. Establishing it before building the
alias-based migration on top, and keeping the test so it stays true.

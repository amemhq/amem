---
---

Docs and CI only.

`RELEASE_NOTES.md` had no section for 2.1.0 or 2.1.1, so the ClawHub listing got
the fallback: the generated CHANGELOG, which describes `cosineSimilarity` and
`embSimMap` to someone deciding whether to install a plugin. Both written now.

The fallback is correct behaviour — npm has already published by the time the
mirror runs, so a missing note must not fail a release — but it means forgetting
one is invisible until you read the listing. `assert-release-note-present.mjs`
moves that failure onto the release PR, where the version is already bumped and
failing is still free. It runs in the `release-pr` job only, since on any other
branch there is no final version to look up.

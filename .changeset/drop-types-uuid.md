---
'@amemhq/core': patch
'openclaw-amem': patch
---

Drop `@types/uuid`.

It is a stub — npm deprecates it with "uuid provides its own type definitions, so
you do not need this installed", and `uuid@14` ships `dist/index.d.ts`. Both
packages carried it as a devDependency and `openclaw-amem` did not even import
`uuid`. Typecheck passes without it.

Renovate's dependency dashboard flagged it as deprecated with no replacement
available, which is correct: the replacement is nothing.

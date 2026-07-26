---
'@amemhq/core': major
'openclaw-amem': patch
---

Rename the engine to `@amemhq/core`. The plugin keeps its name.

`@heichaowo/amem-core` was a personal scope — it appears in other people's
package.json, which is the wrong signal for something meant to be used as neutral
infrastructure. The engine is now `@amemhq/core` and the service `@amemhq/api`.

Unscoped `amem` is not an option: npm's publish-time similarity guard rejects it
(E403, one edit from `amen`/`amemo`/`mem`), which is why the scope existed in the
first place. Zep and Letta hit the same problem and solved it the same way —
decorate the org (`@getzep`, `@letta-ai`) and scope the package.

`openclaw-amem` stays unscoped: that is the convention for OpenClaw plugins, and
it is the ClawHub package identity behind
`openclaw plugins install clawhub:openclaw-amem`.

`@heichaowo/amem-core` gets a deprecation notice pointing here. Nothing else
changes — the plugin bundles the engine, so plugin users are unaffected.

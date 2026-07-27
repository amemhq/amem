---
'@amemhq/core': patch
'openclaw-amem': patch
---

Bump `@anthropic-ai/sdk` to 0.112.5.

Routine: docs updates, a Bedrock `withOptions()` fix that does not apply here, and
a new refusal category in the API types. Recorded because the plugin bundles the
SDK, so the bump does reach users even though nothing about amem behaves
differently.

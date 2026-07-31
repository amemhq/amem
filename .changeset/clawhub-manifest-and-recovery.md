---
'openclaw-amem': patch
---

Drop the duplicated `openclaw` block from the plugin manifest.

ClawHub's validator flags it as `manifest-unknown-fields`: an unsupported
top-level field in `openclaw.plugin.json`. It held `compat` and `build`, both
byte-identical to what `package.json` already declares under its own `openclaw`
key, which is where the host reads them from. Nothing in this repo read the
manifest copy.

The check runs server-side only — it does not exist in `clawhub@0.23.1`, which is
both the pinned CLI and the latest published one, so this could not be reproduced
locally. Verified instead that the field is a strict duplicate and that the
current inspector still passes without it.

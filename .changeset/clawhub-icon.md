---
'openclaw-amem': patch
---

Give the plugin a catalog icon on ClawHub.

ClawHub reads `icon` from `openclaw.plugin.json` — any HTTPS image URL — and shows
it on the homepage and the plugin list. Ours has been the default placeholder since
the listing existed.

Serving a PNG from `amem.owo.lc` rather than the `logo.webp` already there:
checked what the 18 code-plugins with icons actually use, and every one is a PNG
or an SVG. None uses webp, so whether ClawHub's renderer handles it is untested,
and a silently-broken icon is exactly the kind of thing nobody notices. 256×256 is
108 KB, smaller than the webp it sits next to.

ClawHub reads the manifest at publish time, so this appears on the next release
rather than immediately.

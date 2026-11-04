---
'openclaw-amem': patch
---

Ship the plugin icon as `assets/icon.png` and drop the manifest `icon` field.

ClawHub and OpenClaw now take a plugin's icon only from `assets/icon.png` in
the package. A manifest `icon` URL is ignored, so the listing showed the
category glyph, and ClawHub's validator reports the field as
`manifest-unknown-fields` against OpenClaw 2026.10.9 and 2026.10.10. The PNG
is the docs logo at 512 by 512, 392 kB, under ClawHub's 512 KiB limit.
`assets/` is added to `files`.

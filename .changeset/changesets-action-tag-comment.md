---
---

No release — a comment in `release.yml`.

The `changesets/action` pin was annotated `# v1`, and that repo has no `v1` tag:
it publishes `v1.9.0`, `v1.8.0` and so on, with no moving major. Renovate reads
that comment to know what the SHA tracks, could not resolve it, and reported
"Could not determine new digest" instead of offering the update. Corrected to
`# v1.9.0`, which is what the pinned SHA actually is — the tag is annotated, and
dereferences to it.

`pnpm/action-setup # v6` is fine by contrast: that repo does publish a moving `v6`,
and it dereferences to the SHA pinned here.

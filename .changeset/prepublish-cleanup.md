---
'@amemhq/core': patch
'openclaw-amem': patch
---

Fix the exports map and the plugin's install command.

`@amemhq/core` had `types` as a flat sibling of `import`/`require` in its exports
map. TypeScript adds `types` to the condition set for every caller and takes the
first match, so a CJS consumer on `moduleResolution: node16` resolved the ESM
`index.d.ts` and got TS1479. tsup was already emitting `index.d.cts`; the map
just never pointed at it. Now nested per condition.

The plugin README's recommended install line read
`clawhub:@heichaowo/openclaw-amem`. ClawHub's identifier is the unscoped
`openclaw-amem`, so that command never worked.

`@types/uuid` moves to devDependencies — it is a deprecated stub (uuid ships its
own types) and every `npm i openclaw-amem` printed a deprecation warning for it.

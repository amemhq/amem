---
'@amemhq/api': patch
---

Loosen the engine dependency ahead of any publish.

`workspace:*` publishes as an exact version, not a range — packing the package
produced `"@amemhq/core": "1.0.0"`. That would pin consumers to a single engine
version and make every core patch require an api release before anyone could
get it. `workspace:^` packs as `^1.0.0`.

Also declares `publishConfig.access: public`, matching `@amemhq/core`. The
changesets config already passes `--access public`, so this only covers a
direct `npm publish`.

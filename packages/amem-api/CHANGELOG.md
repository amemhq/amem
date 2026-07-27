# @heichaowo/amem-api

## 0.1.6

### Patch Changes

- [#91](https://github.com/amemhq/amem/pull/91) [`3b505c4`](https://github.com/amemhq/amem/commit/3b505c4bca0a87b5700c9cb54f3241782255494d) Thanks [@heichaowo](https://github.com/heichaowo)! - Loosen the engine dependency ahead of any publish.

  `workspace:*` publishes as an exact version, not a range — packing the package
  produced `"@amemhq/core": "1.0.0"`. That would pin consumers to a single engine
  version and make every core patch require an api release before anyone could
  get it. `workspace:^` packs as `^1.0.0`.

  Also declares `publishConfig.access: public`, matching `@amemhq/core`. The
  changesets config already passes `--access public`, so this only covers a
  direct `npm publish`.

- Updated dependencies [[`31b6fff`](https://github.com/amemhq/amem/commit/31b6fff762aef85f8990626a7cb7d0f03833ead6), [`7578c7a`](https://github.com/amemhq/amem/commit/7578c7ae65f23b22b3c6d2bf07c230fcb204a9a2)]:
  - @amemhq/core@1.0.1

## 0.1.5

### Patch Changes

- Updated dependencies [[`d94ca7f`](https://github.com/amemhq/amem/commit/d94ca7ff7c99bfe782192b56240fcee860218f73), [`e968fcd`](https://github.com/amemhq/amem/commit/e968fcd176f1f321455b69cd93abbc542ae7a7d8)]:
  - @amemhq/core@1.0.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`858984f`](https://github.com/heichaowo/amem/commit/858984f5e28b22377be9be8ab8168320647af437), [`b7e3cb7`](https://github.com/heichaowo/amem/commit/b7e3cb7598df4e6a48dd8eda58ad6597d84163c3)]:
  - @heichaowo/amem-core@0.5.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`61f46a8`](https://github.com/heichaowo/amem/commit/61f46a85b0434157b35391d2d6ff6d934908534b), [`d903552`](https://github.com/heichaowo/amem/commit/d903552e9f6d8751c712c2383046b69c9c1ae75a), [`9b22d73`](https://github.com/heichaowo/amem/commit/9b22d73bed52feb12b40e60db807f58cd0e827fd), [`8da3791`](https://github.com/heichaowo/amem/commit/8da37918c2c7d9f23dfee727ad19cf1efee3c0c3), [`634d280`](https://github.com/heichaowo/amem/commit/634d2806399fea8b6ae5afbbf608d1caf37d2a07), [`f52a083`](https://github.com/heichaowo/amem/commit/f52a08318bdfdf3a61d0855209ad766da39e9a28), [`78f2190`](https://github.com/heichaowo/amem/commit/78f21904bc646c215a87427dfe2e845a637c5369), [`a7e34f7`](https://github.com/heichaowo/amem/commit/a7e34f7579ff07eca92494846ff7833dfbb70c1b), [`c4f3e91`](https://github.com/heichaowo/amem/commit/c4f3e91ac51f35c0c1e72781232c154b7ada7328)]:
  - @heichaowo/amem-core@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`d07f16c`](https://github.com/heichaowo/amem/commit/d07f16c8f5766902ff29890a60c25c7e0a359363), [`398a59c`](https://github.com/heichaowo/amem/commit/398a59c9d6a2a931aadfa0db2e60baef4b6453ce)]:
  - @heichaowo/amem-core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`f48a266`](https://github.com/heichaowo/amem/commit/f48a266f85ed5f346c2acd3534f64f02f9f83b6a)]:
  - amem@0.2.0

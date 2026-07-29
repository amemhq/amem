// openclaw.plugin.json's `version` must equal the plugin package.json's.
//
// changesets bumps package.json only; tools/sync-plugin-version.mjs copies it
// across, and that script runs as part of the root `version` script. Nothing
// asserted the result, so any path that bumps the version without going through
// that script — a hand edit, or changesets/action falling back to a bare
// `changeset version` when no `version:` input is given — ships a manifest
// declaring the wrong version. ClawHub reads the manifest, so the wrong number is
// the one users see.
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('packages/openclaw-amem/package.json', 'utf8'))
const manifest = JSON.parse(readFileSync('packages/openclaw-amem/openclaw.plugin.json', 'utf8'))

if (pkg.version !== manifest.version) {
  console.error(
    `openclaw.plugin.json is at ${manifest.version} but package.json is at ${pkg.version}.\n` +
      `Run \`pnpm run version\` rather than \`changeset version\` — the sync step is part of it.`
  )
  process.exit(1)
}
console.log(`✓ openclaw.plugin.json and package.json agree on ${pkg.version}`)

#!/usr/bin/env node
// The version openclaw-amem is about to publish must have a section in
// RELEASE_NOTES.md, because that is what ClawHub shows on the listing.
//
// The publish step falls back to the generated CHANGELOG when the section is
// missing — deliberately, since npm has already published by then and a missing
// note must not fail a release. The cost is that forgetting to write one is
// invisible until someone reads the listing and finds a paragraph about
// `cosineSimilarity` and `embSimMap`. It happened for 2.1.0.
//
// So the check belongs here, on the release PR, where the version is already
// bumped and failing is still free.
import { readFileSync } from 'fs'

const PKG = 'packages/openclaw-amem/package.json'
const NOTES = 'packages/openclaw-amem/RELEASE_NOTES.md'

const version = JSON.parse(readFileSync(PKG, 'utf8')).version
const notes = readFileSync(NOTES, 'utf8')

// Same extraction the publish step runs, so this passes exactly when that finds
// something — matching on the heading loosely here would let a release through
// that the workflow then falls back on.
const lines = notes.split('\n')
const start = lines.findIndex((l) => l === `## ${version}`)
const body =
  start === -1
    ? []
    : lines
        .slice(start + 1)
        .slice(
          0,
          lines.slice(start + 1).findIndex((l) => l.startsWith('## ')) === -1
            ? undefined
            : lines.slice(start + 1).findIndex((l) => l.startsWith('## '))
        )
        .filter((l) => l.trim())

if (!body.length) {
  console.error(
    `✗ ${NOTES} has no "## ${version}" section with any content.\n\n` +
      `  ClawHub shows this file, not the CHANGELOG. Without a section the publish\n` +
      `  step falls back to the generated changelog, which is written for whoever\n` +
      `  works on the engine — the listing ends up describing internals to someone\n` +
      `  deciding whether to install a plugin.\n\n` +
      `  Add a "## ${version}" section saying what changes for someone using it.`
  )
  process.exit(1)
}

console.log(`✓ ${NOTES} has a "## ${version}" section (${body.length} lines)`)

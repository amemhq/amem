---
'@heichaowo/amem-core': minor
'openclaw-amem': minor
---

Run the contradiction sweep nightly, and only re-read what changed (Story 43).

`conflictSweep` shipped exported and tested but nothing called it, so the safety
net for running the per-turn CRUD decision on the fast model was not actually
deployed. It now runs after the daily consolidation, in its own try/catch so
neither task can take the other down. `conflictSweep: false` turns it off.

It is on by default because a net that is off by default is not a net — and it
costs almost nothing, for two reasons. It runs on whatever tier is configured, so
an install with no `strong` model keeps using the fast one and does not silently
start spending more. And it only re-reads batches that gained a memory since the
last run: notes carry `conflict_scanned_at`, and a batch every note has already
been read in is skipped. On a 2,000-memory store the first night is roughly one
call per 25 memories and every night after that is one or two.

The tradeoff, stated rather than buried: each category is sorted newest-first, so
a new memory is compared against the batch it lands in — its category's most
recent — not against the entire history. A contradiction between two old memories
that never shared a batch is not found. Clearing `conflict_scanned_at`, or passing
`force`, does a full re-read.

Also removes a hint in the quality review batch telling the reader to use
`memory_quality_apply`. That tool has never existed, in any version.

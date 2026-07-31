#!/usr/bin/env node
/**
 * Audit every model listed in docs/reference/embedding-models.md against what
 * Transformers.js can actually run.
 *
 * The page used to list a model if an ONNX export existed. That is not the same
 * as usable, and the gap is invisible from the repo listing:
 *
 *   - A `Dense` module after pooling is a learned projection that a stock ONNX
 *     export leaves behind. You get the pre-projection vectors — a representation
 *     nobody benchmarked — at a width that looks plausible and never errors.
 *     `Conan-embedding-v1` projects 1024 → 1792, so its 76.67 C-MTEB score
 *     belongs to vectors amem cannot produce.
 *   - An architecture Transformers.js has no mapping for still loads, through a
 *     generic encoder fallback that its own log calls out as unsupported.
 *
 * Both are checkable without downloading a single weight, so there is no excuse
 * for finding out later. What this cannot check is whether the model then
 * produces good vectors; that needs a real load, and is tracked separately in
 * the page's `Verified` column.
 *
 * `modules.json` lives on the ORIGINAL model, not on the `onnx-community/…` or
 * `Xenova/…` conversion of it. Reading it off the conversion repo reports "no
 * Dense" for every conversion in the list, which is how `LaBSE` sat in a usable
 * table. The upstream is resolved through `cardData.base_model`.
 *
 *   node tools/audit-embedding-models.mjs          # table
 *   node tools/audit-embedding-models.mjs --json   # machine-readable
 */
import { readFileSync } from 'fs'

const DOC = 'docs/reference/embedding-models.md'

/**
 * Encoder architectures Transformers.js maps natively, read off the version this
 * repo depends on rather than hardcoded — the list grows, and a stale copy here
 * would report a false "fallback" on a model that became supported.
 */
async function nativeModelTypes() {
  const mod = await import('@huggingface/transformers/src/models/registry.js').catch(() => null)
  if (mod?.MODEL_MAPPING_NAMES_ENCODER_ONLY) return new Set(mod.MODEL_MAPPING_NAMES_ENCODER_ONLY.keys())
  // The package exports no subpath for its registry, so read the source it
  // ships. Reached through amem-core rather than the root: the root workspace
  // does not depend on transformers and pnpm does not hoist it.
  const path = new URL(
    '../packages/amem-core/node_modules/@huggingface/transformers/src/models/registry.js',
    import.meta.url
  )
  const src = readFileSync(path, 'utf8')
  const block = src.match(/MODEL_MAPPING_NAMES_ENCODER_ONLY\s*=\s*new Map\(\[([\s\S]*?)\]\);/)
  if (!block) throw new Error('could not locate MODEL_MAPPING_NAMES_ENCODER_ONLY in @huggingface/transformers')
  return new Set([...block[1].matchAll(/\[\s*['"]([a-z0-9_.-]+)['"]/g)].map((m) => m[1]))
}

async function hf(path) {
  const res = await fetch(`https://huggingface.co/${path}`)
  return res.ok ? res.text() : null
}

async function audit(repo, native) {
  const row = { repo }
  const metaRaw = await hf(`api/models/${repo}`)
  if (!metaRaw) return { ...row, error: 'repo unreachable' }
  const meta = JSON.parse(metaRaw)
  const files = (meta.siblings ?? []).map((f) => f.rfilename)
  row.onnx = files.some((f) => f.endsWith('.onnx'))
  if (!row.onnx) return row

  const cfgRaw = await hf(`${repo}/raw/main/config.json`)
  if (cfgRaw) {
    const cfg = JSON.parse(cfgRaw)
    row.modelType = cfg.model_type ?? null
    row.maxPos = cfg.max_position_embeddings ?? null
  }
  row.native = row.modelType ? native.has(row.modelType) : null

  let base = meta.cardData?.base_model ?? null
  if (Array.isArray(base)) base = base[0] ?? null
  row.baseModel = base

  for (const src of [repo, base].filter(Boolean)) {
    const raw = await hf(`${src}/raw/main/modules.json`)
    if (!raw) continue
    row.modules = JSON.parse(raw).map((m) => (m.type ?? '').split('.').pop())
    row.modulesFrom = src
    break
  }
  // Normalize is plain L2 and amem does its own; Dense is the disqualifying one.
  row.dense = row.modules ? row.modules.includes('Dense') : null
  if (row.dense && base) {
    const raw = await hf(`${row.modulesFrom}/raw/main/2_Dense/config.json`)
    if (raw) {
      const d = JSON.parse(raw)
      row.denseShape = `${d.in_features} → ${d.out_features}`
    }
  }
  return row
}

const doc = readFileSync(DOC, 'utf8')
const repos = [...new Set([...doc.matchAll(/`([\w.-]+\/[\w.-]+)`/g)].map((m) => m[1]))]
  .filter((r) => !r.includes('.json') && !r.includes('.md'))
  .sort()

const native = await nativeModelTypes()
const rows = []
for (const r of repos) rows.push(await audit(r, native))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ nativeCount: native.size, rows }, null, 2))
  process.exit(0)
}

const withOnnx = rows.filter((r) => r.onnx)
const dense = withOnnx.filter((r) => r.dense)
const fallback = withOnnx.filter((r) => r.native === false)
const unknown = withOnnx.filter((r) => r.modules === undefined)

console.log(`${rows.length} model ids in ${DOC}; ${withOnnx.length} have an ONNX export`)
console.log(`Transformers.js maps ${native.size} encoder architectures natively\n`)

console.log(`Dense head — the ONNX drops a learned projection (${dense.length})`)
for (const r of dense) {
  console.log(`  ${r.repo}`)
  console.log(`      ${r.modules.join(', ')}${r.denseShape ? `  (${r.denseShape})` : ''}  via ${r.modulesFrom}`)
}

console.log(`\nArchitecture not mapped — loads through the generic fallback (${fallback.length})`)
for (const r of fallback) console.log(`  ${r.repo.padEnd(52)} model_type=${r.modelType}`)

if (unknown.length) {
  console.log(`\nNo modules.json found upstream — Dense status unknown (${unknown.length})`)
  for (const r of unknown) console.log(`  ${r.repo.padEnd(52)} base_model=${r.baseModel ?? '(none declared)'}`)
}

const bad = dense.length + fallback.length
console.log(`\n${withOnnx.length - bad} of ${withOnnx.length} are clean on both checks.`)

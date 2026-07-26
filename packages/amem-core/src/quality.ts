/**
 * quality.ts — Memory quality scanning and review batch generation (Story 31)
 */

import * as fs from 'fs'
import * as path from 'path'
import { listNotes, patchNotePayload, type MemoryNote } from './storage.js'
import { canWrite } from './auth.js'
import type { PromptLocale } from './prompts.js'

const LOCALE: PromptLocale = (process.env.AMEM_PROMPT_LOCALE as PromptLocale) === 'zh' ? 'zh' : 'en'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LowQualityItem {
  note: MemoryNote
  reasons: LowQualityReason[]
}

export type LowQualityReason = 'too_short' | 'expired_ephemeral' | 'pending_conflict'

// ── scanLowQuality ────────────────────────────────────────────────────────────

export async function scanLowQuality(agentId: string): Promise<LowQualityItem[]> {
  const notes = await listNotes(agentId)
  const now = Date.now()
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  const results: LowQualityItem[] = []

  for (const note of notes) {
    // Story 33: listNotes also returns SHARED notes owned by other agents. Quality
    // enforcement marks notes low_quality, so scan only what this agent may write —
    // flagging a note we cannot act on would be noise, and patching it a violation.
    if (!canWrite(note, agentId)) continue

    const reasons: LowQualityReason[] = []

    if (note.content.trim().length < 10) {
      reasons.push('too_short')
    }

    if (note.ephemeral === true) {
      const createdAt = new Date(note.timestamp).getTime()
      if (now - createdAt > SEVEN_DAYS_MS) {
        reasons.push('expired_ephemeral')
      }
    }

    if (note.conflict === true) {
      reasons.push('pending_conflict')
    }

    if (reasons.length > 0) {
      if (!note.low_quality) {
        await patchNotePayload(note.id, { low_quality: true })
      }
      results.push({ note, reasons })
    }
  }

  return results
}

// ── generateReviewBatch ───────────────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = process.env.AMEM_REVIEW_DIR || process.cwd()

function nextBatchNumber(dir: string): number {
  let max = 0
  try {
    const files = fs.readdirSync(dir)
    for (const f of files) {
      const match = f.match(/^amem-review-batch(\d+)\.md$/)
      if (match) {
        const n = parseInt(match[1], 10)
        if (n > max) max = n
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return max + 1
}

function reasonLabel(r: LowQualityReason): string {
  if (LOCALE === 'zh') {
    switch (r) {
      case 'too_short':
        return '内容过短（<10字）'
      case 'expired_ephemeral':
        return '临时记忆已过期（>7天）'
      case 'pending_conflict':
        return '存在冲突标记'
    }
  }
  switch (r) {
    case 'too_short':
      return 'Content too short (<10 chars)'
    case 'expired_ephemeral':
      return 'Ephemeral memory expired (>7 days)'
    case 'pending_conflict':
      return 'Pending conflict flag'
  }
}

function severityBadge(reasons: LowQualityReason[]): string {
  if (reasons.includes('too_short')) return '🔴 LOW'
  if (reasons.includes('expired_ephemeral')) return '🟡 EXPIRED'
  return '🟠 CONFLICT'
}

export async function generateReviewBatch(agentId: string, outputPath?: string): Promise<string> {
  // outputPath is a bare filename, not a path. It arrives from the
  // memory_quality_scan tool, so a prompt-injected agent could otherwise hand
  // us an absolute path or a ../ traversal and overwrite any file the process
  // can write (CodeQL js/path-injection). path.basename() strips every
  // directory component, so the write can only ever land in the review root;
  // we reject anything that carried a directory part loudly rather than
  // silently rewriting it. Operators choose the root with AMEM_REVIEW_DIR.
  const root = path.resolve(DEFAULT_OUTPUT_DIR)
  let filePath: string
  let batchN: number
  if (outputPath) {
    const name = path.basename(outputPath)
    if (name !== outputPath || name === '' || name === '.' || name === '..') {
      throw new Error(`[quality] outputPath 必须是纯文件名（不含目录）: ${outputPath}`)
    }
    filePath = path.join(root, name)
    batchN = 0
  } else {
    batchN = nextBatchNumber(root)
    filePath = path.join(root, `amem-review-batch${batchN}.md`)
  }

  const items = await scanLowQuality(agentId)

  const now = new Date().toISOString().slice(0, 10)
  const lines: string[] = []

  const title = LOCALE === 'zh' ? 'A-MEM 质量审核' : 'A-MEM Quality Review'
  const genLabel = LOCALE === 'zh' ? '生成时间' : 'Generated'
  const countLabel = LOCALE === 'zh' ? `共 ${items.length} 条低质量条目` : `${items.length} low-quality item(s)`
  const applyHint =
    LOCALE === 'zh' ? '勾选后交给助手处理这些条目' : 'Tick your choices, then ask the assistant to act on them'

  lines.push(`# ${title} — Batch ${batchN || 'custom'}`)
  lines.push('')
  lines.push(`> ${genLabel}：${now} | ${countLabel}`)
  lines.push(`> ${applyHint}`)
  lines.push('')

  if (items.length === 0) {
    lines.push(LOCALE === 'zh' ? '✅ 没有发现低质量条目。' : '✅ No low-quality items found.')
  }

  // ── Story 43: conflicts render as ONE decision, not two entries ────────────
  // A contradiction involves a PAIR. Listing each note separately forces the
  // reviewer to find both, reconstruct that they belong together, then tick two
  // boxes — which is the single biggest source of review friction. Shown side by
  // side with timestamps, the reason, and a recommendation, it is one glance and
  // one tick. Each note still gets its own entry below for the apply tool.
  const byId = new Map(items.map((it) => [it.note.id, it.note]))
  const renderedPairs = new Set<string>()
  const pairLines: string[] = []
  for (const { note } of items) {
    for (const otherId of note.conflicts_with ?? []) {
      const other = byId.get(otherId)
      if (!other) continue
      const key = note.id < otherId ? `${note.id}:${otherId}` : `${otherId}:${note.id}`
      if (renderedPairs.has(key)) continue
      renderedPairs.add(key)

      // Newer first — the later statement is usually the current one.
      const [newer, older] = Date.parse(note.timestamp) >= Date.parse(other.timestamp) ? [note, other] : [other, note]
      const zh = LOCALE === 'zh'
      pairLines.push(`### 🟠 ${zh ? '冲突' : 'CONFLICT'} | ${newer.category || 'General'}`)
      if (newer.conflict_reason) {
        pairLines.push(`**${zh ? '判定理由' : 'Why'}：** ${newer.conflict_reason}`)
        pairLines.push('')
      }
      pairLines.push(`| | ${zh ? '时间' : 'When'} | ${zh ? '内容' : 'Content'} |`)
      pairLines.push('| :-- | :-- | :-- |')
      pairLines.push(`| **A** | ${newer.timestamp.slice(0, 10)} | ${newer.content.replace(/\n/g, ' ')} |`)
      pairLines.push(`| **B** | ${older.timestamp.slice(0, 10)} | ${older.content.replace(/\n/g, ' ')} |`)
      pairLines.push('')
      pairLines.push(`\`A: ${newer.id}\``)
      pairLines.push(`\`B: ${older.id}\``)
      pairLines.push('')
      pairLines.push(
        zh
          ? `- [ ] ✅ **A 是当前状态，停用 B**（推荐：A 更新）`
          : `- [ ] ✅ **A is current — retire B** (recommended: A is newer)`
      )
      pairLines.push(zh ? `- [ ] ↩️ B 是当前状态，停用 A` : `- [ ] ↩️ B is current — retire A`)
      pairLines.push(zh ? `- [ ] 🤝 两者都成立（误判）` : `- [ ] 🤝 Both hold — not a contradiction`)
      pairLines.push('')
      pairLines.push('---')
      pairLines.push('')
    }
  }
  if (pairLines.length > 0) {
    lines.push(LOCALE === 'zh' ? '## 冲突（成对，一个冲突一个决定）' : '## Conflicts (paired — one decision each)')
    lines.push('')
    lines.push(...pairLines)
    lines.push(LOCALE === 'zh' ? '## 其余条目' : '## Other items')
    lines.push('')
  }

  for (let i = 0; i < items.length; i++) {
    const { note, reasons } = items[i]
    const badge = severityBadge(reasons)
    const reasonStr = reasons.map(reasonLabel).join('、')

    const issueLabel = LOCALE === 'zh' ? '问题' : 'Issue'
    const contentLabel = LOCALE === 'zh' ? '内容' : 'Content'
    const kwLabel = LOCALE === 'zh' ? '关键词' : 'Keywords'
    const tagLabel = LOCALE === 'zh' ? '标签' : 'Tags'
    const keepLabel = LOCALE === 'zh' ? '保留' : 'Keep'
    const rewriteLabel = LOCALE === 'zh' ? '改写' : 'Rewrite'
    const deleteLabel = LOCALE === 'zh' ? '删除' : 'Delete'

    lines.push(`### [${i + 1}] ${badge} | ${note.category || 'General'}`)
    lines.push(`\`${note.id}\``)
    lines.push('')
    lines.push(`**${issueLabel}：** ${reasonStr}`)
    lines.push('')
    lines.push(`**${contentLabel}：**`)
    lines.push('```')
    lines.push(note.content)
    lines.push('```')
    lines.push('')
    lines.push(`**${kwLabel}：** ${note.keywords.join(', ')}`)
    lines.push(`**${tagLabel}：** ${note.tags.join(', ')}`)
    lines.push('')
    lines.push(`- [ ] ✅ ${keepLabel}`)
    lines.push(`- [ ] 🔧 ${rewriteLabel}`)
    lines.push(`- [ ] 🗑️ ${deleteLabel}`)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8')

  return filePath
}

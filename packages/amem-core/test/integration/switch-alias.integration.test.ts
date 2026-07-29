/**
 * The cutover: put the migrated collection behind the name readers use.
 *
 * This is the only step of a migration that cannot be undone — Qdrant will not
 * create an alias over a name a real collection holds, so freeing the name means
 * deleting the pre-migration store. Everything asserted here is about the checks
 * standing in front of that delete.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'

const DIM = 6

vi.mock('../../src/embedding.js', () => ({
  encode: async () => new Array(DIM).fill(1 / Math.sqrt(DIM)),
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  getEmbeddingDim: async () => DIM,
  getEmbeddingModel: () => 'test/switch-model',
  getEmbeddingPooling: () => 'mean',
}))

import { switchToMigrated } from '../../src/migrate.js'
import { createCollectionRaw, upsertPointsRaw, countPointsRaw, resolveAliasRaw } from '../../src/storage.js'

const QDRANT = 'http://localhost:6333'
const made: string[] = []
const aliases: string[] = []

const name = (tag: string) => {
  const n = `amem_sw_${process.pid}_${tag}`
  made.push(n)
  return n
}

async function seed(col: string, count: number): Promise<void> {
  await createCollectionRaw(col, DIM)
  await upsertPointsRaw(
    col,
    Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      vector: new Array(DIM).fill(0).map((_, k) => (k === i % DIM ? 1 : 0)),
      payload: { content: `note ${i}` },
    }))
  )
}

afterAll(async () => {
  for (const a of aliases) {
    await fetch(`${QDRANT}/collections/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ delete_alias: { alias_name: a } }] }),
    })
  }
  for (const c of made) await fetch(`${QDRANT}/collections/${c}`, { method: 'DELETE' })
})

describe('switchToMigrated (integration — requires Qdrant on :6333)', () => {
  it('drops the source and leaves its name resolving to the target', async () => {
    const from = name('ok_src')
    const to = name('ok_dst')
    aliases.push(from)
    await seed(from, 4)
    await seed(to, 4)

    const r = await switchToMigrated({ name: from, to, logger: { info: () => {}, warn: () => {} } })
    expect(r.moved).toBe(4)

    expect(await resolveAliasRaw(from)).toBe(to)
    // And the name still answers — which is the whole point, since that is what
    // every reader is configured with.
    expect(await countPointsRaw(from)).toBe(4)
  })

  it('refuses when the target holds less than the source', async () => {
    const from = name('short_src')
    const to = name('short_dst')
    await seed(from, 5)
    await seed(to, 2)

    await expect(switchToMigrated({ name: from, to, logger: { info: () => {}, warn: () => {} } })).rejects.toThrow(
      /not finished/i
    )
    // The source is still a real collection, not an alias, and still has its data.
    expect(await resolveAliasRaw(from)).toBeNull()
    expect(await countPointsRaw(from)).toBe(5)
  })

  it('refuses an empty target rather than deleting a full source', async () => {
    const from = name('empty_src')
    const to = name('empty_dst')
    await seed(from, 3)
    await createCollectionRaw(to, DIM)

    await expect(switchToMigrated({ name: from, to, logger: { info: () => {}, warn: () => {} } })).rejects.toThrow(
      /is empty/
    )
    expect(await countPointsRaw(from)).toBe(3)
  })

  it('is idempotent once switched', async () => {
    const from = name('idem_src')
    const to = name('idem_dst')
    aliases.push(from)
    await seed(from, 2)
    await seed(to, 2)

    await switchToMigrated({ name: from, to, logger: { info: () => {}, warn: () => {} } })
    // Running it again must not try to delete the alias as though it were the
    // old collection — a second --switch is the most likely way anyone re-runs it.
    const again = await switchToMigrated({ name: from, to, logger: { info: () => {}, warn: () => {} } })
    expect(again.moved).toBe(2)
    expect(await resolveAliasRaw(from)).toBe(to)
  })

  it('moves an existing alias to a newer collection without deleting anything', async () => {
    // The second migration and everything after: the name is already an alias,
    // so there is no real collection to free and the swap is atomic.
    const alias = name('chain_alias')
    const v2 = name('chain_v2')
    const v3 = name('chain_v3')
    aliases.push(alias)
    await seed(alias, 3)
    await seed(v2, 3)
    await switchToMigrated({ name: alias, to: v2, logger: { info: () => {}, warn: () => {} } })

    await seed(v3, 3)
    await switchToMigrated({ name: alias, to: v3, logger: { info: () => {}, warn: () => {} } })

    expect(await resolveAliasRaw(alias)).toBe(v3)
    // v2 survives — nothing was dropped this time round.
    expect(await countPointsRaw(v2)).toBe(3)
  })
})

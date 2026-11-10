import { describe, it, expect, vi, beforeEach } from 'vitest'

// The operator commands, against a fake store. Synthetic notes only.

const { revertNote, closeEmbedding } = vi.hoisted(() => ({ revertNote: vi.fn(), closeEmbedding: vi.fn() }))
vi.mock('@amemhq/core', async () => ({
  ...(await import('../../../amem-core/src/index.js')),
  revertNote,
  closeEmbedding,
}))

import { listRetiredCommand, restoreCommand, revertCommand, registerAmemCommands } from '../../src/cli.js'

const storageCtx = { getNote: vi.fn(), restoreNote: vi.fn(), listRetired: vi.fn() }
const scope = { agentId: 'main', storageCtx: storageCtx as never }

function io(answer?: boolean) {
  const lines: string[] = []
  return {
    lines,
    io: {
      write: (t: string) => lines.push(t),
      ...(answer !== undefined && { confirm: vi.fn(async () => answer) }),
    },
  }
}

const retired = {
  id: 'n1',
  content: 'a synthetic note',
  is_active: false,
  retired_at: '2026-11-10T00:00:00.000Z',
  retired_by: 'crud-delete',
  retire_reason: 'forget it',
  subjects: [],
  evolution_history: [],
}

beforeEach(() => {
  for (const f of [...Object.values(storageCtx), revertNote, closeEmbedding]) f.mockReset()
})

describe('openclaw amem retired', () => {
  it('lists id, time, path and text', async () => {
    storageCtx.listRetired.mockResolvedValue([retired])
    const { io: out, lines } = io()
    await listRetiredCommand(scope, { limit: '5' }, out)
    expect(storageCtx.listRetired).toHaveBeenCalledWith('main', 5)
    expect(lines).toEqual(['n1  2026-11-10T00:00:00.000Z  crud-delete  a synthetic note'])
  })

  it('does not pass control characters from note text to the terminal', async () => {
    storageCtx.listRetired.mockResolvedValue([{ ...retired, content: 'hi \x1b]0;pwned\x07 \x1b[2K\rFAKE \x9b31m' }])
    const { io: out, lines } = io()
    await listRetiredCommand(scope, {}, out)
    expect(lines[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)

    lines.length = 0
    await listRetiredCommand(scope, { json: true }, out)
    expect(JSON.parse(lines[0])[0].content).not.toMatch(/[\u0080-\u009f]/)
  })

  it('prints JSON', async () => {
    storageCtx.listRetired.mockResolvedValue([retired])
    const { io: out, lines } = io()
    await listRetiredCommand(scope, { json: true }, out)
    expect(JSON.parse(lines[0])[0]).toMatchObject({ id: 'n1', retired_by: 'crud-delete', retire_reason: 'forget it' })
  })

  it('rejects a bad --limit', async () => {
    await expect(listRetiredCommand(scope, { limit: '0' }, io().io)).rejects.toThrow('--limit')
  })
})

describe('openclaw amem restore', () => {
  it('restores after a yes', async () => {
    storageCtx.getNote.mockResolvedValue(retired)
    storageCtx.restoreNote.mockResolvedValue(true)
    const { io: out, lines } = io(true)
    await restoreCommand(scope, 'n1', {}, out)
    expect(storageCtx.restoreNote).toHaveBeenCalledWith('n1', 'main')
    expect(lines.at(-1)).toBe('Restored n1.')
  })

  it('changes nothing after a no', async () => {
    storageCtx.getNote.mockResolvedValue(retired)
    await restoreCommand(scope, 'n1', {}, io(false).io)
    expect(storageCtx.restoreNote).not.toHaveBeenCalled()
  })

  it('needs --yes without a terminal, and does not ask with it', async () => {
    storageCtx.getNote.mockResolvedValue(retired)
    storageCtx.restoreNote.mockResolvedValue(true)
    await expect(restoreCommand(scope, 'n1', {}, io().io)).rejects.toThrow('--yes')
    expect(storageCtx.restoreNote).not.toHaveBeenCalled()
    await restoreCommand(scope, 'n1', { yes: true }, io().io)
    expect(storageCtx.restoreNote).toHaveBeenCalledOnce()
  })

  it('leaves an active note alone, and reports a missing or unwritable one', async () => {
    storageCtx.getNote.mockResolvedValueOnce({ ...retired, is_active: true })
    const { io: out, lines } = io(true)
    await restoreCommand(scope, 'n1', {}, out)
    expect(lines).toEqual(['n1 is not retired.'])

    storageCtx.getNote.mockResolvedValueOnce(null)
    await expect(restoreCommand(scope, 'n1', { yes: true }, io().io)).rejects.toThrow('No memory n1')

    storageCtx.getNote.mockResolvedValueOnce(retired)
    storageCtx.restoreNote.mockResolvedValueOnce(false)
    await expect(restoreCommand(scope, 'n1', { yes: true }, io().io)).rejects.toThrow('may not write')
  })
})

describe('openclaw amem revert', () => {
  const rewritten = {
    ...retired,
    is_active: true,
    content: 'new text',
    evolution_history: [{ action: 'crud_update', oldContent: 'old text' }],
  }

  it('shows both texts and reverts after a yes', async () => {
    storageCtx.getNote.mockResolvedValue(rewritten)
    revertNote.mockResolvedValue({ status: 'ok', content: 'old text', replaced: 'new text' })
    const { io: out, lines } = io(true)
    await revertCommand(scope, 'n1', {}, out)
    expect(lines.slice(0, 2)).toEqual(['now:     new text', 'back to: old text'])
    expect(revertNote).toHaveBeenCalledWith('n1', 'main', storageCtx)
  })

  it('says so when there is nothing to go back to', async () => {
    storageCtx.getNote.mockResolvedValue({ ...rewritten, evolution_history: [] })
    const { io: out, lines } = io(true)
    await revertCommand(scope, 'n1', {}, out)
    expect(lines).toEqual(['n1 has no earlier text to go back to.'])
    expect(revertNote).not.toHaveBeenCalled()
  })

  it('reports a refused write', async () => {
    storageCtx.getNote.mockResolvedValue(rewritten)
    revertNote.mockResolvedValue({ status: 'denied' })
    await expect(revertCommand(scope, 'n1', { yes: true }, io().io)).rejects.toThrow('may not write')
  })
})

describe('registerAmemCommands', () => {
  it('adds the three subcommands, and every action closes the embedding worker', async () => {
    const actions: Record<string, (...a: unknown[]) => Promise<void>> = {}
    const command = (name: string): any => {
      const c: any = {
        command: (n: string) => command(n),
        description: () => c,
        option: () => c,
        action: (fn: (...a: unknown[]) => Promise<void>) => {
          actions[name] = fn
          return c
        },
      }
      return c
    }
    registerAmemCommands(command('openclaw'), () => scope)
    expect(Object.keys(actions).sort()).toEqual(['restore <id>', 'retired', 'revert <id>'])

    storageCtx.listRetired.mockRejectedValue(new Error('Qdrant is down'))
    await expect(actions['retired']({})).rejects.toThrow('Qdrant is down')
    expect(closeEmbedding).toHaveBeenCalledOnce()
  })
})

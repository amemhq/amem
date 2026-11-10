/**
 * `openclaw amem retired | restore <id> | revert <id>`: operator commands, never agent tools.
 * They run in the one-shot `openclaw` CLI process, not the gateway, so every action closes
 * the embedding worker it may have started; an open handle keeps that process alive.
 */
import { createInterface } from 'node:readline/promises'
import { revertNote, closeEmbedding, type MemoryNote, type StorageContext } from '@amemhq/core'
import type { AgentScope } from './scope.js'

/** The parts of a commander Command these commands use. */
export interface CliCommand {
  command(nameAndArgs: string): CliCommand
  description(text: string): CliCommand
  option(flags: string, description: string, defaultValue?: string): CliCommand
  action(fn: (...args: any[]) => unknown): CliCommand
}

export interface CliIo {
  write(text: string): void
  /** Resolves false when the answer is not yes. Absent when stdin or stdout is not a terminal. */
  confirm?: (question: string) => Promise<boolean>
}

// Note text comes from chats: a control character such as ESC would reach the operator's terminal.
const snippet = (text: string, max = 80) => {
  const flat = text.replace(/[\s\p{Cc}]+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// JSON.stringify escapes C0 controls but not C1, such as the one-byte CSI.
const noC1 = (text: string) => text.replace(/[\u0080-\u009f]/g, '')

async function readNote(storageCtx: StorageContext, id: string, agentId: string): Promise<MemoryNote> {
  const note = await storageCtx.getNote(id, agentId)
  if (!note) throw new Error(`No memory ${id} that agent ${agentId} can read.`)
  return note
}

/** Ask, or require --yes when there is no terminal to ask on. */
async function confirmed(io: CliIo, question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true
  if (!io.confirm) throw new Error('Not a terminal: pass --yes to confirm.')
  return io.confirm(question)
}

export async function listRetiredCommand(scope: AgentScope, opts: { limit?: string; json?: boolean }, io: CliIo) {
  const limit = Number(opts.limit ?? 20)
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.')
  const notes = await scope.storageCtx.listRetired(scope.agentId, limit)
  if (opts.json) {
    const rows = notes.map((n) => ({
      id: n.id,
      retired_at: n.retired_at || null,
      retired_by: n.retired_by || null,
      retire_reason: n.retire_reason ? noC1(n.retire_reason) : null,
      subjects: n.subjects,
      content: noC1(n.content),
    }))
    io.write(JSON.stringify(rows, null, 2))
    return
  }
  if (notes.length === 0) {
    io.write(`No retired memories for agent ${scope.agentId}.`)
    return
  }
  for (const n of notes) {
    io.write(`${n.id}  ${n.retired_at || '(before 2.1.11)'}  ${n.retired_by || '-'}  ${snippet(n.content)}`)
  }
}

export async function restoreCommand(scope: AgentScope, id: string, opts: { yes?: boolean }, io: CliIo) {
  const note = await readNote(scope.storageCtx, id, scope.agentId)
  if (note.is_active) {
    io.write(`${id} is not retired.`)
    return
  }
  io.write(`${id}  retired ${note.retired_at || 'before 2.1.11'} by ${note.retired_by || 'an unknown path'}`)
  if (note.retire_reason) io.write(`reason: ${snippet(note.retire_reason, 200)}`)
  io.write(`text: ${snippet(note.content, 200)}`)
  if (!(await confirmed(io, 'Restore this memory? [y/N] ', opts.yes))) {
    io.write('Nothing changed.')
    return
  }
  if (!(await scope.storageCtx.restoreNote(id, scope.agentId)))
    throw new Error(`Agent ${scope.agentId} may not write ${id}.`)
  io.write(`Restored ${id}.`)
}

export async function revertCommand(scope: AgentScope, id: string, opts: { yes?: boolean }, io: CliIo) {
  const note = await readNote(scope.storageCtx, id, scope.agentId)
  const previous = [...note.evolution_history].reverse().find((e) => e.oldContent)?.oldContent
  if (!previous) {
    io.write(`${id} has no earlier text to go back to.`)
    return
  }
  io.write(`now:     ${snippet(note.content, 200)}`)
  io.write(`back to: ${snippet(previous, 200)}`)
  if (!(await confirmed(io, 'Revert this memory? [y/N] ', opts.yes))) {
    io.write('Nothing changed.')
    return
  }
  const result = await revertNote(id, scope.agentId, scope.storageCtx)
  if (result.status === 'denied') throw new Error(`Agent ${scope.agentId} may not write ${id}.`)
  if (result.status !== 'ok') throw new Error(`Could not revert ${id}: ${result.status}.`)
  io.write(`Reverted ${id}. Run the same command again to undo.`)
}

function terminalIo(): CliIo {
  const io: CliIo = { write: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`) }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    io.confirm = async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim())
      } finally {
        rl.close()
      }
    }
  }
  return io
}

/** Adds `amem` and its subcommands to the program the host passes to registerCli. */
export function registerAmemCommands(program: CliCommand, scopeFor: (agentId?: string) => AgentScope) {
  const run =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      try {
        await fn(...args)
      } finally {
        await closeEmbedding()
      }
    }
  const amem = program.command('amem').description('Inspect and recover amem memories')
  amem
    .command('retired')
    .description('List recently retired memories')
    .option('--agent <id>', 'Agent whose memories to list')
    .option('--limit <n>', 'How many to show', '20')
    .option('--json', 'Print JSON')
    .action(
      run(async (opts: { agent?: string; limit?: string; json?: boolean }) =>
        listRetiredCommand(scopeFor(opts.agent), opts, terminalIo())
      )
    )
  amem
    .command('restore <id>')
    .description('Make a retired memory active again')
    .option('--agent <id>', 'Agent that owns the memory')
    .option('--yes', 'Do not ask for confirmation')
    .action(
      run(async (id: string, opts: { agent?: string; yes?: boolean }) =>
        restoreCommand(scopeFor(opts.agent), id, opts, terminalIo())
      )
    )
  amem
    .command('revert <id>')
    .description('Put back the text a memory had before its last rewrite')
    .option('--agent <id>', 'Agent that owns the memory')
    .option('--yes', 'Do not ask for confirmation')
    .action(
      run(async (id: string, opts: { agent?: string; yes?: boolean }) =>
        revertCommand(scopeFor(opts.agent), id, opts, terminalIo())
      )
    )
}

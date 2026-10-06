import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * KanbanView is persisted fence data: a declared field nobody reads is a dead
 * contract (review #19 left seven of them behind). Every field of the
 * KanbanView interface must be accessed (`view.<field>`) somewhere in the
 * client outside types.ts, so the next config knob ships wired or not at all.
 */
const TYPES_FILE = path.join('src', 'client', 'lib', 'markdown', 'kanban', 'types.ts')
const CLIENT_DIR = path.join('src', 'client')

function kanbanViewFieldNames(): string[] {
  const source = fs.readFileSync(TYPES_FILE, 'utf8')
  const block = /export interface KanbanView \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  return [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!)
}

function clientSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return clientSourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) && full !== TYPES_FILE ? [full] : []
  })
}

describe('kanban view fields', () => {
  it('every KanbanView field is read outside its declaration', () => {
    const sources = clientSourceFiles(CLIENT_DIR).map((f) => fs.readFileSync(f, 'utf8'))
    const dead = kanbanViewFieldNames().filter((field) => {
      const reader = new RegExp(`\\.${field}\\b`)
      return !sources.some((text) => reader.test(text))
    })
    expect(dead).toEqual([])
  })
})

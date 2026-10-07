import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const NOTE_LIST = readFileSync(resolve(ROOT, 'src/client/features/list/NoteList.tsx'), 'utf8')
const SIDEBAR = readFileSync(resolve(ROOT, 'src/client/features/sidebar/Sidebar.tsx'), 'utf8')
const QUICK_ACTIONS = readFileSync(resolve(ROOT, 'src/client/features/templates/quick-actions.tsx'), 'utf8')

function countLinesWhere(source: string, predicate: (line: string) => boolean): number {
  return source.split('\n').filter(predicate).length
}

function folderSectionBody(): string {
  const start = SIDEBAR.indexOf('export function FolderSection')
  expect(start, 'the folder section is no longer a named export of the sidebar').toBeGreaterThan(-1)
  const next = SIDEBAR.indexOf('\nexport ', start + 1)
  return SIDEBAR.slice(start, next === -1 ? SIDEBAR.length : next)
}

describe('the template quick actions are mounted where notes are created', () => {
  it('sits in both the desktop and the mobile library header', () => {
    expect(countLinesWhere(NOTE_LIST, (line) => line.includes('<TemplateQuickActions'))).toBe(2)
  })

  it('stays hidden in the views where creating a note makes no sense', () => {
    expect(countLinesWhere(NOTE_LIST, (line) => line.includes("view !== 'trash' && view !== 'archived' && <TemplateQuickActions")))
      .toBe(2)
  })

  it('sits in the sidebar folder header, next to the new-note button it mirrors', () => {
    const body = folderSectionBody()
    expect(body).toContain('<TemplateQuickActions')
    expect(body.indexOf('<TemplateQuickActions')).toBeLessThan(body.indexOf('createContextualNote()'))
  })

  it('creates through the template path and reads the library for the signed-in account', () => {
    expect(QUICK_ACTIONS).toContain('createNoteFromTemplate(template, folderId ? { folderId } : {})')
    expect(QUICK_ACTIONS).toContain('hydrate(owner)')
    expect(QUICK_ACTIONS).toContain("openPanel('templates')")
  })
})

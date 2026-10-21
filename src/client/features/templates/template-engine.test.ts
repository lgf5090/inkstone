import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoteWithEngine, insertNoteWithEngine, isTemplaterTemplate } from './template-engine'
import type { NoteTemplate } from '@shared/types'

/**
 * The route a library template takes, which is the difference between a rendered note and a note full of
 * literal `<% … %>` text.
 *
 * The engine half is mocked, and that is also the point of the third case below: the gallery reaches the
 * QuickJS worker only through a dynamic import, so a card press must not be what pulls a wasm binary into
 * the page.
 */
const shell = vi.hoisted(() => ({
  createNoteFromTemplate: vi.fn(),
  insertTemplateIntoActiveNote: vi.fn(),
}))

vi.mock('../templater/run-shell', () => shell)

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-1',
    name: 'Idea',
    description: '',
    content: '# Idea\n',
    categoryId: null,
    tags: [],
    builtin: false,
    isPinned: false,
    isStarred: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as NoteTemplate
}

beforeEach(() => {
  shell.createNoteFromTemplate.mockReset()
  shell.insertTemplateIntoActiveNote.mockReset()
})

describe('which engine a library template gets', () => {
  it('recognises a body the engine has to render', () => {
    expect(isTemplaterTemplate(template({ content: '<% tp.date.now() %>' }))).toBe(true)
    expect(isTemplaterTemplate(template({ content: '今天 <%+ tp.file.title %>' }))).toBe(true)
  })

  it('leaves an old `{{}}` body on the path that can render it', () => {
    expect(isTemplaterTemplate(template({ content: '# {{title}}\n{{date:YYYY-MM-DD}}' }))).toBe(false)
    expect(isTemplaterTemplate(template({ content: 'plain prose' }))).toBe(false)
  })

  it('hands the engine the folder it was given and no frozen title', async () => {
    shell.createNoteFromTemplate.mockResolvedValue(true)
    expect(await createNoteWithEngine(template(), 'folder-3')).toBe(true)
    expect(shell.createNoteFromTemplate).toHaveBeenCalledWith(template(), { folderId: 'folder-3', title: '' })
    // An empty title is not an oversight: the name is what the template's own commands say it is, which is
    // the picker's behaviour and upstream's for `create_new`.
  })

  it('routes the insert through the engine, which is the only path that queues caret groups', async () => {
    shell.insertTemplateIntoActiveNote.mockResolvedValue(true)
    expect(await insertNoteWithEngine(template())).toBe(true)
    expect(shell.insertTemplateIntoActiveNote).toHaveBeenCalledOnce()
  })

  it('passes a refusal through instead of turning it into a success', async () => {
    shell.createNoteFromTemplate.mockResolvedValue(false)
    expect(await createNoteWithEngine(template(), null)).toBe(false)
  })
})

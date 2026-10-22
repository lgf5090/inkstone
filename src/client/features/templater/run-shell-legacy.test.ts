/**
 * The same four doors, for the other syntax in the library.
 *
 * `run-shell.test.ts` proves the engine path; this file proves the branch in front of it — that a body written
 * with this app's older `{{…}}` placeholders is rendered by `@shared/note-template-render` and never reaches
 * the worker, while a body containing a command still does. The three stand-ins below are the three things a
 * reader would otherwise have to trust: the note that gets made, the body that gets written, and the assistant
 * request that survives the render.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Note, NoteTemplate } from '@shared/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveEditorView } from '../../editor/commands'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { registerLinkEditorNote } from '../links/store'
import {
  applyTemplateToCreatedNote,
  createNoteFromTemplate,
  insertTemplateIntoActiveNote,
  replaceActiveNoteWithTemplate,
} from './run-shell'

/** What each stand-in was asked to do, and the one answer it can be told to refuse with. */
const legacy = vi.hoisted(() => ({
  doorCalls: 0,
  created: [] as Array<{ name: string, options: Record<string, unknown> }>,
  writes: [] as Array<{ id: string, content: string }>,
  refusal: null as null | 'conflict' | 'not-found' | 'failed',
  fills: [] as Array<{ id: string, slots: unknown[] }>,
}))

vi.mock('../../lib/templater', () => ({
  templaterConfigured: () => true,
  installTemplaterHost: () => {
    legacy.doorCalls += 1
    return { page: {}, prompt: () => Promise.resolve({ ok: true, value: null }), web: () => Promise.resolve({ ok: true, value: null }), ports: { notes: {} } }
  },
  async renderTemplate() {
    legacy.doorCalls += 1
    return { ok: true as const, output: 'from the engine', durationMs: 1 }
  },
}))

vi.mock('../../lib/template-notes', () => ({
  async createNoteFromTemplate(template: NoteTemplate, options: Record<string, unknown>) {
    legacy.created.push({ name: template.name, options })
    return 'n-made'
  },
}))

vi.mock('../../lib/templater/host/store-port', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/templater/host/store-port')>()
  return {
    ...actual,
    storeWriteBody: async (id: string, content: string) => {
      legacy.writes.push({ id, content })
      if (actual !== null && legacy.refusal !== null) return { ok: false as const, reason: legacy.refusal }
      return { ok: true as const, note: { id, content } as Note }
    },
  }
})

vi.mock('../chat/template-fill', () => ({
  startTemplateSlotFill: (id: string, slots: unknown[]) => {
    legacy.fills.push({ id, slots })
  },
}))

const TARGET: Note = {
  id: 'n1', title: 'Target', content: 'what was there', excerpt: '', folderId: 'f-journal', tags: ['idea'],
  isPinned: false, isStarred: false, isArchived: false, wordCount: 2, charCount: 4, rev: 3, position: 0,
  createdAt: 1, updatedAt: 1, deletedAt: null,
} as Note

function template(content: string, name = 'Placeholder'): NoteTemplate {
  return {
    id: `tpl-${name}`, name, categoryId: null, description: '', content, tags: [],
    builtin: false, isPinned: false, isStarred: false, createdAt: 1, updatedAt: 1,
  } as NoteTemplate
}

/** The older syntax, with the three placeholders this app has always answered and a caret marker. */
const PLACEHOLDER_BODY = '# {{title}}\n\nin {{folder}} · {{tags}}\n\n{{cursor}}\n'
/** A body that quotes a command inside a fence: `detectEngine` calls it Templater, and it is the engine's. */
const ENGINE_BODY = 'A <% tp.file.cursor(1) %> B'

let view: EditorView | null = null

function mountEditor(doc: string): void {
  const host = document.createElement('div')
  document.body.append(host)
  const mounted = new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.range(0, 0) }), parent: host })
  setActiveEditorView(mounted)
  registerLinkEditorNote(mounted, TARGET.id)
  view = mounted
}

function toastTitles(): string[] {
  return useUi.getState().toasts.map((toast) => toast.title)
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  legacy.doorCalls = 0
  legacy.created = []
  legacy.writes = []
  legacy.fills = []
  legacy.refusal = null
  document.body.replaceChildren()
  view = null
  setActiveEditorView(null)
  useNotes.setState({
    notes: { [TARGET.id]: { ...TARGET } },
    contents: { [TARGET.id]: TARGET.content },
    folders: [{ id: 'f-journal', parentId: null, name: 'Journal', icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 }],
  })
  useUi.setState({ activeNoteId: TARGET.id, toasts: [], templateInsert: null })
})

afterEach(() => {
  view?.destroy()
  setActiveEditorView(null)
  document.body.replaceChildren()
})

describe('inserting a placeholder template', () => {
  it('renders it without ever reaching the door', async () => {
    mountEditor(TARGET.content)
    expect(await insertTemplateIntoActiveNote(template(PLACEHOLDER_BODY))).toBe(true)
    expect(legacy.doorCalls).toBe(0)
    const insert = useUi.getState().templateInsert
    expect(insert?.noteId).toBe(TARGET.id)
    expect(insert?.content).toBe('# Target\n\nin Journal · idea\n\n\n')
    expect(insert?.content).not.toContain('{{')
    expect(insert?.cursor).not.toBeNull()
    expect(toastTitles()).toContain(t('templates.inserted_into_note'))
  })

  it('still hands a body with a command to the engine', async () => {
    mountEditor(TARGET.content)
    await insertTemplateIntoActiveNote(template(ENGINE_BODY))
    expect(legacy.doorCalls).toBeGreaterThan(0)
    expect(useUi.getState().templateInsert).toBeNull()
  })
})

describe('replacing a note with a placeholder template', () => {
  it('writes the rendered body through the guarded write', async () => {
    mountEditor(TARGET.content)
    expect(await replaceActiveNoteWithTemplate(template(PLACEHOLDER_BODY))).toBe(true)
    expect(legacy.doorCalls).toBe(0)
    expect(legacy.writes).toEqual([{ id: TARGET.id, content: '# Target\n\nin Journal · idea\n\n\n' }])
    expect(toastTitles()).toContain(t('templater.replaced_note'))
  })

  it('says so in the reader’s language when the write is refused', async () => {
    mountEditor(TARGET.content)
    legacy.refusal = 'conflict'
    expect(await replaceActiveNoteWithTemplate(template(PLACEHOLDER_BODY))).toBe(false)
    expect(toastTitles()).toContain(t('templater.error.note_conflict'))
  })
})

describe('creating a note from a placeholder template', () => {
  it('goes through the path that places the caret and opens the note', async () => {
    expect(await createNoteFromTemplate(template(PLACEHOLDER_BODY), { folderId: 'f-journal', title: 'Today' })).toBe(true)
    expect(legacy.doorCalls).toBe(0)
    expect(legacy.created).toEqual([{ name: 'Placeholder', options: { folderId: 'f-journal', title: 'Today' } }])
  })

  it('leaves the folder out of the call when the reader chose none', async () => {
    await createNoteFromTemplate(template(PLACEHOLDER_BODY), { folderId: null, title: '' })
    expect(legacy.created[0]!.options).toEqual({ title: '' })
  })
})

describe('applying a placeholder template to a note that was just created', () => {
  it('writes the rendered body over the new note', async () => {
    const fresh = { ...TARGET, id: 'n-fresh', title: 'Entry', folderId: null, tags: [] } as Note
    expect(await applyTemplateToCreatedNote(template(PLACEHOLDER_BODY), fresh)).toBe(true)
    expect(legacy.doorCalls).toBe(0)
    expect(legacy.writes[0]).toEqual({ id: 'n-fresh', content: '# Entry\n\nin  · \n\n\n' })
    expect(toastTitles()).toContain(t('templater.applied_to_new_note'))
  })
})

describe('the assistant request inside a placeholder template', () => {
  it('is answered against the note that now holds the text', async () => {
    mountEditor(TARGET.content)
    await replaceActiveNoteWithTemplate(template('Intro\n\n{{ai: summarise this note}}\n'))
    expect(legacy.writes[0]!.content).toBe('Intro\n\n')
    expect(legacy.fills).toHaveLength(1)
    expect(legacy.fills[0]!.id).toBe(TARGET.id)
    expect(legacy.fills[0]!.slots).toEqual([{ at: 7, instruction: 'summarise this note' }])
  })
})

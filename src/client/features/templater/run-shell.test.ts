/**
 * The wiring, not the engine.
 *
 * `runTemplateOnNote` is the real one here, so a plan is measured, a cursor group is taken and a path is
 * validated exactly as the product does them; what is replaced is the door — the worker (a module worker
 * jsdom cannot spawn) and `store-port.ts` (a write path that belongs to IndexedDB and the route). Those two
 * stand-ins are what lets the four things this file is actually about be read out of a fake: the rows the
 * run was handed, the ports it was handed them through, and what the reader is told when a run refuses.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Folder, NoteTemplate, NoteSummary } from '@shared/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveEditorView } from '../../editor/commands'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { registerLinkEditorNote } from '../links/store'
import { createNoteFromTemplate, insertTemplateIntoActiveNote, renderDynamicCommand, renderTemplateBodyText, replaceActiveNoteWithTemplate } from './run-shell'

/** Everything the stand-in door records, and the answers it can be told to give. */
const engine = vi.hoisted(() => ({
  output: 'rendered',
  renderFailure: null as null | { code: string; detail: string },
  writeRefusal: null as null | 'conflict' | 'not-found' | 'failed',
  installs: 0,
  /** Whether the stand-in door reports itself configured; a run re-installs the host when it does not. */
  configured: true,
  /** What the shell handed each `installTemplaterHost` call, so the switches can be read back. */
  hostOptions: [] as Array<{ webRequestsEnabled?: () => boolean }>,
  renders: [] as { context: { mode: string; capabilities: string; selection: string; frozenTitle: string; target: unknown } }[],
  writes: [] as { id: string; content: string }[],
  creates: [] as { title: string; content: string; folderId: string | null }[],
  targets: [] as { runId: string; path: string }[],
  opened: [] as string[],
}))

vi.mock('../../lib/templater', () => ({
  templaterConfigured: () => engine.configured,
  installTemplaterHost: (options?: { webRequestsEnabled?: () => boolean }) => {
    engine.installs += 1
    engine.hostOptions.push(options ?? {})
    return {
      page: {
        async createTarget(context: { runId: string }, path: string) {
          engine.targets.push({ runId: context.runId, path })
          return { ok: true as const, title: path.split('/').pop()!.replace(/\.md$/i, ''), folderId: 'f-journal' }
        },
      },
      prompt: () => Promise.resolve({ ok: true, value: null }),
      web: () => Promise.resolve({ ok: true, value: null }),
      ports: {
        notes: {
          async write(id: string, content: string, expected: { rev: number }) {
            engine.writes.push({ id, content })
            if (engine.writeRefusal !== null) return { ok: false as const, reason: engine.writeRefusal }
            return { ok: true as const, note: { ...NOTE_SUMMARY, ...expected, content } }
          },
          async create(input: { title: string; content: string; folderId: string | null }) {
            engine.creates.push(input)
            return { ok: true as const, note: { ...NOTE_SUMMARY, id: 'n-new', title: input.title, folderId: input.folderId, content: input.content } }
          },
        },
        editor: {
          async open(id: string) {
            engine.opened.push(id)
            return true
          },
        },
      },
    }
  },
  async renderTemplate(args: { context: { mode: string; capabilities: string; selection: string; frozenTitle: string; target: unknown } }) {
    if (engine.renderFailure !== null) return { ok: false as const, ...engine.renderFailure }
    engine.renders.push({ context: args.context })
    return { ok: true as const, output: engine.output, durationMs: 1 }
  },
}))

const NOTE_SUMMARY: NoteSummary = {
  id: 'n1',
  title: 'Target',
  excerpt: '',
  folderId: null,
  tags: [],
  isPinned: false,
  isStarred: false,
  isArchived: false,
  wordCount: 1,
  charCount: 2,
  rev: 3,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}

const JOURNAL: Folder = {
  id: 'f-journal',
  parentId: null,
  name: 'Journal',
  icon: null,
  color: null,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
}

const TEMPLATE: NoteTemplate = {
  id: 'tpl-1',
  categoryId: null,
  name: 'Daily',
  description: 'A daily note',
  content: 'A <% tp.file.cursor(1) %> B',
  tags: [],
  builtin: false,
  isPinned: false,
  isStarred: false,
  createdAt: 1,
  updatedAt: 1,
}

/**
 * What a run answers with: one group of two `tp.file.cursor(1)` markers.
 *
 * `takeFirstCursorGroup` deletes both and reports where each leaves a caret, so the offsets below are the
 * marker's own length (23 characters) apart before the deletion and 1 apart after it.
 */
const RENDERED = 'X<% tp.file.cursor(1) %>Y<% tp.file.cursor(1) %>Z'

let view: EditorView | null = null

function mountEditor(doc: string, from: number, to = from): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  const mounted = new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.range(from, to) }),
    parent: host,
  })
  setActiveEditorView(mounted)
  registerLinkEditorNote(mounted, NOTE_SUMMARY.id)
  view = mounted
  return mounted
}

function toastTitles(): string[] {
  return useUi.getState().toasts.map((toast) => toast.title)
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  engine.output = RENDERED
  engine.renderFailure = null
  engine.writeRefusal = null
  engine.renders = []
  engine.writes = []
  engine.creates = []
  engine.targets = []
  engine.hostOptions = []
  engine.configured = true
  engine.opened = []
  document.body.replaceChildren()
  view = null
  setActiveEditorView(null)
  useNoteTemplates.setState({ templates: [TEMPLATE], categories: [], hydrated: true, owner: 'u1' })
  useNotes.setState({
    notes: { [NOTE_SUMMARY.id]: { ...NOTE_SUMMARY } },
    contents: { [NOTE_SUMMARY.id]: 'one two' },
    folders: [JOURNAL],
  })
  useUi.setState({ activeNoteId: NOTE_SUMMARY.id, toasts: [], templateInsert: null, panel: null, folderId: null })
})

afterEach(() => {
  view?.destroy()
  setActiveEditorView(null)
  document.body.replaceChildren()
})

describe('the door', () => {
  // First and only once: `run-shell.ts` keeps the installed host in a module binding, and nothing but a
  // fresh module could put it back, so this is the one case whose position in the file is load-bearing.
  it('is installed once, however many runs go through it', async () => {
    expect(engine.installs).toBe(0)
    mountEditor('one two', 0, 0)
    await insertTemplateIntoActiveNote(TEMPLATE)
    await createNoteFromTemplate(TEMPLATE, { folderId: null, title: 'Second' })
    expect(engine.installs).toBe(1)
  })

  it('hands the host the web switch as a reading, not as this moment\'s answer', async () => {
    mountEditor('one two', 0, 0)
    // Force a fresh install so this case sees the arguments of its own call rather than the first run's.
    engine.configured = false
    await insertTemplateIntoActiveNote(TEMPLATE)
    const options = engine.hostOptions.at(-1)!
    expect(typeof options.webRequestsEnabled).toBe('function')
    expect(options.webRequestsEnabled!()).toBe(false)
    const settings = useSession.getState().settings
    useSession.setState({
      settings: { ...settings, templater: { ...settings.templater, webRequestsEnabled: true } },
    })
    try {
      // The host lives for the whole session, so a reader who turns the switch on afterwards must not have
      // to reload the app for `tp.web.request` to start answering.
      expect(options.webRequestsEnabled!()).toBe(true)
    }
    finally {
      useSession.setState({ settings })
    }
  })
})

describe('inserting a template into the note on screen', () => {
  it('writes the rendered body over the selection and asks for that caret group', async () => {
    mountEditor('one two', 4, 7)
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(true)
    // 'one ' + the body with its markers taken out; both carets measured in the document the write made.
    expect(engine.writes).toEqual([{ id: 'n1', content: 'one XYZ' }])
    expect(useUi.getState().templateInsert).toEqual({ noteId: 'n1', content: '', cursor: [5, 6] })
    expect(toastTitles()).toEqual([t('templates.inserted_into_note')])
  })

  it('hands the run the body the editor holds and the text the reader selected', async () => {
    mountEditor('one two', 4, 7)
    await insertTemplateIntoActiveNote(TEMPLATE)
    const context = engine.renders[0]!.context
    expect(context.mode).toBe('append-active')
    expect(context.selection).toBe('two')
    expect((context.target as { content: string }).content).toBe('one two')
  })

  it('refuses without an editor, and never starts a run', async () => {
    mountEditor('one two', 4, 7)
    // The view is gone, which is what a preview-only layout or a closed pane leaves behind.
    view!.destroy()
    setActiveEditorView(null)
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(false)
    expect(engine.renders).toHaveLength(0)
    expect(engine.writes).toHaveLength(0)
    expect(useUi.getState().templateInsert).toBeNull()
    expect(toastTitles()).toEqual([t('command.no_editor_to_edit')])
  })

  it('refuses when no note is open at all', async () => {
    useUi.setState({ activeNoteId: null })
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(false)
    expect(engine.renders).toHaveLength(0)
    expect(toastTitles()).toEqual([t('templates.no_note_to_insert_into')])
  })

  it('refuses when the editor on screen belongs to another note', async () => {
    // The split case: `getActiveEditorView()` names the pane that mounted last, and a selection read from
    // it would be spliced into this note at those offsets.
    mountEditor('other pane', 0, 0)
    registerLinkEditorNote(view!, 'n-some-other-note')
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(false)
    expect(engine.renders).toHaveLength(0)
    expect(toastTitles()).toEqual([t('command.no_editor_to_edit')])
  })

  it('refuses a read-only editor rather than writing under it', async () => {
    // The one state this app does not ship today, and the one a run must still respect: a facet the
    // surface that embeds the editor can set, and the reader has no way to take the text back.
    const host = document.createElement('div')
    document.body.append(host)
    const mounted = new EditorView({
      state: EditorState.create({
        doc: 'one two',
        selection: EditorSelection.range(4, 7),
        extensions: [EditorState.readOnly.of(true)],
      }),
      parent: host,
    })
    setActiveEditorView(mounted)
    registerLinkEditorNote(mounted, NOTE_SUMMARY.id)
    view = mounted
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(false)
    expect(engine.renders).toHaveLength(0)
    expect(toastTitles()).toEqual([t('command.no_editor_to_edit')])
  })
})

describe('creating a note from a template', () => {
  it('files the note at the chosen folder and opens what it made', async () => {
    mountEditor('one two', 0, 0)
    expect(await createNoteFromTemplate(TEMPLATE, { folderId: JOURNAL.id, title: 'Today' })).toBe(true)
    expect(engine.targets).toHaveLength(1)
    expect(engine.targets[0]!.path).toBe('Journal/Today.md')
    expect(engine.creates).toEqual([{ title: 'Today', content: 'XYZ', folderId: 'f-journal' }])
    expect(engine.opened).toEqual(['n-new'])
    expect(engine.writes).toHaveLength(0)
    // The caret group travels with the note that was just opened, and an editor is what shows it.
    expect(useUi.getState().templateInsert).toEqual({ noteId: 'n-new', content: '', cursor: [1, 2] })
    expect(toastTitles()).toEqual([t('templates.created_note_from_template')])
  })

  it('names the new note after the template when the reader left the name empty', async () => {
    expect(await createNoteFromTemplate(TEMPLATE, { folderId: null, title: '' })).toBe(true)
    expect(engine.targets[0]!.path).toBe('Daily.md')
    expect(engine.renders[0]!.context.frozenTitle).toBe('Daily')
    expect(engine.creates[0]!.title).toBe('Daily')
  })

  it('files at the top level when the chosen folder is null, whatever the reader was browsing', async () => {
    useNotes.setState({ notes: { [NOTE_SUMMARY.id]: { ...NOTE_SUMMARY, folderId: JOURNAL.id } } })
    useUi.setState({ folderId: JOURNAL.id })
    await createNoteFromTemplate(TEMPLATE, { folderId: null, title: 'Root' })
    expect(engine.targets[0]!.path).toBe('Root.md')
  })

  it('refuses a title no path segment can hold, in the engine’s own words', async () => {
    expect(await createNoteFromTemplate(TEMPLATE, { folderId: null, title: '..' })).toBe(false)
    expect(engine.renders).toHaveLength(0)
    expect(engine.creates).toHaveLength(0)
    expect(toastTitles()).toEqual([t('templater.error.path_invalid')])
  })
})

describe('replacing the note on screen', () => {
  it('writes the whole document, with the note’s own properties gone', async () => {
    mountEditor('---\ntitle: Target\n---\nkeep me', 0, 0)
    expect(await replaceActiveNoteWithTemplate(TEMPLATE)).toBe(true)
    expect(engine.writes).toEqual([{ id: 'n1', content: 'XYZ' }])
    expect(toastTitles()).toEqual([t('templater.replaced_note')])
  })
})

describe('what a reader is told when a run does not do what was asked', () => {
  it('translates a parse failure rather than printing its token', async () => {
    mountEditor('one two', 0, 0)
    expect(await insertTemplateIntoActiveNote({ ...TEMPLATE, content: '<% print(1' })).toBe(false)
    expect(engine.writes).toHaveLength(0)
    expect(toastTitles()).toHaveLength(1)
    expect(toastTitles()[0], 'the sentence is the locale’s, and it stays a sentence').toContain(t('templater.error.parse_unclosed'))
    expect(toastTitles()[0]).not.toContain('parse-unclosed')
  })

  it('translates a capability the run did not have', async () => {
    mountEditor('one two', 0, 0)
    engine.renderFailure = { code: 'capability-blocked', detail: 'note.write' }
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(false)
    expect(toastTitles()[0]).toContain(t('templater.error.capability_blocked'))
    expect(toastTitles()[0]).not.toContain('capability-blocked')
    expect(engine.writes).toHaveLength(0)
  })

  it('tells a taken name apart from a note that moved', async () => {
    // Both refusals used to arrive as “the note changed while the template was writing it”, which sends the
    // reader to press again a command whose only problem is the name it chose.
    mountEditor('one two', 0, 0)
    engine.renderFailure = { code: 'name-taken', detail: 'Notes/Standup.md' }
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(false)
    expect(toastTitles()[0]).toContain(t('templater.error.name_taken'))
    expect(toastTitles()[0]).not.toContain(t('templater.error.note_conflict'))
    expect(toastTitles()[0]).not.toContain('name-taken')
  })

  it('leaves the reader’s own text alone when the note moved during the run', async () => {
    mountEditor('one two', 4, 7)
    engine.writeRefusal = 'conflict'
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(false)
    // The sentence, plus which note: `templaterErrorText` is the only way a code reaches a reader.
    expect(toastTitles()[0]).toContain(t('templater.error.note_conflict'))
    expect(toastTitles()[0]).not.toContain('note-conflict')
    expect(toastTitles()).toHaveLength(1)
    // Nothing is queued behind the refusal: no caret waiting to fire on the next mount, and the body the
    // store holds is still the one the reader typed.
    expect(useUi.getState().templateInsert).toBeNull()
    expect(useNotes.getState().contents[NOTE_SUMMARY.id]).toBe('one two')
  })

  it('shows what the plan warned about beside the write it still made', async () => {
    // A caret parked inside the properties block cannot be given to a template body, so the plan moves it
    // to the start of the body — and says so, because the caret it moved was the reader's.
    mountEditor('---\ntitle: T\n---\nbody', 5)
    expect(await insertTemplateIntoActiveNote(TEMPLATE)).toBe(true)
    expect(engine.writes).toEqual([{ id: 'n1', content: '---\ntitle: T\n---\nXYZbody' }])
    expect(useUi.getState().templateInsert).toEqual({ noteId: 'n1', content: '', cursor: [18, 19] })
    expect(toastTitles()).toEqual([t('templater.notice.insertion_clamped'), t('templates.inserted_into_note')])
  })
})

describe('rendering a body for a caller that owns the write', () => {
  it('answers with the document and the first caret, writing nothing and saying nothing', async () => {
    // QuickAdd's Template choice resolves its own title, folder, tags and link-back, so this door has to
    // give back exactly what a create run would have written — and stop there. No success line either:
    // the run's summary is the caller's sentence to say, and two would be one too many.
    const answer = await renderTemplateBodyText(TEMPLATE, null, 'Planned title')
    expect(answer).toEqual({ text: 'XYZ', cursor: 1 })
    expect(engine.writes).toEqual([])
    expect(engine.creates).toEqual([])
    expect(useUi.getState().toasts).toEqual([])
    const context = engine.renders.at(-1)!.context
    expect(context.mode).toBe('render-only')
    expect(context.capabilities, 'a QuickAdd run starts from the reader’s own library row').toBe('local')
    expect(context.frozenTitle, 'the note the text is going into does not exist yet').toBe('Planned title')
  })

  it('hands the run the note the text is going into, so its reads see what the reader typed', async () => {
    await renderTemplateBodyText(TEMPLATE, { ...NOTE_SUMMARY, content: 'typed and unsaved' } as never, 'Target')
    expect((engine.renders.at(-1)!.context.target as { content: string }).content).toBe('typed and unsaved')
  })

  it('says a refusal once, in the engine’s own words, and answers with nothing', async () => {
    engine.renderFailure = { code: 'capability-blocked', detail: 'note.write' }
    expect(await renderTemplateBodyText(TEMPLATE, null, 'Planned title')).toBeNull()
    expect(toastTitles()).toHaveLength(1)
    expect(toastTitles()[0]).toContain(t('templater.error.capability_blocked'))
  })
})

describe('one dynamic command from the preview', () => {
  it('answers with its text and writes nothing', async () => {
    const note = { ...NOTE_SUMMARY, content: 'Today is <%+ tp.date.now() %>.' } as never
    const answer = await renderDynamicCommand('<% tp.date.now() %>', note)
    expect(answer).toEqual({ ok: true, output: RENDERED })
    // Nothing was asked of the data layer, and nothing was said: the preview is where the answer goes, and
    // the pass that asked for it is the only one that can say where.
    expect(engine.writes).toEqual([])
    expect(engine.creates).toEqual([])
    expect(useUi.getState().toasts).toEqual([])
    const context = engine.renders.at(-1)!.context
    expect(context.mode).toBe('dynamic-processor')
    expect(context.capabilities).toBe('dynamic')
  })

  it('carries a failed command back as a sentence, not as a throw', async () => {
    engine.renderFailure = { code: 'render-failed', detail: 'nope is not defined' }
    expect(await renderDynamicCommand('<% nope() %>', null))
      .toEqual({ ok: false, error: `${t('templater.error.render_failed')} (nope is not defined)` })
  })
})

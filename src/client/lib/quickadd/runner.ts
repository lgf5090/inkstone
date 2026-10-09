/**
 * The app-backed side of a choice run: what a `NotePort` means when the notes are in the zustand
 * store and the editor is a CodeMirror view, plus the dispatcher that turns a choice id into a write.
 *
 * Two paths are deliberately different. A note that is on screen is written through the store, so the
 * editor, the autosave and the other tab hear about it; a note that is not open is patched through the
 * API with its revision, because a capture must not resurrect a stale editor buffer behind the
 * reader's back. A lost revision race is reported as a failed run rather than retried blind.
 */
import type { NotePort, NoteRef, QuickAddRunStatus } from './context'
import { findNoteByTitle, useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import type { ToastInput } from '../../store/ui'
import { useNoteTemplates } from '../../store/note-templates'
import { useQuickAdd } from '../../store/quickadd'
import { api } from '../../lib/api'
import { folderPath, folderPathLabel } from '../../lib/folders'
import { getActiveEditorView } from '../../editor/commands'
import { extractHeadings, frontMatterEnd, lineSlot } from './insertion'
import { planEditorAction } from './editor-actions'
import { parseFrontMatter, setFrontMatterValue } from '@shared/markdown-utils'
import { runTemplateChoice } from './template'
import { runCaptureChoice } from './capture'
import { runMacroChoice } from './macro'
import { t } from '../../lib/i18n'
import { runAppCommand } from '../../features/command/registry'
import type { RunOptions } from './session'
import type { QuickAddCaptureChoice, QuickAddChoice, QuickAddMacroChoice, QuickAddSettings, QuickAddTemplateChoice } from '@shared/quickadd'

function noteRef(id: string): NoteRef | null {
  const summary = useNotes.getState().notes[id]
  if (!summary || summary.deletedAt) return null
  return { id, title: summary.title, folderPath: folderPathOf(summary.folderId) }
}

function folderPathOf(folderId: string | null): string | null {
  if (!folderId) return null
  const trail = folderPath(useNotes.getState().folders, folderId)
  return trail.length > 0 ? trail.map((folder) => folder.name).join('/') : null
}

/** The line the caret is on, and the heading above it, in the note's current text. */
function headingPathAtCaret(): string | null {
  const view = getActiveEditorView()
  if (!view) return null
  const doc = view.state.doc
  const head = view.state.selection.main.head
  const line = doc.lineAt(head)
  const lines: string[] = []
  for (let number = 1; number <= doc.lines; number += 1) lines.push(doc.line(number).text)
  const headings = extractHeadings(lines)
  let chosen = null as null | { line: number; level: number; text: string }
  for (const heading of headings) {
    if (heading.line + 1 > line.number) break
    chosen = heading
  }
  if (!chosen) return null
  const chain: string[] = []
  let level = chosen.level
  for (const heading of headings) {
    if (heading.line > chosen.line || heading.level >= level) continue
    if (heading.level === level - 1) {
      chain.unshift(heading.text.trim())
      level = heading.level
    }
  }
  chain.push(chosen.text.trim())
  return `#${chain.join('#')}`
}

function editorSelection(): string {
  const view = getActiveEditorView()
  if (!view) return ''
  const { from, to } = view.state.selection.main
  return from === to ? '' : view.state.sliceDoc(from, to)
}

async function contentOf(id: string): Promise<string> {
  const ui = useUi.getState()
  const openHere = ui.activeNoteId === id || ui.workspaceSecondaryNoteId === id
  const cached = useNotes.getState().contents[id]
  // Only the editor holds the truth about a note it has open: unsaved keystrokes live in the store’s
  // content cache. For every other note that cache can be the text a previous run wrote *before* it
  // was saved, so the server is asked instead — and a capture that read the body it is about to
  // extend is the only comparison the write can honestly be guarded by.
  if (openHere && typeof cached === 'string') return cached
  try {
    const note = await api.notes.get(id)
    return note.content
  } catch {
    return typeof cached === 'string' ? cached : ''
  }
}

function currentCached(id: string): string | null {
  const state = useNotes.getState()
  return Object.prototype.hasOwnProperty.call(state.contents, id) ? state.contents[id] ?? '' : null
}

async function replaceContent(id: string, content: string, previous?: string): Promise<boolean> {
  const ui = useUi.getState()
  const openHere = ui.activeNoteId === id || ui.workspaceSecondaryNoteId === id
  if (openHere) {
    if (previous !== undefined && currentCached(id) !== null && currentCached(id) !== previous) return false
    useNotes.getState().editContent(id, content)
    await useNotes.getState().flush({ immediate: true })
    return currentCached(id) === content
  }
  // The summary’s own rev can lag the server right after a create, which the store answers with a
  // second revision of its own. Ask the server what the note is at now, and write against that.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fresh
    try {
      fresh = await api.notes.get(id)
    } catch {
      return false
    }
    if (previous !== undefined && fresh.content !== previous) return false
    try {
      await api.notes.patch(id, { content, rev: fresh.rev })
      await useNotes.getState().pull({ force: true })
      return true
    } catch {
      if (attempt === 1) return false
    }
  }
  return false
}

/** Walk a slash path, creating the folders it names. Null when the path cannot be built. */
async function ensureFolderPath(path: string | null): Promise<string | null> {
  if (!path) return null
  const store = useNotes.getState()
  let parentId: string | null = null
  for (const segment of path.split('/').filter((entry) => entry !== '')) {
    const existing = store.folders.find((folder) => folder.parentId === parentId && folder.name === segment)
    if (existing) {
      parentId = existing.id
      continue
    }
    const created = store.createFolder({ name: segment, parentId })
    if (!created) return null
    parentId = created
  }
  return parentId
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    useUi.getState().toast({ title: t('quickadd.copy_failed'), tone: 'warning' })
  })
}

export const notePort: NotePort = {
  activeNote() {
    const id = useUi.getState().activeNoteId
    return id ? noteRef(id) : null
  },
  findByTitle(title) {
    const found = findNoteByTitle(title)
    return found ? noteRef(found.id) : null
  },
  byId(id) {
    return noteRef(id)
  },
  async read(id) {
    return contentOf(id)
  },
  write(id, content, previous) {
    return replaceContent(id, content, previous)
  },
  async create(input) {
    const folderId = await ensureFolderPath(input.folderPath)
    const id = await useNotes.getState().createNote({
      title: input.title,
      content: input.content,
      folderId,
      tags: input.tags,
      cursor: input.cursor,
      open: false,
    })
    return id ? noteRef(id) : null
  },
  async ensureFolder(path) {
    return ensureFolderPath(path)
  },
  async open(id, options = {}) {
    const focus = options.focus !== false
    const pane = options.pane === 'other'
      ? (useUi.getState().activeWorkspacePane === 'primary' ? 'secondary' : 'primary')
      : undefined
    await useNotes.getState().openNote(id, {
      ...(pane ? { pane } : {}),
      activate: focus,
      revealOnMobile: focus,
    })
    if (!options.layout || options.layout === 'inherit') return
    // The layout belongs to whichever pane ended up holding the note: the active one when the run took
    // focus, the target one when it did not.
    const landed = pane ?? (focus ? useUi.getState().activeWorkspacePane : 'primary')
    useUi.getState().setWorkspacePaneLayout(landed, options.layout)
  },
  linkTo(target) {
    return `[[${target.title || 'Untitled'}]]`
  },
  cursorHeadingPath() {
    return headingPathAtCaret()
  },
  selection() {
    return editorSelection()
  },
  async clipboard() {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  },
  async templateBody(name) {
    const store = useNoteTemplates.getState()
    const wanted = name.trim().toLowerCase()
    const found = store.templates.find((template) => template.id === name || template.name.trim().toLowerCase() === wanted)
    return found ? found.content : null
  },
  templateNames() {
    return useNoteTemplates.getState().templates
      .map((template) => template.name.trim())
      .filter((name) => name !== '')
      .sort((a, b) => a.localeCompare(b))
  },
  templatesForPick(categoryId) {
    const store = useNoteTemplates.getState()
    const wanted = categoryId?.trim() ?? ''
    const names = new Map(store.categories.map((category) => [category.id, category.name]))
    return store.templates
      .filter((template) => template.name.trim() !== '')
      .filter((template) => wanted === '' || (template.categoryId ?? '') === wanted)
      .map((template) => ({
        id: template.id,
        name: template.name.trim(),
        category: template.categoryId ? names.get(template.categoryId) ?? null : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  },
  runAppCommand: (id) => runAppCommand(id).ok,
  async fieldValues(name, filter) {
    try {
      const response = await api.quickadd.fieldValues({
        name,
        folder: filter.folder ?? undefined,
        tag: filter.tag ?? undefined,
        excludeTag: filter.excludeTag ?? undefined,
      })
      return response.values
    } catch {
      return []
    }
  },
  async pickFileTitles(token) {
    const store = useNotes.getState()
    const wanted = token.folder.trim().toLowerCase()
    return Object.values(store.notes)
      .filter((note) => !note.deletedAt && note.title)
      .filter((note) => {
        const path = folderPathLabel(store.folders, note.folderId, '/')
        return wanted === '' || path.toLowerCase() === wanted || path.toLowerCase().startsWith(`${wanted}/`)
      })
      .map((note) => (token.mode === 'path'
        ? `${folderPathLabel(store.folders, note.folderId, '/')}/${note.title}`.replace(/^\//, '')
        : note.title))
      .slice(0, 200)
  },
  knownNotes() {
    const store = useNotes.getState()
    return Object.values(store.notes)
      .filter((note) => !note.deletedAt && note.title)
      .map((note) => {
        const path = folderPathLabel(store.folders, note.folderId, '/').replace(/^\//, '')
        return { id: note.id, title: note.title, folderPath: path === '' ? null : path, tags: note.tags ?? [] }
      })
      .slice(0, 500)
  },
  async notesWithProperty(name, value) {
    // The same scan the `{{FIELD:}}` suggestion runs: the schema has no property index, so the server
    // reads note text. Only the newest few hundred notes are looked at, which is the same window.
    const response = await api.quickadd.fieldNotes({ name, ...(value === null ? {} : { value }), limit: 200 })
    const store = useNotes.getState()
    return response.notes.map((entry) => ({ ...entry, folderPath: (folderPathLabel(store.folders, store.notes[entry.id]?.folderId ?? null, '/').replace(/^\//, '') || null) }))
  },
  knownFolderPaths() {
    const store = useNotes.getState()
    return store.folders
      .map((folder) => folderPathLabel(store.folders, folder.id, '/').replace(/^\//, ''))
      .sort((a, b) => a.localeCompare(b))
  },
  async appendLink(source, target, options = {}) {
    const link = options.embed ? `![[${target.title}]]` : `[[${target.title}]]`
    if (options.placement === 'lineEnd') return linkAtCaretLine(source, link)
    const body = await contentOf(source.id)
    if (options.placement === 'property') return linkIntoProperty(source, body, options.property ?? 'source', link)
    if (body.includes(link)) return true
    const next = `${body ? `${body.endsWith('\n') ? '' : '\n'}\n` : ''}${t('quickadd.link_line', { link })}\n`
    return replaceContent(source.id, `${body}${next}`, body)
  },
  copyText(text) {
    copyText(text)
  },
  placeCursor(offset) {
    const view = getActiveEditorView()
    if (!view) return
    const position = Math.max(0, Math.min(offset, view.state.doc.length))
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
    view.focus()
  },
  recordRun(id) {
    useQuickAdd.getState().recordRun(id)
  },
  notify(title, description, tone = 'default') {
    useUi.getState().toast({ title, description, tone: tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'default' })
  },
  activeEditorState() {
    const view = getActiveEditorView()
    if (!view || !view.dom.isConnected || view.dom.closest('[inert]')) return null
    const { from, to } = view.state.selection.main
    return { text: view.state.doc.toString(), from, to }
  },
  async applyEditorAction(action) {
    const view = getActiveEditorView()
    if (!view || !view.dom.isConnected || view.dom.closest('[inert]')) return 'no-editor'
    let clipboard: string | null = null
    if (action === 'paste') {
      // A browser hands the clipboard over only when it believes the gesture asked for it, so a
      // refusal is its own answer rather than an empty paste.
      try {
        clipboard = await navigator.clipboard?.readText() ?? null
      } catch {
        return 'clipboard-blocked'
      }
      if (clipboard === null) return 'clipboard-blocked'
    }
    const { from, to } = view.state.selection.main
    const plan = planEditorAction({ text: view.state.doc.toString(), from, to, action, clipboard })
    if (!plan) return 'no-target'
    view.dispatch(plan.replace
      ? { changes: plan.replace, selection: plan.selection, scrollIntoView: true }
      : { selection: plan.selection, scrollIntoView: true })
    if (plan.copied !== null) copyText(plan.copied)
    view.focus()
    return 'done'
  },
  insertAtCursor(text, cursor) {
    const view = getActiveEditorView()
    if (!view || !view.dom.isConnected || view.dom.closest('[inert]')) return false
    const { from, to } = view.state.selection.main
    const position = from + (cursor === null || cursor === undefined ? text.length : Math.max(0, Math.min(cursor, text.length)))
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: position }, scrollIntoView: true })
    view.focus()
    return true
  },
  insertRelativeToLine(text, side, cursor) {
    const view = getActiveEditorView()
    if (!view || !view.dom.isConnected || view.dom.closest('[inert]')) return false
    const slot = lineSlot(view.state.doc.toString(), view.state.selection.main.head, side, text, cursor ?? null)
    view.dispatch({ changes: { from: slot.at, insert: slot.insert }, selection: { anchor: slot.caret }, scrollIntoView: true })
    view.focus()
    return true
  },
  async prependToActive(text) {
    const id = useUi.getState().activeNoteId
    if (!id) return false
    const body = await contentOf(id)
    return replaceContent(id, prependInBody(body, text), body)
  },
  settings() {
    return useQuickAdd.getState().settings
  },
  choices() {
    return useQuickAdd.getState().choices
  },
}

/**
 * The link at the end of the line the caret was sitting on. This is the one placement that needs the
 * source note to be the note on screen: writing it through the store would drop whatever the reader has
 * typed there and not saved yet.
 */
function linkAtCaretLine(source: NoteRef, link: string): boolean {
  if (useUi.getState().activeNoteId !== source.id) return false
  const view = getActiveEditorView()
  if (!view || !view.dom.isConnected || view.dom.closest('[inert]')) return false
  // A caret parked in the note’s own properties block gets the same rule a capture on either
  // side of it has: the link joins the body below the block rather than splitting the YAML.
  const text = view.state.doc.toString()
  const line = view.state.doc.lineAt(Math.max(view.state.selection.main.head, frontMatterEnd(text)))
  if (line.text.includes(link)) return true
  const insert = line.text.trim() === '' ? link : ` ${link}`
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + insert.length },
    scrollIntoView: true,
  })
  return true
}

/**
 * The link added to a property of the source note. An existing scalar grows into a list rather than
 * being replaced, and an entry that is already there is not written twice.
 */
async function linkIntoProperty(source: NoteRef, body: string, property: string, link: string): Promise<boolean> {
  const parsed = parseFrontMatter(body)
  if (parsed.errors.length > 0) return false
  const own = Object.keys(parsed.data).find((key) => key.toLowerCase() === property.toLowerCase()) ?? property
  const current = parsed.data[own]
  const items = current === undefined || current === null || current === ''
    ? []
    : Array.isArray(current) ? current.map((entry) => String(entry)) : [String(current)]
  if (items.some((entry) => entry.trim() === link)) return true
  return replaceContent(source.id, setFrontMatterValue(body, own, [...items, link]), body)
}

function prependInBody(body: string, text: string): string {
  const opening = /^---[ \t]*\r?\n/.exec(body)
  if (!opening) return `${text}${body ? '\n' : ''}${body}`
  let close = body.indexOf('\n', opening[0].length)
  while (close !== -1 && !/^(?:---|\.\.\.)[ \t]*$/.test(body.slice(close + 1).split('\n')[0] ?? ''))
    close = body.indexOf('\n', close + 1)
  const head = close === -1 ? opening[0] : body.slice(0, close + 1)
  return `${head}${text ? `${text}\n` : ''}${body.slice(head.length)}`
}

/** Which choice an id names, looking inside groups as deep as the record allows. */
export function findChoiceById(choices: readonly QuickAddChoice[], id: string): QuickAddChoice | null {
  for (const choice of choices) {
    if (choice.id === id) return choice
    if (choice.type === 'group') {
      const child = choices.find((entry) => entry.parentId === choice.id && entry.id === id)
      if (child) return child
    }
  }
  return null
}

/**
 * What a finished run says about itself. Kept apart from the toast host so the four outcomes and the
 * two notice switches can be read, and tested, without a store or a screen in the way.
 */
export function runNotice(
  status: QuickAddRunStatus,
  choice: QuickAddChoice,
  settings: Pick<QuickAddSettings, 'notifications' | 'cancelNotice'>,
): { title: string; description?: string; tone?: ToastInput['tone'] } | null {
  switch (status.kind) {
    case 'written':
      return settings.notifications ? { title: status.summary } : null
    case 'empty':
      return settings.notifications ? { title: t('quickadd.ran_empty', { name: choice.name }) } : null
    case 'cancelled':
      // A cancel that carries a reason is a refusal the engine hit, and that always speaks up; a
      // plain closed dialog is the reader's own doing, so only the opt-in notice mentions it.
      if (status.reason) return { title: status.reason, tone: 'warning' }
      return settings.cancelNotice ? { title: t('quickadd.ran_cancelled', { name: choice.name }) } : null
    case 'failed':
      return {
        title: status.reason,
        description: t('quickadd.failed_hint', { name: choice.name }),
        tone: 'danger',
      }
  }
}

function describe(status: QuickAddRunStatus, choice: QuickAddChoice): void {
  const notice = runNotice(status, choice, useQuickAdd.getState().settings)
  if (notice) useUi.getState().toast(notice)
}

export async function runQuickAddChoice(
  id: string,
  options: RunOptions = {},
): Promise<QuickAddRunStatus> {
  const store = useQuickAdd.getState()
  const choice = findChoiceById(store.choices, id)
  if (!choice) return { kind: 'failed', reason: t('quickadd.error_choice_gone') }
  if (!choice.enabled || !store.settings.enabled)
    return { kind: 'failed', reason: t('quickadd.error_choice_disabled', { name: choice.name }) }
  if (choice.type === 'group') {
    store.toggleGroupCollapsed(choice.id)
    return { kind: 'cancelled' }
  }
  const status = await dispatch(choice, options)
  describe(status, choice)
  return status
}

async function dispatch(
  choice: QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMacroChoice,
  options: RunOptions,
): Promise<QuickAddRunStatus> {
  switch (choice.type) {
    case 'template':
      return runTemplateChoice(choice, notePort, options)
    case 'capture':
      return runCaptureChoice(choice, notePort, options)
    default:
      return runMacroChoice(choice as QuickAddMacroChoice, notePort, options)
  }
}

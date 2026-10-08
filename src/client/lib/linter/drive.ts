/**
 * The linter's door into the app: what a reader asks for, and what the note ends up looking like.
 *
 * The engine only ever returns a string. This works out who holds that string — an open editor, or
 * nothing but the store — turns the difference into an undoable edit, tells the reader what changed,
 * and runs the same thing over a folder or the whole library when asked. The rule library stays
 * behind `lintNote`, so a reader who never switches the linter on never loads it.
 */
import type { EditorView } from '@codemirror/view'
import type { Note } from '@shared/types'
import { api } from '../api'
import { confirm } from '../../components/overlay'
import { getActiveEditorView } from '../../editor/commands'
import { noteIdForView } from '../../features/links/store'
import { requestLintPreview } from '../../features/linter/LintPreview'
import { folderDescendantIds, folderPath } from '../folders'
import { getLocale, t } from '../i18n'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { lintNote, type LintOutcome } from './index'
import { getEditsBetween } from './engine/text-edits'
import { stampOf, toggleFolderIgnored, toggleNoteIgnored } from './ignore-state'
import { buildPreviewDiff } from './preview-rows'

/**
 * Notes per batch run. A body has to be read one at a time — `/api/search/documents` answers with a
 * truncated body, and writing that back would eat the note — so the run is capped at what a reader
 * will still watch finish.
 */
const LINTER_BATCH_MAX = 200

export type LintRun = {
  kind: 'applied' | 'unchanged' | 'ignored' | 'failed'
  rules: string[]
  error: string | null
  delta: number
}

/** The editor only counts as a holder of the note when it is the editor that note was opened in. */
function editorFor(noteId: string, preferred: EditorView | null): EditorView | null {
  if (preferred && noteIdForView(preferred) === noteId) {
    return preferred
  }
  const view = getActiveEditorView()

  return view && noteIdForView(view) === noteId ? view : null
}

async function textOf(noteId: string, view: EditorView | null): Promise<string | null> {
  if (view) {
    return view.state.doc.toString()
  }
  const cached = useNotes.getState().contents[noteId]
  if (cached !== undefined) {
    return cached
  }
  try {
    return (await api.notes.get(noteId)).content
  }
  catch {
    return null
  }
}

/**
 * Write the linted text back as the edits it actually is, not as a whole-document replace. The
 * reader's cursor, scroll position and undo stack all survive a run that changed two headings; a
 * replace from the first character to the last would send the cursor to the end of the note.
 */
function applyToEditor(view: EditorView, next: string): number {
  const before = view.state.doc.toString()
  if (before === next) {
    return 0
  }
  const changes = getEditsBetween(before, next)
    .map((edit) => ({ from: edit.startIndex, to: edit.endIndex, insert: edit.value }))
  if (!changes.length) {
    return 0
  }
  view.dispatch({ changes, userEvent: 'input.lint' })

  return next.length - before.length
}

function outcomeRun(outcome: LintOutcome, delta: number, text: string): LintRun {
  if (outcome.error) {
    return { kind: 'failed', rules: [], error: outcome.error, delta: 0 }
  }
  if (outcome.skipped) {
    return { kind: 'ignored', rules: [], error: null, delta: 0 }
  }
  if (outcome.text === text) {
    return { kind: 'unchanged', rules: outcome.changedRules, error: null, delta: 0 }
  }

  return { kind: 'applied', rules: outcome.changedRules, error: null, delta }
}

/**
 * Put a formatted body on a note the editor is not holding. A note the app has open saves through
 * the store, which owns its revision and its offline queue; a note nobody opened is patched against
 * the revision the server just reported, and a body that changed while the rules were running is
 * left alone rather than written over.
 */
async function writeNoteBody(noteId: string, text: string, previous: string): Promise<boolean> {
  const ui = useUi.getState()
  const notes = useNotes.getState()
  if ((ui.activeNoteId === noteId || ui.workspaceSecondaryNoteId === noteId) && notes.contents[noteId] === previous) {
    notes.editContent(noteId, text)
    await notes.flush({ immediate: true })
    return useNotes.getState().contents[noteId] === text
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let fresh: Note
    try {
      fresh = await api.notes.get(noteId)
    }
    catch {
      return false
    }
    if (fresh.content !== previous) {
      return false
    }
    try {
      await api.notes.patch(noteId, { content: text, rev: fresh.rev })
      return true
    }
    catch {
      if (attempt === 1) return false
    }
  }

  return false
}

/** Lint one note wherever it lives, and write the answer back where it was read from. */
export async function lintOneNote(noteId: string, preferred: EditorView | null = null): Promise<LintRun> {
  const stamp = stampOf(noteId)
  const view = editorFor(noteId, preferred)
  const text = await textOf(noteId, view)
  if (!stamp || text === null) {
    return { kind: 'failed', rules: [], error: t('linter.error.note_unavailable'), delta: 0 }
  }
  const settings = useSession.getState().settings.linter
  const outcome = await lintNote({ ...stamp, text, settings, locale: appLocale() })
  if (outcome.error || outcome.skipped || outcome.text === text) {
    return outcomeRun(outcome, 0, text)
  }
  if (view) {
    return outcomeRun(outcome, applyToEditor(view, outcome.text), text)
  }
  if (!(await writeNoteBody(noteId, outcome.text, text))) {
    return { kind: 'failed', rules: outcome.changedRules, error: t('linter.error.write_failed'), delta: 0 }
  }

  return outcomeRun(outcome, outcome.text.length - text.length, text)
}

/**
 * The locale a run writes dates in: the reader's own choice when they made one, since a note full of
 * English month names should not be rewritten into another language's date style just because the
 * interface was switched on another device.
 */
function appLocale(): string {
  const override = useSession.getState().settings.linter.localeOverride

  return override || getLocale()
}

/** Rule aliases, as the names a reader gave them. */
async function namesOf(aliases: string[]): Promise<string> {
  if (!aliases.length) {
    return ''
  }
  const { rules } = await import('./registry')
  const byAlias = new Map(rules.map((rule) => [rule.alias, rule]))

  return aliases.map((alias) => byAlias.get(alias)?.getName() ?? alias).join(', ')
}

function announce(run: LintRun, quietWhenUnchanged: boolean): void {
  const linter = useSession.getState().settings.linter
  const toast = useUi.getState().toast
  if (run.kind === 'ignored') {
    if (!quietWhenUnchanged) toast({ title: t('linter.toast.ignored'), tone: 'warning' })
    return
  }
  if (run.kind === 'failed') {
    toast({ title: t('linter.toast.failed', { error: run.error ?? t('linter.logs.unknown_error') }), tone: 'danger' })
    return
  }
  if (!linter.reportChanges) {
    return
  }
  if (run.kind === 'unchanged') {
    if (!quietWhenUnchanged) toast({ title: t('linter.toast.no_change') })
    return
  }
  void namesOf(run.rules).then((names) => {
    useUi.getState().toast({ title: t('linter.toast.changed', { rules: names }) })
  })
}

/** The command: format the note the reader is looking at. */
export async function lintCurrentNote(): Promise<void> {
  const noteId = activeNoteId()
  if (!noteId) return
  await lintAndReport(noteId, false)
}

/** Format one note and say what came of it. This is what every entry point ends up calling. */
export async function lintAndReport(noteId: string, quietWhenUnchanged: boolean, preferred: EditorView | null = null): Promise<void> {
  announce(await lintOneNote(noteId, preferred), quietWhenUnchanged)
}

function activeNoteId(): string | null {
  const view = getActiveEditorView()

  return (view ? noteIdForView(view) : null) ?? useUi.getState().activeNoteId
}

/**
 * The command: run everything, show what it would do, and only write if the reader says so. The
 * preview costs one run over the text and no edit, which is what makes it safe to offer on a note
 * that is being written in another window.
 */
export async function previewCurrentNote(): Promise<void> {
  const noteId = activeNoteId()
  const stamp = noteId ? stampOf(noteId) : null
  if (!noteId || !stamp) return
  const text = await textOf(noteId, editorFor(noteId, null))
  if (text === null) {
    toastFailure(t('linter.error.note_unavailable'))
    return
  }
  const outcome = await lintNote({ ...stamp, text, settings: useSession.getState().settings.linter, locale: appLocale() })
  if (outcome.error) {
    toastFailure(outcome.error)
    return
  }
  if (outcome.skipped) {
    useUi.getState().toast({ title: t('linter.toast.ignored'), tone: 'warning' })
    return
  }
  if (outcome.text === text) {
    useUi.getState().toast({ title: t('linter.toast.no_change') })
    return
  }
  const rules = await namesOf(outcome.changedRules)
  const go = await requestLintPreview({
    diff: buildPreviewDiff(text, outcome.text),
    rules,
  })
  if (!go) return
  announce(await lintOneNote(noteId), true)
}

function toastFailure(error: string): void {
  useUi.getState().toast({ title: t('linter.toast.failed', { error }), tone: 'danger' })
}

/** The batch commands: a folder and its subfolders, or every note in the library. */
async function lintMany(noteIds: string[], label: string): Promise<void> {
  if (!noteIds.length) return
  const capped = noteIds.slice(0, LINTER_BATCH_MAX)
  const go = await confirm({
    title: label ? t('linter.confirm.lint_folder.title', { name: label }) : t('linter.confirm.lint_all.title'),
    description: [
      t('linter.confirm.lint_all.description'),
      noteIds.length > capped.length
        ? t('linter.confirm.lint_all.capped', { max: LINTER_BATCH_MAX, total: noteIds.length })
        : '',
    ].filter(Boolean).join(' '),
  })
  if (!go) return
  const toast = useUi.getState().toast
  toast({ title: t('linter.progress.linting') })

  let changed = 0
  let errors = 0
  for (const noteId of capped) {
    const run = await lintOneNote(noteId)
    if (run.kind === 'applied') changed++
    if (run.kind === 'failed') errors++
  }
  const title = t('linter.progress.done', { changed, total: capped.length })
  const unfinished = noteIds.length > capped.length
    ? ` — ${t('linter.progress.capped', { done: capped.length, total: noteIds.length })}`
    : ''
  toast({
    title: `${title}${errors ? ` — ${t('linter.progress.errors', { count: errors })}` : ''}${unfinished}`,
    tone: errors || unfinished ? 'warning' : 'success',
  })
  // Notes the client held keep their own copy of the body, so the library is asked for the batch's
  // answers once at the end — pulling after every note made a run of thirty a crawl.
  if (changed) {
    await useNotes.getState().pull({ force: true }).catch(() => undefined)
  }
}

export async function lintWholeLibrary(): Promise<void> {
  const state = useNotes.getState()
  await lintMany(Object.values(state.notes).filter((note) => !note.deletedAt).map((note) => note.id), '')
}

export async function lintCurrentFolder(): Promise<void> {
  const noteId = useUi.getState().activeNoteId
  const folderId = noteId ? useNotes.getState().notes[noteId]?.folderId : null
  if (folderId) await lintFolderById(folderId)
}

/** Every note under one folder, subfolders included, whatever asked for it. */
export async function lintFolderById(folderId: string): Promise<void> {
  const state = useNotes.getState()
  const folders = folderDescendantIds(state.folders, folderId)
  const trail = folderPath(state.folders, folderId)
  await lintMany(
    Object.values(state.notes).filter((item) => !item.deletedAt && item.folderId && folders.has(item.folderId)).map((item) => item.id),
    trail[trail.length - 1]?.name ?? '',
  )
}

/**
 * "Leave this note alone", the same two lists the settings page edits, toggled from where the reader
 * is standing. The list itself, and what is already in it, live in `ignore-state` so a row menu can
 * ask without loading the rules.
 */
export function toggleIgnoreNote(): void {
  const noteId = useUi.getState().activeNoteId
  if (noteId) toggleNoteIgnored(noteId)
}

export function toggleIgnoreFolder(): void {
  const state = useNotes.getState()
  const noteId = useUi.getState().activeNoteId
  const folder = noteId ? folderPath(state.folders, state.notes[noteId]?.folderId ?? '').pop() : undefined
  if (folder) toggleFolderIgnored(folder.id)
}

/**
 * The way out of the paste rules: what is on the clipboard goes in as it is, with nothing run over
 * it. Writing it straight into the document is what makes this a bypass — the editor's paste handler,
 * which is where the paste rules live, never sees the event.
 */
export async function pasteWithoutFormatting(): Promise<void> {
  const toast = useUi.getState().toast
  const view = getActiveEditorView()
  if (!view) {
    toast({ title: t('command.no_editor_to_edit'), tone: 'warning' })
    return
  }
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  }
  catch {
    text = ''
  }
  if (!text) {
    toast({ title: t('linter.notice_text.empty_clipboard'), tone: 'warning' })
    return
  }
  const range = view.state.selection.main
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    userEvent: 'input.paste',
  })
}

/**
 * The automatic runs live in `idle-drive.ts` rather than here: that module is mounted by the editor
 * host, and it must not pull `diff-match-patch` and the rule reporting into the first paint for a
 * reader who never switches these on.
 */

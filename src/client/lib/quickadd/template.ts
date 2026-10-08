/**
 * The Template choice engine: a library template becomes a note, or is spliced into the note the
 * reader is in.
 *
 * Three things are settled before anything is written — the name, the folder and the text — and each
 * is formatted with one run clock and one variable map, so `{{DATE}}` in a title and in the body
 * agree even after a minute at a prompt, and an answer given for a name prompt can be reused by the
 * body.
 */
import { appendFrontMatterTag, parseFrontMatter, setFrontMatterValue } from '@shared/markdown-utils'
import type { QuickAddTemplateChoice } from '@shared/quickadd'
import type { FormatRuntime, PromptAnswer } from './format'
import { askForInputs, buildRuntime, type RunSession } from './runtime'
import { newSession, applyDateOrigin, formatWithPrompts, promptRequest as request } from './session'
import { folderJoin, sanitizeTitle, type NotePort, type QuickAddRunStatus } from './context'
import { t } from '../../lib/i18n'

/** A note title, from the name format or from a prompt when the choice has no format. */
async function resolveTitle(
  choice: QuickAddTemplateChoice,
  session: RunSession,
  runtime: FormatRuntime,
  port: NotePort,
): Promise<string | null> {
  if (choice.nameFormat.enabled) {
    const formatted = await formatWithPrompts(choice.nameFormat.format, runtime, session)
    const title = sanitizeTitle(formatted.text, '')
    if (!title) return null
    runtime.title = title
    return title
  }
  const existing = port.knownNoteTitles()
  const answers = await askForInputs(session, [request({
    key: 'title',
    label: t('quickadd.prompt_name'),
    kind: 'suggester',
    options: existing.slice(0, 200),
    allowCustom: true,
    trim: true,
    defaultValue: runtime.title ?? '',
  })])
  const value = answers.get('title')
  const title = typeof value === 'string' ? sanitizeTitle(value, '') : ''
  if (!title) return null
  runtime.title = title
  return title
}

async function resolveFolder(
  choice: QuickAddTemplateChoice,
  session: RunSession,
  runtime: FormatRuntime,
  port: NotePort,
): Promise<string | null> {
  let path: string | null = null
  switch (choice.folderMode) {
    case 'fixed':
      path = (await formatWithPrompts(choice.folderPath, runtime, session)).text.trim() || null
      break
    case 'source':
      path = port.activeNote()?.folderPath ?? null
      break
    case 'ask': {
      const answers = await askForInputs(session, [request({
        kind: 'suggester',
        key: 'folder',
        label: t('quickadd.prompt_folder'),
        options: port.knownFolderPaths(),
        allowCustom: true,
        optional: true,
        trim: true,
        defaultValue: choice.folderPath || port.settings().defaultFolder,
      })])
      const value = answers.get('folder')
      path = typeof value === 'string' ? value.trim() : null
      break
    }
    default:
      path = port.settings().defaultFolder
  }
  const folder = folderJoin(path) || null
  runtime.folderPath = folder
  return folder
}

export async function runTemplateChoice(
  choice: QuickAddTemplateChoice,
  port: NotePort,
  options: { sourceNoteId?: string; variables?: Map<string, PromptAnswer>; day?: Date } = {},
): Promise<QuickAddRunStatus> {
  const session = newSession(choice, port, options.variables, options.day, options.sourceNoteId)
  const cancelled = await applyDateOrigin(session)
  if (cancelled) return cancelled

  const runtime = buildRuntime(session, port)
  const body = await port.templateBody(choice.templateId ?? '')
  if (body === null)
    return { kind: 'failed', reason: t('quickadd.error_template_missing') }

  if (choice.mode === 'insert-here') {
    const active = port.activeNote()
    if (!active) return { kind: 'failed', reason: t('quickadd.error_no_open_note') }
    runtime.title = active.title
    runtime.folderPath = active.folderPath
    session.destination = active
    const formatted = await formatWithPrompts(body, runtime, session, active.title)
    if (!port.insertAtCursor(formatted.text, formatted.cursor))
      return { kind: 'failed', reason: t('quickadd.error_editor_unavailable') }
    port.recordRun(choice.id)
    return {
      kind: 'written',
      noteId: active.id,
      created: false,
      summary: t('quickadd.ran_into', { name: choice.name, destination: active.title }),
    }
  }

  const title = await resolveTitle(choice, session, runtime, port)
  if (!title) return { kind: 'cancelled' }
  const folder = await resolveFolder(choice, session, runtime, port)
  const existing = port.findByTitle(title)
  const collides = existing !== null && (existing.folderPath ?? '') === (folder ?? '')

  if (collides && existing && choice.existing !== 'number') {
    if (choice.existing === 'cancel')
      return { kind: 'failed', reason: t('quickadd.error_note_exists', { title }) }
    const answers = await askForInputs(session, [request({
      kind: 'confirm',
      key: 'overwrite',
      label: t('quickadd.prompt_overwrite', { title }),
    })])
    if (answers.get('overwrite') !== 'true') return { kind: 'cancelled' }
    session.destination = existing
    const formatted = await formatWithPrompts(body, runtime, session, existing.title)
    const prior = await port.read(existing.id)
    const written = await port.write(existing.id, formatted.text, prior)
    if (!written) return { kind: 'failed', reason: t('quickadd.error_write_refused') }
    if (formatted.cursor !== null) port.placeCursor(formatted.cursor)
    if (choice.openAfter) await port.open(existing.id)
    port.recordRun(choice.id)
    return {
      kind: 'written',
      noteId: existing.id,
      created: false,
      summary: t('quickadd.ran_into', { name: choice.name, destination: existing.title }),
    }
  }

  const finalTitle = collides ? nextAvailableTitle(port, title) : title
  session.destination = { id: '', title: finalTitle }
  const formatted = await formatWithPrompts(body, runtime, session, finalTitle)
  const created = await port.create({
    title: finalTitle,
    content: withTags(formatted.text, choice.tags),
    folderPath: folder,
    cursor: formatted.cursor,
  })
  if (!created) return { kind: 'failed', reason: t('quickadd.error_write_refused') }

  if (choice.linkToSource && options.sourceNoteId) {
    const source = port.byId(options.sourceNoteId)
    if (source) await port.appendLink(source, created)
  }
  if (choice.copyLink) port.copyText(port.linkTo(created))
  if (choice.openAfter) await port.open(created.id)
  port.recordRun(choice.id)
  return {
    kind: 'written',
    noteId: created.id,
    created: true,
    summary: t('quickadd.ran_new', { name: choice.name, destination: created.title }),
  }
}

/**
 * The choice's tags on the new note. `appendFrontMatterTag` deliberately only edits a note that
 * already has properties, so a body without front matter gets its block written here — a choice that
 * says "tag this with #meeting" must not quietly tag nothing.
 */
function withTags(content: string, tags: string[]): string {
  const wanted = tags.map((tag) => tag.trim().replace(/^#/, '').trim()).filter((tag) => tag !== '')
  if (wanted.length === 0) return content
  if (parseFrontMatter(content).lineOffset > 0) {
    let next = content
    for (const tag of wanted) next = appendFrontMatterTag(next, tag)
    return next
  }
  return setFrontMatterValue(content, 'tags', wanted)
}

function nextAvailableTitle(port: NotePort, title: string): string {
  let candidate = title
  for (let attempt = 2; attempt < 100 && port.findByTitle(candidate); attempt += 1)
    candidate = `${title} ${attempt}`
  return candidate
}

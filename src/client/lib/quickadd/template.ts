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
import type { FormatRuntime, PromptAnswer, PromptRequest } from './format'
import { askForInputs, buildRuntime, type RunSession } from './runtime'
import { askOrReuse, applyDateOrigin, dayRequest, formatWithPrompts, newSession, precollectInputs, promptRequest as request } from './session'
import { folderJoin, joinRouted, openingOptions, sanitizeTitle, splitTargetPath, type NotePort, type QuickAddRunStatus } from './context'
import { placeTemplate } from './insertion'
import { t } from '../../lib/i18n'

/** What the run asks for a name when the choice has no name format of its own. */
function titleRequest(port: NotePort, runtime: FormatRuntime): PromptRequest {
  const existing = port.knownNoteTitles()
  return request({
    key: 'title',
    label: t('quickadd.prompt_name'),
    kind: 'suggester',
    options: existing.slice(0, 200),
    allowCustom: true,
    trim: true,
    defaultValue: runtime.title ?? '',
  })
}

/** What the run asks for a folder when the choice lets the reader pick one each time. */
function folderRequest(choice: QuickAddTemplateChoice, port: NotePort): PromptRequest {
  return request({
    kind: 'suggester',
    key: 'folder',
    label: t('quickadd.prompt_folder'),
    options: port.knownFolderPaths(),
    allowCustom: true,
    optional: true,
    trim: true,
    defaultValue: choice.folderPath || port.settings().defaultFolder,
  })
}

/**
 * Which library template to use, when the choice asks each time. The answer is the template's id, so
 * two templates called the same thing stay distinguishable; the row says what the reader is choosing.
 */
function templateRequest(port: NotePort, categoryId: string | null): PromptRequest {
  const options = port.templatesForPick(categoryId)
  return request({
    kind: 'suggester',
    key: 'template',
    label: t('quickadd.prompt_template'),
    options: options.map((entry) => entry.id),
    displayOptions: options.map((entry) => (entry.category ? `${entry.name} (${entry.category})` : entry.name)),
    allowCustom: false,
    trim: true,
  })
}

/**
 * A note title and the folder it names: `Journal/{{DATE}}` is a title of `2026-10-08` inside
 * `Journal`, the way a capture target reads, because a title here cannot hold path characters.
 */
async function resolveTitle(
  choice: QuickAddTemplateChoice,
  session: RunSession,
  runtime: FormatRuntime,
  port: NotePort,
): Promise<{ title: string; folder: string | null } | null> {
  let named: { title: string; folder: string | null }
  if (choice.nameFormat.enabled) {
    const formatted = await formatWithPrompts(choice.nameFormat.format, runtime, session)
    named = splitTargetPath(formatted.text)
  } else {
    const value = await askOrReuse(session, titleRequest(port, runtime))
    named = splitTargetPath(typeof value === 'string' ? value : '')
  }
  const title = sanitizeTitle(named.title, '')
  if (!title) return null
  runtime.title = title
  return { title, folder: named.folder }
}

async function resolveFolder(
  choice: QuickAddTemplateChoice,
  session: RunSession,
  runtime: FormatRuntime,
  port: NotePort,
  routedFolder: string | null,
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
      const value = await askOrReuse(session, folderRequest(choice, port))
      path = typeof value === 'string' ? value.trim() : null
      break
    }
    default:
      path = port.settings().defaultFolder
  }
  const folder = joinRouted(folderJoin(path), routedFolder) || null
  runtime.folderPath = folder
  return folder
}

/** Which library template to use, when the choice says it asks each time. */
async function askForTemplate(session: RunSession, port: NotePort, categoryId: string | null): Promise<string | null> {
  if (port.templatesForPick(categoryId).length === 0) return null
  const value = await askOrReuse(session, templateRequest(port, categoryId))
  if (session.dismissed) return null
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export async function runTemplateChoice(
  choice: QuickAddTemplateChoice,
  port: NotePort,
  options: { sourceNoteId?: string; variables?: Map<string, PromptAnswer>; day?: Date } = {},
): Promise<QuickAddRunStatus> {
  const session = newSession(choice, port, options.variables, options.day, options.sourceNoteId)
  const runtime = buildRuntime(session, port)
  // `null` means the named template is gone, which stays a failure; `''` means the choice genuinely
  // wants a blank note, and a pick-each-time run has no body to scan yet.
  const fixedBody = choice.templatePick === 'ask' ? null : (choice.templateId ? await port.templateBody(choice.templateId) : '')
  const pickable = choice.templatePick === 'ask' ? port.templatesForPick(choice.templatePickCategory) : []
  const asks: PromptRequest[] = []
  const texts: string[] = []
  if (choice.dateOrigin === 'ask') asks.push(dayRequest(session))
  if (choice.templatePick === 'ask') {
    if (pickable.length > 0) asks.push(templateRequest(port, choice.templatePickCategory))
  }
  else if (fixedBody) texts.push(fixedBody)
  if (choice.mode !== 'insert-here') {
    if (choice.nameFormat.enabled) texts.push(choice.nameFormat.format)
    else asks.push(titleRequest(port, runtime))
    if (choice.folderMode === 'ask') asks.push(folderRequest(choice, port))
    else if (choice.folderMode === 'fixed') texts.push(choice.folderPath)
  }
  await precollectInputs(session, runtime, { requests: asks, texts })
  // The page was closed: asking the day question again would put a dialog in front of a reader who
  // just dismissed one.
  if (session.dismissed) return { kind: 'cancelled' }
  const cancelled = await applyDateOrigin(session)
  if (cancelled) return cancelled
  if (session.dismissed) return { kind: 'cancelled' }

  let templateRef = choice.templateId
  let body: string | null = fixedBody
  if (choice.templatePick === 'ask') {
    if (pickable.length === 0)
      return { kind: 'failed', reason: t('quickadd.error_no_templates_to_pick') }
    const asked = await askForTemplate(session, port, choice.templatePickCategory)
    if (session.dismissed) return { kind: 'cancelled' }
    if (!asked) return { kind: 'failed', reason: t('quickadd.error_template_missing') }
    templateRef = asked
    body = await port.templateBody(templateRef)
  }
  // "No template" is a choice the editor offers, so it means a blank note. Only a template that was
  // deleted from under the choice is a failure worth a danger notice.
  if (body === null)
    return { kind: 'failed', reason: t('quickadd.error_template_missing') }

  if (choice.mode === 'insert-here') {
    const active = port.activeNote()
    if (!active) return { kind: 'failed', reason: t('quickadd.error_no_open_note') }
    runtime.title = active.title
    runtime.folderPath = active.folderPath
    session.destination = active
    const formatted = await formatWithPrompts(body, runtime, session, active.title)
    if (session.dismissed) return { kind: 'cancelled' }
    // The editor holds the truth about the note the reader is in, selection included, so the placement
    // is computed against that text rather than against a copy that may have been saved since.
    const caret = port.activeEditorState?.() ?? null
    if (!caret) return { kind: 'failed', reason: t('quickadd.error_editor_unavailable') }
    const placed = placeTemplate({
      text: caret.text,
      from: caret.from,
      to: caret.to,
      drop: 'cursor',
      template: formatted.text,
      cursor: formatted.cursor,
    })
    // A template that carries only properties is not "nothing to write": the merge is the write.
    if (!placed.changed) return { kind: 'empty', noteId: active.id }
    if (!(await port.write(active.id, placed.content, caret.text)))
      return { kind: 'failed', reason: t('quickadd.error_write_refused') }
    if (placed.cursor !== null) port.placeCursor(placed.cursor)
    port.recordRun(choice.id)
    return {
      kind: 'written',
      noteId: active.id,
      created: false,
      summary: t('quickadd.ran_into', { name: choice.name, destination: active.title }),
    }
  }

  const named = await resolveTitle(choice, session, runtime, port)
  if (session.dismissed) return { kind: 'cancelled' }
  if (!named) return { kind: 'cancelled' }
  const title = named.title
  const folder = await resolveFolder(choice, session, runtime, port, named.folder)
  if (session.dismissed) return { kind: 'cancelled' }
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
    if (session.dismissed) return { kind: 'cancelled' }
    const prior = await port.read(existing.id)
    const written = await port.write(existing.id, formatted.text, prior)
    if (!written) return { kind: 'failed', reason: t('quickadd.error_write_refused') }
    if (choice.openFocus !== false && formatted.cursor !== null) port.placeCursor(formatted.cursor)
    if (choice.openAfter) await port.open(existing.id, openingOptions(choice))
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
  if (choice.openAfter) await port.open(created.id, openingOptions(choice))
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

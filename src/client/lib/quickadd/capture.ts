/**
 * The Capture choice engine: a formatted snippet placed into a note — at the bottom, at the top of
 * the body, under or above a heading line, at the caret, or into a property.
 *
 * Two rules carry most of the complexity. Placement is computed against the note as it read a moment
 * ago, then written as a whole-document replace, because a capture that lost a race with the reader's
 * own typing must not silently eat their edit. And the heading anchor is matched with the same rules
 * whether it is being found or being created, so a second run of the same capture finds the heading
 * the first run wrote.
 */
import { QUICKADD_LIMITS, type QuickAddCaptureChoice } from '@shared/quickadd'
import { parseFrontMatter, setFrontMatterValue } from '@shared/markdown-utils'
import type { FormatRuntime, PromptAnswer } from './format'
import { memoizeStructure } from './format'
import { askForInputs, buildRuntime, type RunSession } from './runtime'
import { applyDateOrigin, formatWithPrompts, newSession, promptRequest } from './session'
import { folderJoin, sanitizeTitle, type NotePort, type NoteRef, type QuickAddRunStatus } from './context'
import { bodyOf, parseValueToken, scanTokens } from './token-grammar'
import {
  anchorAllowsSubsections,
  appendAtBottom,
  findTargetRange,
  insertAfterInline,
  insertAfterLine,
  insertBeforeLine,
  isBlankTarget,
  onlyHeadingLines,
  orderedSlotFor,
  positionAfterMatch,
  positionAtSectionEnd,
  prependAtBodyStart,
  sectionEndLine,
  spliceAtSlot,
  splitLines,
  toTargetLines,
  type BlankLineMode,
} from './insertion'
import { t } from '../../lib/i18n'

const HEADING_RE = /^ {0,3}#{1,6}[ \t]+\S/

/** `Inbox`, `Journal/2026-10-08` or `Daily/2026/W12`: the last segment is the title. */
export function splitTargetPath(value: string): { title: string; folder: string | null } {
  const cleaned = value.replace(/[\\]/g, '/').replace(/\/+/g, '/').trim().replace(/\uFF0E/g, '.')
  const segments = cleaned.split('/').filter((segment) => segment !== '')
  const title = segments.length > 0 ? (segments[segments.length - 1] ?? '') : ''
  const folder = segments.length > 1 ? segments.slice(0, -1).join('/') : null
  return { title: title.trim(), folder: folder ? folderJoin(folder) : null }
}

async function resolveTarget(
  choice: QuickAddCaptureChoice,
  session: RunSession,
  runtime: FormatRuntime,
  port: NotePort,
): Promise<NoteRef | { create: { title: string; folder: string | null } } | QuickAddRunStatus> {
  if (choice.targetMode === 'active') {
    const active = port.activeNote()
    if (!active) return { kind: 'failed', reason: t('quickadd.error_no_open_note') }
    return active
  }
  const formatted = await formatWithPrompts(choice.targetTitle, runtime, session)
  const target = splitTargetPath(formatted.text)
  if (!target.title) return { kind: 'failed', reason: t('quickadd.error_target_missing') }
  const found = port.findByTitle(target.title)
  if (found) {
    // A capture named `Journal/Today` must not land in an unrelated note called `Today`.
    if (target.folder && (found.folderPath ?? '') !== target.folder) {
      if (!choice.createIfMissing)
        return { kind: 'failed', reason: t('quickadd.error_target_folder', { folder: target.folder, title: target.title }) }
      return { create: target }
    }
    return found
  }
  if (!choice.createIfMissing)
    return { kind: 'failed', reason: t('quickadd.error_target_not_found', { title: target.title }) }
  return { create: target }
}

/** One line of a multi-line `{{VALUE}}` answer per copy of the format, the rest of it asked once. */
const VALUE_TOKEN_NAMES = new Set(['value', 'name'])

/** The variable a `{{VALUE}}`/`{{NAME}}` token in this format reads, which per-line splitting rewrites. */
function valueKeyOf(format: string): string {
  for (const span of scanTokens(format)) {
    if (!VALUE_TOKEN_NAMES.has(span.name)) continue
    const parsed = parseValueToken(bodyOf(span))
    return parsed.variableKey || 'value'
  }
  return 'value'
}

/** `{{VALUE:Todo}}` and an answer stored as `todo` are the same variable to the formatter. */
function answerKeyFor(variables: Map<string, PromptAnswer>, key: string): string {
  if (variables.has(key)) return key
  const lower = key.toLowerCase()
  const matches = [...variables.keys()].filter(
    (entry) => entry.toLowerCase() === lower && variables.get(entry) !== undefined,
  )
  return matches.length === 1 ? matches[0]! : key
}

async function formatPayload(
  choice: QuickAddCaptureChoice,
  runtime: FormatRuntime,
  session: RunSession,
  destination: string,
): Promise<{ text: string; cursor: number | null }> {
  const plain = choice.format.enabled ? choice.format.format : '{{VALUE}}'
  // "Add to task list" wraps the format, not the answer, so every line of a per-line capture becomes
  // its own checkbox and an empty answer still yields a task the reader can fill in.
  const base = choice.task ? `- [ ] ${plain}\n` : plain
  // One entry per line runs the macros and the includes once, then fills the scalar tokens per line.
  const structured = memoizeStructure(runtime)
  const first = await formatWithPrompts(base, structured, session, destination)
  if (!choice.eachLine) return { text: first.text, cursor: first.cursor }

  const key = answerKeyFor(session.variables, valueKeyOf(base))
  const answer = session.variables.get(key)
  const lines = typeof answer === 'string'
    ? answer.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line !== '')
    : Array.isArray(answer) ? answer.map(String) : []
  // No lines means nothing was answered, so the token's own default — which the first pass already
  // applied — is the capture.
  if (lines.length === 0) return { text: first.text, cursor: first.cursor }
  // A whole clipboard pasted into the box would otherwise format one entry per line for minutes.
  const capped = lines.length > QUICKADD_LIMITS.maxEachLineEntries
  const wanted = capped ? lines.slice(0, QUICKADD_LIMITS.maxEachLineEntries) : lines
  if (capped)
    structured.warn(t('quickadd.warn_each_line_capped', {
      written: String(QUICKADD_LIMITS.maxEachLineEntries),
      count: String(lines.length),
    }))

  const entries: string[] = []
  try {
    for (const line of wanted) {
      session.variables.set(key, line)
      entries.push((await formatWithPrompts(base, structured, session, destination)).text)
    }
  } finally {
    session.variables.set(key, answer as PromptAnswer)
  }
  // Each entry keeps its own line break only when the format ended in one; otherwise the entries are
  // separated by a single newline, so a format of `- {{VALUE}}` cannot glue its lines together.
  return {
    text: entries
      .map((entry, index) => (index < entries.length - 1 && !entry.endsWith('\n') ? `${entry}\n` : entry))
      .join(''),
    // One caret for many entries is not a thing that means anything, so a per-line capture leaves the
    // reader where they were.
    cursor: null,
  }
}

async function headingChoices(port: NotePort, id: string): Promise<string[]> {
  const content = await port.read(id)
  const lines = splitLines(content)
  return extractHeadingLines(lines)
}

function extractHeadingLines(lines: string[]): string[] {
  const masked = onlyHeadingLines(lines)
  return masked.filter((line) => HEADING_RE.test(line.trimEnd())).map((line) => line.trimStart().trimEnd())
}

async function resolveAnchor(
  choice: QuickAddCaptureChoice,
  session: RunSession,
  runtime: FormatRuntime,
  port: NotePort,
  note: NoteRef,
  side: 'after' | 'before',
): Promise<string | QuickAddRunStatus> {
  const raw = side === 'after' ? choice.after : choice.before
  if (side === 'after' && choice.promptHeading) {
    const headings = await headingChoices(port, note.id)
    const answers = await askForInputs(session, [promptRequest({
      kind: 'suggester',
      key: 'heading',
      label: t('quickadd.prompt_heading'),
      options: headings,
      allowCustom: choice.createLineIfMissing,
      optional: false,
      trim: true,
    })])
    const value = answers.get('heading')
    if (typeof value !== 'string' || value.trim() === '') return { kind: 'cancelled' }
    return value.trim()
  }
  return (await formatWithPrompts(raw, runtime, session, note.title)).text
}

const BLANK_ANCHOR: {
  result: { content: string; cursor: number | null; changed: boolean }
  anchorWasCreated: boolean
  found: boolean
} = { result: { content: '', cursor: null, changed: false }, anchorWasCreated: false, found: false }

function place(
  choice: QuickAddCaptureChoice,
  side: 'after' | 'before',
  body: string,
  anchor: string,
  payload: string,
  cursor: number | null,
  locale: string,
): { result: { content: string; cursor: number | null; changed: boolean }; anchorWasCreated: boolean; found: boolean } {
  const targetLines = toTargetLines(anchor)
  if (isBlankTarget(targetLines)) return BLANK_ANCHOR
  const lines = splitLines(body)
  const wanted = cursor === null ? undefined : cursor
  // Inline mode anchors on a phrase inside a line, so it searches the text, not the lines: a picked
  // heading or an indented line is exactly what this mode is not looking for.
  if (choice.inline && side === 'after') {
    const needle = targetLines[0] ?? ''
    const hit = insertAfterInline(body, needle, payload, choice.replaceExisting, wanted)
    if (hit.matched) return { result: hit.result, anchorWasCreated: false, found: true }
    if (!choice.createLineIfMissing)
      return { result: { content: body, cursor: null, changed: false }, anchorWasCreated: true, found: false }
    // The anchor and its capture share the created line, which is what makes it an inline capture.
    // Unlike a found inline anchor, that line is terminated: a note whose last line has no line
    // break is not the capture the author asked for.
    return createAnchorBlock(choice, body, `${needle}${ensureNewline(payload)}`, needle, locale)
  }

  const headingOnly = targetLines.length === 1 && HEADING_RE.test(targetLines[0]!)
  const search = headingOnly ? onlyHeadingLines(lines) : lines
  const range = findTargetRange(search, targetLines)

  if (range.start !== -1) {
    if (side === 'before') {
      const result = insertBeforeLine(body, range.start, payload, wanted)
      return { result, anchorWasCreated: false, found: true }
    }
    const anchorLine = choice.atSectionEnd
      ? positionAtSectionEnd(
        lines,
        Math.max(
          sectionEndLine(lines, range.start, anchorAllowsSubsections(choice.considerSubsections, lines, range.start)) ?? lines.length - 1,
          range.end,
        ),
        body,
        payload,
      )
      : positionAfterMatch(lines, range.end, body, choice.blankLine as BlankLineMode)
    const result = insertAfterLine(body, anchorLine, payload, { task: choice.task, cursor: wanted })
    return { result, anchorWasCreated: false, found: true }
  }

  if (!choice.createLineIfMissing)
    return { result: { content: body, cursor: null, changed: false }, anchorWasCreated: true, found: false }

  const block = side === 'before'
    ? `${ensureNewline(payload)}${anchor}`
    : anchor.endsWith('\n') ? anchor : `${anchor}\n${ensureNewline(payload)}`
  return createAnchorBlock(choice, body, block, targetLines[0] ?? '', locale)
}

/** Where the anchor heading and its capture go when the anchor has to be written first. */
function createAnchorBlock(
  choice: QuickAddCaptureChoice,
  body: string,
  block: string,
  firstLine: string,
  locale: string,
): { result: { content: string; cursor: number | null; changed: boolean }; anchorWasCreated: boolean; found: boolean } {
  if (choice.createAt === 'ordered') {
    const slot = orderedSlotFor(splitLines(body), firstLine, {
      by: choice.orderBy.by,
      direction: choice.orderBy.direction,
      dateFormat: choice.orderBy.dateFormat,
    }, locale)
    return { result: spliceAtSlot(body, slot, block), anchorWasCreated: true, found: false }
  }
  const created = choice.createAt === 'top'
    ? prependAtBodyStart(body, block)
    : choice.createAt === 'bottom'
      ? appendAtBottom(body, block)
      : appendAtBodyAfterAnchor(body, block, choice.blankLine as BlankLineMode)
  return { result: created, anchorWasCreated: true, found: false }
}

/** `cursor` as a create location means "after the last line the reader is looking at", which a
 * whole-document write cannot know about; the bottom of the body is the nearest honest answer. */
function appendAtBodyAfterAnchor(body: string, block: string, mode: BlankLineMode) {
  const lines = splitLines(body)
  const position = positionAfterMatch(lines, lines.length - 1, body, mode)
  return insertAfterLine(body, position, block)
}

function ensureNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

function propertyPlan(choice: QuickAddCaptureChoice, existing: PromptAnswer, value: PromptAnswer): PromptAnswer {
  if (choice.property.action === 'set') return value
  const current = Array.isArray(existing) ? [...existing] : existing === null || existing === undefined || existing === '' ? [] : [String(existing)]
  // A list typed in Chinese separates with fullwidth commas and ideographic commas, so a reader who
  // writes two items that way means two items. The two glyphs are written as escapes because this
  // app's own i18n gate keeps Han-range literals out of `src/`.
  const additions = Array.isArray(value) ? value
    : String(value).split(/[,\uFF0C\u3001]/).map((item) => item.trim()).filter((item) => item !== '')
  const merged = [...current]
  for (const item of additions) {
    if (!merged.some((entry) => String(entry).trim().toLowerCase() === item.toLowerCase())) merged.push(item)
  }
  return merged
}

export async function runCaptureChoice(
  choice: QuickAddCaptureChoice,
  port: NotePort,
  options: { sourceNoteId?: string; variables?: Map<string, PromptAnswer>; locale?: string; day?: Date } = {},
): Promise<QuickAddRunStatus> {
  const session = newSession(choice, port, options.variables, options.day, options.sourceNoteId)
  const cancelled = await applyDateOrigin(session)
  if (cancelled) return cancelled
  const runtime = buildRuntime(session, port)

  const target = await resolveTarget(choice, session, runtime, port)
  if ('kind' in target) return target

  let note: NoteRef
  let body: string
  let created = false
  if ('create' in target) {
    const template = choice.createTemplateId ? await port.templateBody(choice.createTemplateId) : null
    const made = await port.create({
      title: sanitizeTitle(target.create.title, target.create.title),
      content: template ?? '',
      folderPath: target.create.folder,
    })
    if (!made) return { kind: 'failed', reason: t('quickadd.error_write_refused') }
    note = made
    body = await port.read(made.id)
    created = true
  } else {
    note = target
    body = await port.read(note.id)
  }
  session.destination = note
  runtime.title = note.title
  runtime.folderPath = note.folderPath

  if (choice.property.enabled) {
    const value = await formatWithPrompts(
      choice.property.format.enabled ? choice.property.format.format : '{{VALUE}}',
      { ...runtime, variables: runtime.variables },
      session,
      note.title,
    )
    const parsed = parseFrontMatter(body)
    const name = choice.property.prompted
      ? await promptForProperty(session, parsed, choice, note)
      : (await formatWithPrompts(choice.property.name, runtime, session, note.title)).text.trim()
    if (!name) return { kind: 'failed', reason: t('quickadd.error_property_name') }
    const key = Object.keys(parsed.data).find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? name
    const existing = key in parsed.data ? (parsed.data[key] as PromptAnswer) : null
    const planned = propertyPlan(choice, existing, value.text)
    if (choice.property.action === 'append' && (planned as string[]).length === 0)
      return { kind: 'empty', noteId: note.id }
    const next = setFrontMatterValue(body, key, Array.isArray(planned) ? planned.map(String) : String(planned))
    if (next === body) return { kind: 'empty', noteId: note.id }
    if (!(await port.write(note.id, next, body))) return { kind: 'failed', reason: t('quickadd.error_write_refused') }
    port.recordRun(choice.id)
    return {
      kind: 'written',
      noteId: note.id,
      created,
      summary: t('quickadd.ran_property', { name: choice.name, property: key, destination: note.title }),
    }
  }

  const payload = await formatPayload(choice, runtime, session, note.title)
  const isEmpty = payload.text.trim() === '' && payload.cursor === null
  if (isEmpty && !created) return { kind: 'empty', noteId: note.id }

  let outcome: { content: string; cursor: number | null; changed: boolean }
  if (choice.writePosition === 'cursor') {
    if (note.id !== port.activeNote()?.id || !port.insertAtCursor(payload.text, payload.cursor))
      return { kind: 'failed', reason: t('quickadd.error_editor_unavailable') }
    outcome = { content: body, cursor: payload.cursor, changed: true }
  } else if (choice.writePosition === 'top') {
    outcome = prependAtBodyStart(body, payload.text, payload.cursor ?? undefined)
  } else if (choice.writePosition === 'bottom') {
    outcome = appendAtBottom(body, payload.text, payload.cursor ?? undefined)
  } else {
    const anchor = await resolveAnchor(choice, session, runtime, port, note, choice.writePosition === 'insertBefore' ? 'before' : 'after')
    if (typeof anchor !== 'string') return anchor
    const side = choice.writePosition === 'insertBefore' ? 'before' : 'after'
    if (choice.inline && side === 'after' && toTargetLines(anchor).length > 1)
      return { kind: 'failed', reason: t('quickadd.error_anchor_multiline') }
    const placed = place(choice, side, body, anchor, payload.text, payload.cursor, options.locale ?? 'en-US')
    if (placed === BLANK_ANCHOR) return { kind: 'failed', reason: t('quickadd.error_anchor_blank') }
    if (!placed.found && !choice.createLineIfMissing)
      return { kind: 'failed', reason: t('quickadd.error_anchor_missing', { anchor }) }
    outcome = placed.result
  }

  if (!outcome.changed) return { kind: 'empty', noteId: note.id }
  if (choice.writePosition !== 'cursor' && !(await port.write(note.id, outcome.content, body)))
    return { kind: 'failed', reason: t('quickadd.error_write_refused') }

  if (choice.linkToSource && options.sourceNoteId) {
    const source = port.byId(options.sourceNoteId)
    if (source) await port.appendLink(source, note)
  }
  if (choice.copyLink) port.copyText(port.linkTo(note))
  if (choice.openAfter) {
    await port.open(note.id)
    if (outcome.cursor !== null) port.placeCursor(outcome.cursor)
  }
  port.recordRun(choice.id)
  return {
    kind: 'written',
    noteId: note.id,
    created,
    summary: t(created ? 'quickadd.ran_new' : 'quickadd.ran_into', { name: choice.name, destination: note.title }),
  }
}

async function promptForProperty(
  session: RunSession,
  parsed: ReturnType<typeof parseFrontMatter>,
  choice: QuickAddCaptureChoice,
  note: NoteRef,
): Promise<string> {
  const keys = Object.keys(parsed.data).filter((key) => key !== '__proto__').sort((a, b) => a.localeCompare(b))
  const answers = await askForInputs(session, [promptRequest({
    kind: 'suggester',
    key: 'property',
    label: t('quickadd.prompt_property'),
    options: keys,
    allowCustom: choice.property.createIfMissing,
    optional: keys.length === 0 && !choice.property.createIfMissing,
    trim: true,
  })], { destination: note.title })
  const value = answers.get('property')
  return typeof value === 'string' ? value.trim() : ''
}

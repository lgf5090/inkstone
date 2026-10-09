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
import { parseFrontMatter, setFrontMatterValue, type FrontMatterListItem, type FrontMatterValue } from '@shared/markdown-utils'
import { propertyValueKind } from '@shared/property-values'
import type { FormatRuntime, PromptAnswer, PromptRequest } from './format'
import { memoizeStructure } from './format'
import { buildRuntime, type RunSession } from './runtime'
import { askOrReuse, applyDateOrigin, dayRequest, formatWithPrompts, newSession, precollectInputs, promptRequest } from './session'
import { sanitizeTitle, splitTargetPath, type NotePort, type NoteRef, type QuickAddRunStatus } from './context'
import { bodyOf, parseValueToken, scanTokens, type ValueInputType } from './token-grammar'
import type { PropertyValueKind } from '@shared/property-values'
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
  isBlankPayload,
} from './insertion'
import { t } from '../../lib/i18n'

const HEADING_RE = /^ {0,3}#{1,6}[ \t]+\S/

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

/** The text a capture writes, before any of it is formatted: what the opening page can scan. */
function payloadFormat(choice: QuickAddCaptureChoice): string {
  const plain = choice.format.enabled ? choice.format.format : '{{VALUE}}'
  // "Add to task list" wraps the format, not the answer, so every line of a per-line capture becomes
  // its own checkbox and an empty answer still yields a task the reader can fill in.
  return choice.task ? `- [ ] ${plain}\n` : plain
}

/**
 * The value token a property format consists of, and only when it is exactly one: that `|type:` is the
 * author saying what the property holds. A sentence like `Count: {{VALUE}}` is text, whatever it says.
 */
function declaredValueType(format: string): ValueInputType | null {
  const text = format.trim()
  const spans = scanTokens(text)
  if (spans.length !== 1) return null
  const span = spans[0]!
  if (span.name !== 'value' && span.name !== 'name') return null
  if (span.start !== 0 || span.end !== text.length) return null
  return parseValueToken(bodyOf(span)).inputType
}

const NUMERIC_TEXT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

function booleanWord(text: string): boolean | null {
  const words = text.trim().toLowerCase()
  return TRUE_WORDS.has(words) ? true : FALSE_WORDS.has(words) ? false : null
}

/**
 * The value in the shape the key already has, as the app's own property rules read that shape: a declared
 * `|type:number` or `|type:checkbox` wins, and otherwise a number or boolean property keeps its kind.
 * Text that cannot be read as the type stays text — a silent `42 → 0` or `soon → false` is a worse
 * surprise than a value the reader can see.
 */
function typedPropertyValue(text: string, declared: ValueInputType | null, kind: PropertyValueKind): FrontMatterValue {
  const trimmed = text.trim()
  if (declared === 'number' || declared === 'slider' || kind === 'number') {
    if (NUMERIC_TEXT.test(trimmed)) return Number(trimmed)
  }
  if (declared === 'checkbox' || kind === 'boolean') {
    const word = booleanWord(trimmed)
    if (word !== null) return word
  }
  return text
}

/** The text a property capture writes its value from. */
function propertyFormat(choice: QuickAddCaptureChoice): string {
  return choice.property.format.enabled ? choice.property.format.format : '{{VALUE}}'
}

async function formatPayload(
  choice: QuickAddCaptureChoice,
  runtime: FormatRuntime,
  session: RunSession,
  destination: string,
): Promise<{ text: string; cursor: number | null }> {
  const base = payloadFormat(choice)
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
    const value = await askOrReuse(session, promptRequest({
      kind: 'suggester',
      key: 'heading',
      label: t('quickadd.prompt_heading'),
      options: headings,
      allowCustom: choice.createLineIfMissing,
      optional: false,
      trim: true,
    }), note.title)
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

/**
 * A list keeps the shape it has: `nums: [1, 2]` with a third number stays a list of numbers, and the
 * whole list goes back to text if any one element cannot be read as that type — a half-coerced list is
 * two shapes in one property.
 */
function typedPropertyList(items: string[], existing: unknown, declared: ValueInputType | null): FrontMatterListItem[] {
  const all = (test: (entry: unknown) => boolean): boolean => Array.isArray(existing)
    && existing.length > 0
    && existing.every(test)
  const numeric = declared === 'number' || declared === 'slider' || all((entry) => typeof entry === 'number')
  if (numeric && items.every((item) => NUMERIC_TEXT.test(item.trim())))
    return items.map((item) => Number(item.trim()))
  const booleanish = declared === 'checkbox' || all((entry) => typeof entry === 'boolean')
  if (booleanish && items.every((item) => booleanWord(item) !== null))
    return items.map((item) => booleanWord(item) as boolean)
  return items
}

export async function runCaptureChoice(
  choice: QuickAddCaptureChoice,
  port: NotePort,
  options: { sourceNoteId?: string; variables?: Map<string, PromptAnswer>; locale?: string; day?: Date } = {},
): Promise<QuickAddRunStatus> {
  const session = newSession(choice, port, options.variables, options.day, options.sourceNoteId)
  const runtime = buildRuntime(session, port)
  // The heading and property-name pickers are not on this page: their choices come from the note the
  // run has to resolve first, so asking them up front would offer a list of nothing.
  const asks: PromptRequest[] = []
  const texts: string[] = []
  if (choice.dateOrigin === 'ask') asks.push(dayRequest(session))
  if (choice.targetMode !== 'active') texts.push(choice.targetTitle)
  if (choice.property.enabled) {
    texts.push(propertyFormat(choice))
    if (!choice.property.prompted) texts.push(choice.property.name)
  }
  else texts.push(payloadFormat(choice))
  await precollectInputs(session, runtime, { requests: asks, texts })
  if (session.dismissed) return { kind: 'cancelled' }
  const cancelled = await applyDateOrigin(session)
  if (cancelled) return cancelled
  if (session.dismissed) return { kind: 'cancelled' }

  const target = await resolveTarget(choice, session, runtime, port)
  if (session.dismissed) return { kind: 'cancelled' }
  if ('kind' in target) return target

  let note: NoteRef
  let body: string
  let created = false
  if ('create' in target) {
    // The note is only written once every question has been answered. Creating it up front meant a
    // reader who closed the prompt found an empty note in the sidebar.
    note = { id: '', title: sanitizeTitle(target.create.title, target.create.title), folderPath: target.create.folder }
    body = (choice.createTemplateId ? await port.templateBody(choice.createTemplateId) : null) ?? ''
    created = true
  } else {
    note = target
    body = await port.read(note.id)
  }
  session.destination = note
  runtime.title = note.title
  runtime.folderPath = note.folderPath

  const materialise = async (): Promise<QuickAddRunStatus | null> => {
    if (!created || note.id !== '') return null
    const made = await port.create({ title: note.title, content: body, folderPath: note.folderPath })
    if (!made) return { kind: 'failed', reason: t('quickadd.error_write_refused') }
    note = made
    body = await port.read(made.id)
    session.destination = made
    runtime.title = made.title
    runtime.folderPath = made.folderPath
    return null
  }

  if (choice.property.enabled) {
    const value = await formatWithPrompts(
      propertyFormat(choice),
      { ...runtime, variables: runtime.variables },
      session,
      note.title,
    )
    const parsed = parseFrontMatter(body)
    const name = choice.property.prompted
      ? await promptForProperty(session, parsed, choice, note)
      : (await formatWithPrompts(choice.property.name, runtime, session, note.title)).text.trim()
    if (session.dismissed) return { kind: 'cancelled' }
    const refusedProperty = await materialise()
    if (refusedProperty) return refusedProperty
    if (!name) return { kind: 'failed', reason: t('quickadd.error_property_name') }
    const key = Object.keys(parsed.data).find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? name
    const existing = key in parsed.data ? (parsed.data[key] as PromptAnswer) : null
    const planned = propertyPlan(choice, existing, value.text)
    const declared = declaredValueType(propertyFormat(choice))
    const kind = propertyValueKind(existing, key)
    if (choice.property.action === 'append' && (planned as string[]).length === 0)
      return { kind: 'empty', noteId: note.id }
    const next = setFrontMatterValue(body, key, Array.isArray(planned)
      ? typedPropertyList(planned.map(String), existing, declared)
      : typedPropertyValue(String(planned ?? ''), declared, kind))
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
  if (session.dismissed) return { kind: 'cancelled' }
  const refusedPayload = await materialise()
  if (refusedPayload) return refusedPayload
  const isEmpty = isBlankPayload(payload.text) && payload.cursor === null
  if (isEmpty && !created) return { kind: 'empty', noteId: note.id }
  let outcome: { content: string; cursor: number | null; changed: boolean }
  if (choice.writePosition === 'cursor') {
    if (note.id !== port.activeNote()?.id || !port.insertAtCursor(payload.text, payload.cursor))
      return { kind: 'failed', reason: t('quickadd.error_editor_unavailable') }
    outcome = { content: body, cursor: payload.cursor, changed: true }
  } else if (choice.writePosition === 'lineAbove' || choice.writePosition === 'lineBelow') {
    // These two write through the open editor, so a note that is not on screen cannot be their target;
    // the whole-document path would drop the reader's unsaved typing on the floor.
    const side = choice.writePosition === 'lineAbove' ? 'above' : 'below'
    if (note.id !== port.activeNote()?.id || !port.insertRelativeToLine(payload.text, side, payload.cursor))
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
  const writtenInEditor = choice.writePosition === 'cursor' || choice.writePosition === 'lineAbove' || choice.writePosition === 'lineBelow'
  if (!writtenInEditor && !(await port.write(note.id, outcome.content, body)))
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
  const value = await askOrReuse(session, promptRequest({
    kind: 'suggester',
    key: 'property',
    label: t('quickadd.prompt_property'),
    options: keys,
    allowCustom: choice.property.createIfMissing,
    optional: keys.length === 0 && !choice.property.createIfMissing,
    trim: true,
  }), note.title)
  return typeof value === 'string' ? value.trim() : ''
}

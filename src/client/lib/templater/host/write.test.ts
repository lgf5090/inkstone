import { describe, expect, it } from 'vitest'
import type { RunMode, RunNoteRef } from '../protocol'
import { groupCursorMarkers, jumpToNextCursor } from '../engine/cursor-markers'
import { MAX_OUTPUT_CHARS } from '../limits'
import { planWrite, validateNotePath, type NotePathIssue, type WritePlan, type WriteRequest } from './write'

/**
 * The write pipeline is the half that can destroy a note, so these read as a list of things that must
 * never happen quietly: a truncated output, a rewritten properties block, a selection the page did not
 * ask for, a note replaced by a create.
 *
 * One test re-derives the whole document from the plan's two ranges, which is the property that makes
 * "one apply, one undo" true; the cursor tests check themselves against `engine/cursor-markers`, the
 * module that owns finding markers in text, so the two cannot drift apart unnoticed.
 */

const APPEND: RunMode = 'append-active'
const CREATE: RunMode = 'create-new'
const OVERWRITE_ACTIVE: RunMode = 'overwrite-active'
const OVERWRITE_FILE: RunMode = 'overwrite-file'
const DYNAMIC: RunMode = 'dynamic-processor'
const STARTUP: RunMode = 'startup'
const RENDER: RunMode = 'render-only'

/** `<% tp.file.cursor(1) %>`, the text a run leaves behind for the caret to be placed at. */
const MARKER = '<% tp.file.cursor(1) %>'

function note(content: string, overrides: Partial<RunNoteRef> = {}): RunNoteRef {
  return {
    id: 'note-1',
    title: 'Target',
    content,
    folderId: null,
    tagNames: [],
    frontmatter: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isEmpty: content === '',
    ...overrides,
  }
}

function asked(overrides: Partial<WriteRequest>): WriteRequest {
  const request: WriteRequest = {
    mode: APPEND,
    rendered: '',
    currentContent: '',
    cursorGroups: [],
    ...overrides,
  }
  // The page counts the markers once per run, so the default here is that same call rather than a
  // fixture: offsets measured in `rendered`.
  if (overrides.cursorGroups === undefined) request.cursorGroups = groupCursorMarkers(request.rendered)
  if (overrides.target === undefined) request.target = note(request.currentContent)
  return request
}

/** A plan, or a failing test that says which code refused it. */
function planned(overrides: Partial<WriteRequest>): WritePlan {
  const result = planWrite(asked(overrides))
  if (!result.ok) throw new Error(`refused: ${result.code} ${result.detail}`)
  return result.plan
}

function refused(overrides: Partial<WriteRequest>): { code: string; detail: string } {
  const result = planWrite(asked(overrides))
  if (result.ok) throw new Error(`planned a ${result.plan.kind} instead of refusing`)
  return { code: result.code, detail: result.detail }
}

/** The plan's two ranges, applied in document order: properties, then the body. */
function rebuild(current: string, plan: WritePlan): string {
  const prefix = plan.frontmatter
    ? current.slice(0, plan.frontmatter.range.start)
      + plan.frontmatter.text
      + current.slice(plan.frontmatter.range.end, plan.body.range.start)
    : current.slice(0, plan.body.range.start)
  return prefix + plan.body.text + current.slice(plan.body.range.end)
}

/** The same ranges applied bottom-up, which is how an editor takes several replacements as one transaction. */
function applyInOneTransaction(current: string, plan: WritePlan): string {
  const edits = [
    { range: plan.body.range, text: plan.body.text },
    ...(plan.frontmatter ? [{ range: plan.frontmatter.range, text: plan.frontmatter.text }] : []),
  ].sort((left, right) => right.range.start - left.range.start)
  let text = current
  for (const edit of edits) text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end)
  return text
}

const kinds = (plan: WritePlan): string[] => plan.notes.map((entry) => entry.kind)

describe('planWrite guards', () => {
  it('refuses an output larger than the product can store, and never cuts it down', () => {
    expect(refused({ mode: CREATE, path: 'Notes/Big.md', rendered: 'x'.repeat(MAX_OUTPUT_CHARS + 1) })).toEqual({
      code: 'template-output-too-large',
      detail: `chars:${MAX_OUTPUT_CHARS + 1}`,
    })
  })

  it('refuses the finished note too, when the merge pushes it past the ceiling', () => {
    const currentContent = 'a'.repeat(MAX_OUTPUT_CHARS - 10)
    expect(refused({ currentContent, rendered: '---\nk: value\n---\nsixteen chars here' }).code)
      .toBe('template-output-too-large')
  })

  it('keeps writing to a note that is already past the ceiling, because the reader made it that long', () => {
    const currentContent = 'a'.repeat(MAX_OUTPUT_CHARS + 500)
    const plan = planned({ currentContent, rendered: 'one more line' })
    expect(plan.content.length).toBe(currentContent.length + 'one more line'.length)
  })

  it('refuses a target that is gone instead of creating it', () => {
    for (const mode of [APPEND, OVERWRITE_ACTIVE, OVERWRITE_FILE]) {
      expect(refused({ mode, target: null, rendered: 'text' })).toEqual({ code: 'note-not-found', detail: mode })
    }
  })

  it('reports a concurrent write as a conflict rather than overwriting it', () => {
    expect(refused({ rendered: 'text', startedAtRev: 3, currentRev: 4 })).toEqual({
      code: 'note-conflict',
      detail: 'rev:3->4',
    })
    expect(planned({ rendered: 'more text', startedAtRev: 3, currentRev: 3 }).expectedRev).toBe(3)
    expect(planned({ rendered: 'text' }).expectedRev).toBeNull()
  })

  it('refuses to create over a note that already has text', () => {
    expect(refused({ mode: CREATE, path: 'Notes/x.md', currentContent: 'written' }).detail).toBe('not-empty')
    expect(refused({
      mode: CREATE,
      path: 'Notes/x.md',
      currentContent: '',
      target: note('written', { isEmpty: false }),
    }).code).toBe('note-conflict')
  })

  it('says a mode it cannot express instead of guessing a span', () => {
    expect(refused({ mode: DYNAMIC, rendered: 'text' })).toEqual({ code: 'not-supported', detail: 'dynamic-processor' })
  })

  it('discards a startup run with a reason, and still refuses an oversized one', () => {
    const plan = planned({ mode: STARTUP, rendered: 'ignored text' })
    expect(plan).toMatchObject({ kind: 'discard', content: '', carets: [], frontmatter: null })
    expect(plan.notes).toEqual([{ kind: 'output-discarded' }])
    expect(refused({ mode: STARTUP, rendered: 'x'.repeat(MAX_OUTPUT_CHARS + 1) }).code)
      .toBe('template-output-too-large')
  })

  it('refuses a create with nowhere to put the note', () => {
    expect(refused({ mode: CREATE, rendered: 'text' })).toEqual({ code: 'path-invalid', detail: 'empty' })
  })

  it('checks a path in every mode, not only the create one', () => {
    expect(refused({ mode: OVERWRITE_FILE, path: 'Notes/../Secret/x.md', rendered: 'b' })).toEqual({
      code: 'path-invalid',
      detail: 'escape',
    })
  })
})

describe('validateNotePath', () => {
  function verdict(path: string): NotePathIssue | string {
    const result = validateNotePath(path)
    return result.ok ? result.path : result.reason
  }

  it('refuses a traversal, before and after folding', () => {
    expect(verdict('..')).toBe('escape')
    expect(verdict('Notes/../../Secret/x.md')).toBe('escape')
    expect(verdict('Notes/./../x.md')).toBe('escape')
    // The same traversal spelled with a Windows separator, which folding must expose rather than hide.
    expect(verdict('Notes/..\\..\\Secret\\x.md')).toBe('escape')
    expect(verdict('..\\..\\windows\\system32')).toBe('escape')
  })

  it('refuses an absolute Windows destination in either separator', () => {
    expect(verdict('C:\\Notes\\a.md')).toBe('drive')
    expect(verdict('c:/Notes/a.md')).toBe('drive')
    expect(verdict('\\\\server\\share\\a.md')).toBe('absolute')
  })

  it('refuses the characters a file name cannot hold', () => {
    expect(verdict('Notes/a<b>.md')).toBe('reserved')
    expect(verdict('Notes/a:b.md')).toBe('reserved')
    expect(verdict('Notes/a|b?.md')).toBe('reserved')
    expect(verdict('Notes/secret*')).toBe('reserved')
    expect(verdict('Notes/"quoted"')).toBe('reserved')
  })

  it('refuses a segment Windows would strip, which would be a second name for one note', () => {
    expect(verdict('Notes/Draft.')).toBe('trailing')
    expect(verdict('Notes/Draft /a.md')).toBe('trailing')
  })

  it('refuses an empty path', () => {
    expect(verdict('')).toBe('empty')
    expect(verdict('   ')).toBe('empty')
    expect(verdict('///')).toBe('empty')
  })

  it('normalises instead of refusing a path that still lands inside the tree', () => {
    // Obsidian's `normalizePath` and this app's note index both read these forms as one path; refusing
    // them would only make templates spell the same destination two ways.
    expect(verdict('/Notes/a.md')).toBe('Notes/a.md')
    expect(verdict('Notes//a.md')).toBe('Notes/a.md')
    expect(verdict('Notes\\Sub\\a.md')).toBe('Notes/Sub/a.md')
    expect(verdict('  Notes/a.md  ')).toBe('Notes/a.md')
  })

  it('has no decode step, so a percent-escaped dot stays a name', () => {
    expect(verdict('Notes/%2e%2e/x.md')).toBe('Notes/%2e%2e/x.md')
  })
})

describe('planWrite create-new', () => {
  it('writes the output exactly as the template spelled it', () => {
    const rendered = '---\ntitle: "kept as typed"\ntags: [a, b] # comment\n---\nBody\n'
    const plan = planned({ mode: CREATE, path: '/Notes//New.md', rendered })
    expect(plan.kind).toBe('create')
    expect(plan.content).toBe(rendered)
    expect(plan.frontmatter).toBeNull()
    expect(plan.body).toEqual({ range: { start: 0, end: 0 }, text: rendered })
    expect(plan.notes).toEqual([])
  })

  it('writes an empty block as written, without inventing properties', () => {
    expect(planned({ mode: CREATE, path: 'Notes/New.md', rendered: '---\n---\nText' }).content).toBe('---\n---\nText')
  })

  it('keeps an unparsable block in the note text, since there is nothing to merge into', () => {
    const rendered = '---\ntags: [#test]\n---\nBody'
    const plan = planned({ mode: CREATE, path: 'Notes/New.md', rendered })
    expect(plan.content).toBe(rendered)
    expect(kinds(plan)).toEqual(['template-frontmatter-invalid'])
  })
})

describe('planWrite render-only', () => {
  it('hands back the document a create run would have written, and lands it nowhere', () => {
    // QuickAdd's Template choice owns its own write — title, folder, tags, link-back, conflict rules — so
    // this mode answers with the bytes the note would have held and a `discard` kind, which is what keeps
    // the two callers from assembling the same rendered body two different ways.
    const rendered = '---\ntitle: "kept as typed"\n---\nBody\n'
    const plan = planned({ mode: RENDER, rendered, target: null })
    expect(plan.kind).toBe('discard')
    expect(plan.content).toBe(rendered)
    expect(plan.body).toEqual({ range: { start: 0, end: 0 }, text: '' })
    expect(plan.frontmatter).toBeNull()
    expect(plan.carets).toEqual([])
    expect(kinds(plan)).toEqual([])
  })

  it('takes the first caret group out of the text and reports where it was', () => {
    const rendered = `before${MARKER}after`
    const plan = planned({ mode: RENDER, rendered, target: null })
    expect(plan.content).toBe('beforeafter')
    expect(plan.carets).toEqual([6])
  })

  it('needs neither a note nor a path, because it writes no note', () => {
    expect(planned({ mode: RENDER, rendered: 'Body', target: null }).content).toBe('Body')
  })

  it('refuses an over-budget output like every other mode, rather than handing back half a document', () => {
    expect(refused({ mode: RENDER, rendered: 'x'.repeat(MAX_OUTPUT_CHARS + 1), target: null }).code)
      .toBe('template-output-too-large')
  })
})

describe('planWrite append-active', () => {
  it('merges the properties and splices the body at the selection', () => {
    const currentContent = '---\nonly_in_target: keep\nboth: from the note\n---\nHead\n'
    const plan = planned({
      currentContent,
      rendered: '---\nboth: from the template\nonly_in_template: new\n---\nInserted',
      selection: { start: currentContent.length, end: currentContent.length },
    })
    expect(plan.kind).toBe('insert')
    expect(plan.frontmatter?.text).toBe('---\nonly_in_target: keep\nboth: from the template\nonly_in_template: new\n---\n')
    expect(plan.frontmatter?.changes).toEqual([
      { key: 'both', action: 'overwritten' },
      { key: 'only_in_template', action: 'added' },
    ])
    expect(plan.content).toBe('---\nonly_in_target: keep\nboth: from the template\nonly_in_template: new\n---\nHead\nInserted')
    expect(plan.body).toEqual({ range: { start: currentContent.length, end: currentContent.length }, text: 'Inserted' })
  })

  it('keeps the reader quoting, comments and flow style through the merge', () => {
    const currentContent = '---\n# a note of mine\ntitle: "quoted"\ntags: [a, b]\n---\nBody'
    const plan = planned({ currentContent, rendered: '---\ntags: [c]\n---\n' })
    expect(plan.frontmatter?.text).toBe('---\n# a note of mine\ntitle: "quoted"\ntags: [a, b, c]\n---\n')
  })

  it('closes the merged block with the fence the note used', () => {
    const plan = planned({ currentContent: '---\na: 1\n...\nBody', rendered: '---\nb: 2\n---\nText' })
    expect(plan.frontmatter?.text).toBe('---\na: 1\nb: 2\n...\n')
  })

  it('leaves the properties alone when the template has none to add', () => {
    const currentContent = '---\ntitle: "quoted"\n---\nBody'
    const plan = planned({ currentContent, rendered: 'Appended text' })
    expect(plan.frontmatter).toBeNull()
    expect(plan.content).toBe('---\ntitle: "quoted"\n---\nBodyAppended text')
    expect(plan.notes).toEqual([])
  })

  it('does not rewrite the note when a second run adds nothing', () => {
    const currentContent = '---\ntags: [a, b]\n---\nBody'
    const plan = planned({ currentContent, rendered: '---\ntags: [a]\n---\nText' })
    expect(plan.frontmatter).toBeNull()
    expect(plan.content).toBe(`${currentContent}Text`)
  })

  it('writes the template block verbatim above a note that has no properties yet', () => {
    const plan = planned({ currentContent: 'Body', rendered: '---\ntags: [a, b] # mine\n---\nMore' })
    expect(plan.frontmatter).toEqual({
      range: { start: 0, end: 0 },
      text: '---\ntags: [a, b] # mine\n---\n',
      changes: [{ key: 'tags', action: 'added' }],
    })
    expect(plan.content).toBe('---\ntags: [a, b] # mine\n---\nBodyMore')
  })

  it('inserts an unparsable template block as prose, the upstream fallback', () => {
    // `append_template_to_active_file inserts % directive template into note with valid YAML`
    const currentContent = '---\ntitle: existing\n---\n'
    const plan = planned({ currentContent, rendered: '---\naliases:\n- %\n---\n' })
    expect(plan.frontmatter).toBeNull()
    expect(plan.content).toBe('---\ntitle: existing\n---\n---\naliases:\n- %\n---\n')
    expect(kinds(plan)).toEqual(['template-frontmatter-invalid'])
  })

  it('refuses to merge into a note whose own block does not read', () => {
    const currentContent = '---\ntags: [#test]\n---\nBody'
    const plan = planned({ currentContent, rendered: '---\ntitle: template\n---\nText' })
    expect(plan.frontmatter).toBeNull()
    expect(plan.content).toBe(`${currentContent}Text`)
    expect(kinds(plan)).toEqual(['note-frontmatter-invalid'])
  })

  it('replaces a selected span, not only the caret', () => {
    const plan = planned({ currentContent: 'keep DROP tail', rendered: 'IN', selection: { start: 5, end: 9 } })
    expect(plan.body.range).toEqual({ start: 5, end: 9 })
    expect(plan.content).toBe('keep IN tail')
  })

  it('moves a selection that sits inside the properties block, and says so', () => {
    const currentContent = '---\na: 1\n---\nBody'
    const plan = planned({ currentContent, rendered: 'Text', selection: { start: 2, end: 2 } })
    expect(plan.body.range).toEqual({ start: 13, end: 13 })
    expect(plan.notes).toEqual([{ kind: 'insertion-clamped', requested: 2, used: 13 }])
  })

  it('clamps a selection past the end of the note', () => {
    const plan = planned({ currentContent: 'short', rendered: 'X', selection: { start: 40, end: 40 } })
    expect(plan.body.range).toEqual({ start: 5, end: 5 })
    expect(plan.notes).toEqual([{ kind: 'insertion-clamped', requested: 40, used: 5 }])
  })
})

describe('planWrite overwrite', () => {
  it('replaces the whole note, properties included, without merging', () => {
    const currentContent = '---\nold: 1\ntags: [keep]\n---\nOld body\n'
    const plan = planned({ mode: OVERWRITE_ACTIVE, currentContent, rendered: '---\nnew: 2\n---\nNew body\n' })
    expect(plan.kind).toBe('replace')
    expect(plan.content).toBe('---\nnew: 2\n---\nNew body\n')
    expect(plan.frontmatter).toBeNull()
    expect(plan.body.range).toEqual({ start: 0, end: currentContent.length })
  })

  it('replaces another note the same way', () => {
    const plan = planned({ mode: OVERWRITE_FILE, path: 'Notes/Other.md', currentContent: 'Old', rendered: 'New' })
    expect(plan.content).toBe('New')
  })
})

describe('cursor markers', () => {
  it('lands each caret where the engine would, on a text with no block', () => {
    const rendered = `a${MARKER}b${MARKER}c`
    const plan = planned({ mode: CREATE, path: 'Notes/N.md', rendered })
    const jump = jumpToNextCursor(rendered)
    if (!jump) throw new Error('the engine found no marker to jump to')
    expect(plan.content).toBe(jump.text)
    // The engine reports line and column; the plan reports offsets. They agree because this text is one line.
    expect(plan.carets).toEqual(jump.positions.map((position) => position.ch))
  })

  it('takes only the first bare marker of a run, as upstream does', () => {
    const bare = '<% tp.file.cursor() %>'
    const plan = planned({ mode: CREATE, path: 'Notes/N.md', rendered: `${bare}|${bare}` })
    expect(plan.content).toBe(`|${bare}`)
    expect(plan.carets).toEqual([0])
  })

  it('jumps the lowest order first, including a negative one', () => {
    const two = '<% tp.file.cursor(2) %>'
    const minus = '<% tp.file.cursor(-1) %>'
    const plan = planned({ mode: CREATE, path: 'Notes/N.md', rendered: `x${two}y${minus}z` })
    expect(plan.content).toBe(`x${two}yz`)
    expect(plan.carets).toEqual([`x${two}y`.length])
  })

  it('takes every marker of one order, in source order', () => {
    const rendered = `${MARKER}${MARKER}`
    const plan = planned({ mode: CREATE, path: 'Notes/N.md', rendered })
    expect(plan.content).toBe('')
    expect(plan.carets).toEqual([0, 0])
  })

  it('does not jump a marker that sits inside the properties block', () => {
    const rendered = `---\ncursor: ${MARKER}\n---\nBody`
    const plan = planned({ mode: CREATE, path: 'Notes/N.md', rendered })
    expect(plan.content).toBe(rendered)
    expect(plan.carets).toEqual([])
  })

  it('lands the caret after a merged block has shifted the offsets', () => {
    const currentContent = '---\na: 1\n---\nBody'
    const plan = planned({ currentContent, rendered: `---\nb: 2\n---\nX${MARKER}Y` })
    expect(plan.content).toBe('---\na: 1\nb: 2\n---\nBodyXY')
    expect(plan.carets).toEqual(['---\na: 1\nb: 2\n---\nBodyX'.length])
  })
})

describe('plan shape', () => {
  it('describes one document, twice', () => {
    const cases: Partial<WriteRequest>[] = [
      { mode: CREATE, path: 'Notes/N.md', rendered: `---\na: 1\n---\nB${MARKER}` },
      { currentContent: '---\nkeep: 1\n---\nBody', rendered: '---\nkeep: 2\nx: [1]\n---\nTail' },
      { currentContent: '---\nbroken: [#x]\n---\nBody', rendered: '---\na: 1\n---\nTail' },
      { currentContent: 'Body', rendered: `---\na: 1\n---\nT${MARKER}ail` },
      { mode: OVERWRITE_ACTIVE, currentContent: 'Old', rendered: '---\na: 1\n---\nNew' },
      { mode: STARTUP, rendered: 'ignored' },
    ]
    for (const overrides of cases) {
      const request = asked(overrides)
      const result = planWrite(request)
      if (!result.ok) throw new Error(`refused: ${result.code} ${result.detail}`)
      const plan = result.plan
      const current = request.currentContent ?? ''
      expect(rebuild(current, plan), `${plan.kind} rebuild`).toBe(plan.content)
      expect(applyInOneTransaction(current, plan), `${plan.kind} transaction`).toBe(plan.content)
      for (const offset of plan.carets) {
        expect(offset).toBeGreaterThanOrEqual(0)
        expect(offset).toBeLessThanOrEqual(plan.content.length)
      }
    }
  })
})

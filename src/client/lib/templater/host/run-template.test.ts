import { describe, expect, it } from 'vitest'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import { runNoteRef } from '../context/file-wrapper'
import { groupCursorMarkers } from '../engine/cursor-markers'
import { DEFAULT_RUN_DEADLINE_MS, MAX_OUTPUT_CHARS } from '../limits'
import type { ProgramSource, TemplateRunContext } from '../protocol'
import { planWrite } from './write'
import type { NestedRenderOutcome, PageHostDeps, PageHostFailure } from './page-host'
import { runTemplateOnNote, type RunTemplateFailure, type RunTemplateInput, type RunTemplatePorts } from './run-template'

/**
 * The orchestration is the only place the templater modules are read in order, so these cases are about the
 * order: a note that is created already carrying its text, a plan that lands against the revision it was
 * measured against, a caret group that reaches the editor as one request, and a refusal that leaves the
 * store untouched.
 *
 * The engine is the real one — templates are compiled with `compileTemplate`, counted with
 * `groupCursorMarkers` and planned with `planWrite` — and only the interpreter is faked, by handing the
 * template text back. A template whose only tags are `tp.file.cursor(n)` therefore renders as the text the
 * reader would have got, which keeps these tests about the pipeline rather than about the sandbox.
 */

const STARTED_AT = 1_700_000_000_000
/** `<% tp.file.cursor(1) %>`, the marker a template leaves for one caret. */
const MARKER = '<% tp.file.cursor(1) %>'

const NOTES_FOLDER: Folder = {
  id: 'folder-notes',
  parentId: null,
  name: 'Notes',
  icon: null,
  color: null,
  position: 0,
  createdAt: STARTED_AT,
  updatedAt: STARTED_AT,
}

function noteRow(id: string, title: string, content: string, folderId: string | null = null, rev = 1): Note {
  return {
    id,
    title,
    excerpt: '',
    content,
    folderId,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 1,
    charCount: content.length,
    rev,
    position: 0,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    deletedAt: null,
  }
}

function templateRow(id: string, name: string, content: string): NoteTemplate {
  return {
    id,
    categoryId: null,
    name,
    description: '',
    content,
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  }
}

/** The rows one test's run reads: the note the template is applied to, and one filed away. */
function rows(): Note[] {
  return [noteRow('note-1', 'Target', 'head\n'), noteRow('note-2', 'Filed', 'other body\n', NOTES_FOLDER.id)]
}

function asked(overrides: Partial<RunTemplateInput> = {}): RunTemplateInput {
  const [target] = rows()
  return {
    mode: 'append-active',
    template: { kind: 'source', content: 'tail' },
    target,
    active: target,
    notes: rows(),
    folders: [NOTES_FOLDER],
    templates: [],
    capabilities: 'local',
    locale: 'en-US',
    startedAt: STARTED_AT,
    selection: { from: 5, to: 5, text: 'tail' },
    startedAtRev: 1,
    ...overrides,
  }
}

interface Fake {
  ports: RunTemplatePorts
  /** Every port this module reached, in the order it reached them: the evidence behind "wrote nothing". */
  calls: string[]
  /** What the fake store holds, which is how a create that failed is shown to have left no row. */
  stored: Map<string, Note>
  writes: { id: string; content: string; expected: Note }[]
  creates: { title: string; content: string; folderId: string | null }[]
  carets: { noteId: string; carets: number[] }[]
  opened: string[]
  /** The arguments the door was handed, so a test can read the context the run started with. */
  renders: { program: ProgramSource; context: TemplateRunContext; deadlineMs: number }[]
  /** The context each destination request carried — the same object the render was started with. */
  targetContexts: TemplateRunContext[]
  /** What the next render answers with; the default hands the template text back. */
  outcome: NestedRenderOutcome | null
  writeRefusal: PageHostFailure | null
  createRefusal: PageHostFailure | null
  targetRefusal: RunTemplateFailure | null
  openAnswer: boolean
}

/** The same object on both sides of the fake: the tests write these fields, the ports read them. */
type FakeScript = Omit<Fake, 'ports'>

function fakes(): Fake {
  const script: FakeScript = {
    calls: [],
    stored: new Map(),
    writes: [],
    creates: [],
    carets: [],
    opened: [],
    renders: [],
    targetContexts: [],
    outcome: null,
    writeRefusal: null,
    createRefusal: null,
    targetRefusal: null,
    openAnswer: true,
  }
  const notes: Pick<PageHostDeps['notes'], 'write' | 'create'> = {
    async write(id, content, expected) {
      script.calls.push('notes.write')
      script.writes.push({ id, content, expected })
      if (script.writeRefusal !== null) return { ok: false, reason: script.writeRefusal }
      const row = noteRow(id, expected.title, content, expected.folderId, expected.rev + 1)
      script.stored.set(id, row)
      return { ok: true, note: row }
    },
    async create(input) {
      script.calls.push('notes.create')
      script.creates.push(input)
      // A refusal stores nothing, which is the state the "leaves no row behind" case measures.
      if (script.createRefusal !== null) return { ok: false, reason: script.createRefusal }
      const row = noteRow(`created-${script.creates.length}`, input.title, input.content, input.folderId)
      script.stored.set(row.id, row)
      return { ok: true, note: row }
    },
  }
  const ports: RunTemplatePorts = {
    async render({ program, context, deadlineMs }) {
      script.calls.push('render')
      script.renders.push({ program, context, deadlineMs })
      return script.outcome ?? { ok: true, output: program.template, durationMs: 1 }
    },
    notes,
    editor: {
      async open(id) {
        script.calls.push('editor.open')
        script.opened.push(id)
        return script.openAnswer
      },
    },
    async createTarget(context, path) {
      // The page host resolves a path against the run that started, so a caller that hands over somebody
      // else's context — or an id alone, which is what it used to hand over — would be refused in production.
      // Measured in a real browser: after the render released the run, the create came back `render-failed`.
      if (!context.runId.startsWith('run-')) throw new Error(`createTarget was asked for the wrong run: ${context.runId}`)
      script.targetContexts.push(context)
      script.calls.push('createTarget')
      if (script.targetRefusal !== null) return script.targetRefusal
      const segments = path.split('/')
      const name = segments.pop() ?? ''
      return { ok: true, title: name.replace(/\.md$/, ''), folderId: segments.length > 0 ? NOTES_FOLDER.id : null }
    },
    requestCarets(noteId, carets) {
      script.calls.push('requestCarets')
      script.carets.push({ noteId, carets })
    },
  }
  return Object.assign(script, { ports })
}

/** The run's answer, or a failing test that says which code refused it. */
async function applied(input: RunTemplateInput, fake = fakes()) {
  const result = await runTemplateOnNote(input, fake.ports)
  if (!result.ok) throw new Error(`refused: ${result.code} ${result.detail}`)
  return { result, fake }
}

/** The run's refusal, or a failing test that says what it applied instead. */
async function refused(input: RunTemplateInput, fake = fakes()) {
  const result = await runTemplateOnNote(input, fake.ports)
  if (result.ok) throw new Error(`applied a ${result.kind} instead of refusing`)
  return { failure: result, fake }
}

describe('runTemplateOnNote create-new', () => {
  it('creates one row that already carries the finished document', async () => {
    const { result, fake } = await applied(asked({
      mode: 'create-new',
      template: { kind: 'source', content: '# Daily\n\nbody' },
      target: null,
      active: null,
      selection: null,
      path: 'Notes/Daily.md',
    }))
    expect(result.kind).toBe('create')
    expect(result.noteId).toBe('created-1')
    expect(result.caretNoteId).toBeNull()
    expect(fake.creates).toEqual([{ title: 'Daily', content: '# Daily\n\nbody', folderId: NOTES_FOLDER.id }])
    // One write, not two: there is no second call that could fail against an empty note.
    expect(fake.calls).toEqual(['render', 'createTarget', 'notes.create', 'editor.open'])
    expect(fake.writes).toEqual([])
    // The destination is asked for with the context this run was rendered under, not with an id the page has
    // already released — that release is what made a real browser refuse the reader's own create.
    expect(fake.targetContexts).toEqual([fake.renders[0]!.context])
  })

  it('asks the workspace to show the created note and land its carets there', async () => {
    const { result, fake } = await applied(asked({
      mode: 'create-new',
      template: { kind: 'source', content: `a${MARKER}b${MARKER}c` },
      target: null,
      active: null,
      selection: null,
      path: 'Notes/Twin.md',
    }))
    expect(result.carets).toEqual([1, 2])
    expect(result.caretNoteId).toBe(result.noteId)
    expect(fake.carets).toEqual([{ noteId: result.noteId, carets: [1, 2] }])
    expect(fake.stored.get(result.noteId!)!.content).toBe('abc')
  })

  it('does not ask an editor for carets when no pane took the note', async () => {
    const fake = fakes()
    fake.openAnswer = false
    const { result } = await applied(asked({
      mode: 'create-new',
      template: { kind: 'source', content: `body ${MARKER}` },
      target: null,
      active: null,
      selection: null,
      path: 'Notes/Hidden.md',
    }), fake)
    expect(result.noteId).toBe('created-1')
    expect(result.caretNoteId).toBeNull()
    expect(fake.carets).toEqual([])
  })

  it('leaves no row behind when the store refuses the create', async () => {
    const fake = fakes()
    fake.createRefusal = 'conflict'
    const { failure } = await refused(asked({
      mode: 'create-new',
      template: { kind: 'source', content: `body ${MARKER}` },
      target: null,
      active: null,
      selection: null,
      path: 'Notes/Taken.md',
    }), fake)
    expect(failure).toEqual({ ok: false, code: 'note-conflict', detail: 'Notes/Taken.md' })
    expect(fake.stored.size).toBe(0)
    expect(fake.opened).toEqual([])
    expect(fake.carets).toEqual([])
    expect(fake.calls).toEqual(['render', 'createTarget', 'notes.create'])
  })

  it('passes a destination refusal straight through, without reaching the store', async () => {
    const fake = fakes()
    fake.targetRefusal = { ok: false, code: 'path-invalid', detail: 'reserved:Templates' }
    const { failure } = await refused(asked({
      mode: 'create-new',
      target: null,
      active: null,
      selection: null,
      // A path `planWrite` accepts — and one the data layer says is not a place a note lives, because the
      // library is projected onto that folder rather than stored in it.
      path: 'Templates/New.md',
    }), fake)
    expect(failure).toEqual({ ok: false, code: 'path-invalid', detail: 'reserved:Templates' })
    expect(fake.calls).toEqual(['render', 'createTarget'])
    expect(fake.creates).toEqual([])
    expect(fake.stored.size).toBe(0)
  })

  it('refuses a create the caller gave no destination for, before paying for a render', async () => {
    const { failure, fake } = await refused(asked({ mode: 'create-new', target: null, active: null, selection: null }))
    expect(failure).toEqual({ ok: false, code: 'path-invalid', detail: 'empty' })
    expect(fake.calls).toEqual([])
  })

  it('refuses to create over a note that already has text, and writes nothing', async () => {
    const fake = fakes()
    const standing = noteRow('note-9', 'Taken', 'already written\n', NOTES_FOLDER.id)
    const { failure } = await refused(asked({
      mode: 'create-new',
      target: standing,
      active: null,
      selection: null,
      path: 'Notes/Taken.md',
    }), fake)
    expect(failure).toEqual({ ok: false, code: 'note-conflict', detail: 'note-9' })
    expect(fake.creates).toEqual([])
    expect(fake.stored.size).toBe(0)
  })
})

describe('runTemplateOnNote append-active and overwrite', () => {
  it('inserts the rendered body at the selection the reader had', async () => {
    const { result, fake } = await applied(asked({ template: { kind: 'source', content: 'tail' } }))
    expect(result.kind).toBe('insert')
    expect(result.noteId).toBe('note-1')
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0]!.content).toBe('head\ntail')
    // The guard the store compares is the row the plan was measured against, not a copy read afterwards.
    expect(fake.writes[0]!.expected.content).toBe('head\n')
    expect(fake.writes[0]!.expected.rev).toBe(1)
  })

  it('lands a caret group as one request when the note is the one on screen', async () => {
    const { result, fake } = await applied(asked({ template: { kind: 'source', content: `x${MARKER}y${MARKER}` } }))
    expect(result.carets).toHaveLength(2)
    expect(result.caretNoteId).toBe('note-1')
    expect(fake.carets).toEqual([{ noteId: 'note-1', carets: result.carets }])
  })

  it('overwrites the active note whole, without merging its properties', async () => {
    const rendered = '---\nfrom: template\n---\nnew body'
    const { result, fake } = await applied(asked({ mode: 'overwrite-active', template: { kind: 'source', content: rendered } }))
    expect(result.kind).toBe('replace')
    expect(fake.writes[0]!.content).toBe(rendered)
  })

  it('writes a note nobody has open and asks no editor to move a caret in it', async () => {
    const [, filed] = rows()
    const { result, fake } = await applied(asked({
      mode: 'overwrite-file',
      target: filed,
      template: { kind: 'source', content: `replaced ${MARKER}` },
    }))
    expect(result.kind).toBe('replace')
    expect(fake.writes[0]!.id).toBe('note-2')
    expect(result.carets).toHaveLength(1)
    expect(result.caretNoteId).toBeNull()
    expect(fake.carets).toEqual([])
  })

  it('surfaces the store\'s conflict and asks for no carets', async () => {
    const fake = fakes()
    fake.writeRefusal = 'conflict'
    const { failure } = await refused(asked({ template: { kind: 'source', content: `tail ${MARKER}` } }), fake)
    expect(failure).toEqual({ ok: false, code: 'note-conflict', detail: 'note-1' })
    expect(fake.carets).toEqual([])
    expect(fake.stored.has('note-1')).toBe(false)
  })

  it('refuses a note that moved while the template ran, without reaching the store', async () => {
    const moved = noteRow('note-2', 'Filed', 'someone else wrote this\n', NOTES_FOLDER.id, 7)
    const { failure, fake } = await refused(asked({ mode: 'overwrite-file', target: moved, startedAtRev: 4 }))
    expect(failure).toEqual({ ok: false, code: 'note-conflict', detail: 'rev:4->7' })
    expect(fake.calls).toEqual(['render'])
    expect(fake.writes).toEqual([])
  })

  it('refuses a note the caller has no row for, before paying for a render', async () => {
    const { failure, fake } = await refused(asked({ mode: 'overwrite-file', target: null }))
    expect(failure).toEqual({ ok: false, code: 'note-not-found', detail: 'overwrite-file' })
    expect(fake.calls).toEqual([])
  })

  it('answers a closed note\'s missing row as the store reads it', async () => {
    const fake = fakes()
    fake.writeRefusal = 'not-found'
    const { failure } = await refused(asked(), fake)
    expect(failure).toEqual({ ok: false, code: 'note-not-found', detail: 'note-1' })
  })
})

describe('runTemplateOnNote startup', () => {
  it('writes nothing and says the output was discarded', async () => {
    const fake = fakes()
    const { result } = await applied(asked({
      mode: 'startup',
      template: { kind: 'source', content: `startup text ${MARKER}` },
      capabilities: 'startup',
    }), fake)
    expect(result.kind).toBe('discard')
    expect(result.noteId).toBeNull()
    expect(result.carets).toEqual([])
    expect(result.caretNoteId).toBeNull()
    expect(result.notices).toEqual([{ kind: 'output-discarded' }])
    expect(fake.calls).toEqual(['render'])
    expect(fake.stored.size).toBe(0)
  })
})

describe('runTemplateOnNote refusals', () => {
  it('returns the parser\'s own code and position for a template that does not compile', async () => {
    const fake = fakes()
    const { failure } = await refused(asked({ template: { kind: 'source', content: '<%* if (x) {' } }), fake)
    expect(failure).toEqual({ ok: false, code: 'parse-unclosed', detail: 'line:1:1' })
    expect(fake.calls).toEqual([])
  })

  it('returns an invalid command as its own code', async () => {
    const { failure } = await refused(asked({ template: { kind: 'source', content: '<%~ nope %>' } }))
    expect(failure).toEqual({ ok: false, code: 'parse-invalid', detail: 'line:1:1' })
  })

  it('returns the code the run reported, and writes nothing', async () => {
    const fake = fakes()
    fake.outcome = { ok: false, code: 'sandbox-timeout', detail: '2000' }
    const { failure } = await refused(asked(), fake)
    expect(failure).toEqual({ ok: false, code: 'sandbox-timeout', detail: '2000' })
    expect(fake.calls).toEqual(['render'])
  })

  it('answers a code it does not know with the fallback, keeping the measurement', async () => {
    const fake = fakes()
    fake.outcome = { ok: false, code: 'worker-vanished', detail: 'post' }
    const { failure } = await refused(asked(), fake)
    expect(failure).toEqual({ ok: false, code: 'render-failed', detail: 'post' })
  })

  it('returns the plan\'s refusal for an output the product cannot store', async () => {
    const fake = fakes()
    fake.outcome = { ok: true, output: 'x'.repeat(MAX_OUTPUT_CHARS + 1), durationMs: 9 }
    const { failure } = await refused(asked(), fake)
    expect(failure).toEqual({ ok: false, code: 'template-output-too-large', detail: `chars:${MAX_OUTPUT_CHARS + 1}` })
    expect(fake.calls).toEqual(['render'])
  })

  it('returns a refusal about the note the run tried to read', async () => {
    const fake = fakes()
    fake.outcome = { ok: false, code: 'note-not-found', detail: 'Notes/Gone.md' }
    const { failure } = await refused(asked(), fake)
    expect(failure).toEqual({ ok: false, code: 'note-not-found', detail: 'Notes/Gone.md' })
    expect(fake.writes).toEqual([])
  })
})

describe('runTemplateOnNote hand-offs', () => {
  it('renders a library template as its own row, indexed where the gallery puts it', async () => {
    const fake = fakes()
    const row = templateRow('t-daily', 'Daily', 'daily body')
    await applied(asked({ template: { kind: 'library', row } }), fake)
    const { program, context } = fake.renders[0]!
    expect(context.template).toEqual({ id: 't-daily', name: 'Daily', content: 'daily body' })
    expect(context.index.some((entry) => entry.path === 'Templates/Daily.md')).toBe(true)
    expect(program.template).toBe('daily body')
  })

  it('starts the run with what the reader was looking at', async () => {
    const fake = fakes()
    const target = noteRow('note-1', 'Target', 'head\n')
    const active = noteRow('note-3', 'Front', 'front body\n')
    await applied(asked({ target, active, selection: { from: 2, to: 6, text: 'ad' } }), fake)
    const context = fake.renders[0]!.context
    expect(context.mode).toBe('append-active')
    expect(context.locale).toBe('en-US')
    expect(context.startedAt).toBe(STARTED_AT)
    expect(context.target!.id).toBe('note-1')
    expect(context.active!.id).toBe('note-3')
    expect(context.selection).toBe('ad')
    expect(context.capabilities).toBe('local')
  })

  it('gives the run the engine\'s own deadline unless the caller set one', async () => {
    const { fake } = await applied(asked())
    expect(fake.renders[0]!.deadlineMs).toBe(DEFAULT_RUN_DEADLINE_MS)
    const budgeted = fakes()
    await applied(asked({ deadlineMs: 900 }), budgeted)
    expect(budgeted.renders[0]!.deadlineMs).toBe(900)
  })

  it('applies exactly the plan `planWrite` reports for the same run, notices and all', async () => {
    const rendered = '---\ntags: [#test]\n---\nBody'
    const target = noteRow('note-1', 'Target', 'head\n')
    const reference = planWrite({
      mode: 'append-active',
      rendered,
      currentContent: target.content,
      cursorGroups: groupCursorMarkers(rendered),
      target: runNoteRef(target),
      selection: { start: 5, end: 5 },
      startedAtRev: 1,
      currentRev: 1,
    })
    if (!reference.ok) throw new Error(`the hand-built plan refused: ${reference.code} ${reference.detail}`)
    const { result, fake } = await applied(asked({ template: { kind: 'source', content: rendered } }))
    expect(fake.writes[0]!.content).toBe(reference.plan.content)
    expect(result.carets).toEqual(reference.plan.carets)
    expect(result.notices).toEqual(reference.plan.notes)
    expect(result.notices.map((notice) => notice.kind)).toEqual(['template-frontmatter-invalid'])
  })

  it('reports a selection the note could not hold as the plan\'s own clamp', async () => {
    const { result } = await applied(asked({ selection: { from: 99, to: 99, text: '' } }))
    expect(result.notices).toEqual([{ kind: 'insertion-clamped', requested: 99, used: 5 }])
  })

  it('says nothing extra about a run that needed no comment', async () => {
    const { result } = await applied(asked({ template: { kind: 'source', content: 'plain' } }))
    expect(result.notices).toEqual([])
  })
})

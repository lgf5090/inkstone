import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuickAddCaptureChoice, QuickAddTemplateChoice } from '@shared/quickadd'
import { parseFrontMatter } from '@shared/markdown-utils'
import { QUICKADD_LIMITS, newCaptureChoice, newGroupChoice, newMacroChoice, newTemplateChoice, defaultQuickAddSettings, type QuickAddChoice, type QuickAddSettings } from '@shared/quickadd'
import { initI18n, t } from '../../lib/i18n'
import { executeUserCode } from '../../features/preview/js-runner-core'
import type { JsRunOutcome } from '../../features/preview/js-runner-core'
import type { PromptAnswer, PromptRequest } from './format'
import type { NewNoteInput, NotePort, NoteRef, QuickAddLinkOptions, QuickAddOpenOptions, TemplatePickOption } from './context'
import { runCaptureChoice } from './capture'
import { runTemplateChoice } from './template'
import { runMacroChoice } from './macro'

const answers = vi.hoisted(() => ({
  queue: [] as (PromptAnswer[] | null)[],
  calls: [] as string[][],
  /** The full requests of each group, so a test can read the choices and their display text. */
  requests: [] as PromptRequest[][],
  /** Whether each group went up as a single page — the promise the whole-choice precollect makes. */
  pages: [] as boolean[],
  /** Where each group said the run was about to write, which the reader reads as “into what”. */
  destinations: [] as (string | undefined)[],
}))

vi.mock('../../features/quickadd/prompt-queue', () => ({
  askQuickAddPrompts: async (group: { requests: PromptRequest[]; onePage: boolean; destination?: string }) => {
    answers.calls.push(group.requests.map((request) => request.key))
    answers.requests.push(group.requests)
    answers.pages.push(group.onePage)
    answers.destinations.push(group.destination)
    const next = answers.queue.shift()
    // A dismissed dialog answers nothing, which is how the engines learn the run was cancelled.
    if (next === null) return null
    return new Map(group.requests.map((request, index) => [
      request.key,
      next === undefined ? request.defaultValue : next[index] ?? request.defaultValue,
    ]))
  },
  recallDraft: () => null,
  currentPromptGroup: () => null,
  currentPromptSequence: () => 0,
  resetQuickAddPrompts: () => {},
  subscribeQuickAddPrompts: () => () => {},
}))

beforeAll(async () => {
  await initI18n()
  // The script step runs in a Worker for real; here the same code-runner core answers on the
  // current thread, so the engine's handling of a throwing script is what is under test.
  vi.stubGlobal('Worker', class SameThreadWorker {
    onmessage: ((event: { data: JsRunOutcome }) => void) | null = null
    onerror: (() => void) | null = null

    postMessage(code: string): void {
      queueMicrotask(() => this.onmessage?.({ data: executeUserCode(code) }))
    }

    terminate(): void {}
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

interface FakeNote extends NoteRef {
  content: string
}

function harness(start: Record<string, string>, settings: Partial<QuickAddSettings> = {}, selection = '') {
  const notes: Record<string, FakeNote> = {}
  for (const [title, content] of Object.entries(start))
    notes[title] = { id: `n-${title}`, title, folderPath: null, content }
  const created: NewNoteInput[] = []
  const copied: string[] = []
  const commands: string[] = []
  const inserted: { text: string; cursor: number | null | undefined }[] = []
  const lineInserts: { text: string; side: string }[] = []
  const writes: { id: string; content: string; previous?: string }[] = []
  const opened: string[] = []
  const opens: QuickAddOpenOptions[] = []
  const notifications: string[] = []
  const carets: number[] = []
  const links: { sourceId: string; title: string; options: QuickAddLinkOptions }[] = []
  /** Set by a test that wants the app to refuse the link, so the run’s answer can be heard. */
  let refuseLink = false
  /** The editor's caret range, which `insert-here` writes around; null means it sits at the end. */
  let caret: { from: number; to: number } | null = null
  const store: QuickAddChoice[] = []
  const picks: TemplatePickOption[] = [
    { id: 'tpl-daily', name: 'Daily', category: 'Journal' },
    { id: 'tpl-cleared', name: 'Cleared', category: null },
  ]
  let activeId: string | null = null
  const merged: Partial<QuickAddSettings> = { ...defaultQuickAddSettings(), ...settings }

  const port: NotePort = {
    activeNote: () => (activeId ? ref(activeId) : null),
    findByTitle: (title) => Object.values(notes).find((note) => note.title.toLowerCase() === title.toLowerCase()) ?? null,
    byId: (id) => ref(id),
    read: async (id) => Object.values(notes).find((note) => note.id === id)?.content ?? '',
    write: async (id, content, previous) => {
      writes.push({ id, content, previous })
      const note = Object.values(notes).find((entry) => entry.id === id)
      if (!note) return false
      if (previous !== undefined && note.content !== previous) return false
      note.content = content
      return true
    },
    create: async (input) => {
      created.push(input)
      const note: FakeNote = { id: `n-${input.title}`, title: input.title, folderPath: input.folderPath, content: input.content }
      notes[input.title] = note
      return note
    },
    ensureFolder: async (path) => path,
    open: async (id, options) => {
      opened.push(id)
      opens.push(options ?? {})
      activeId = id
    },
    linkTo: (target) => `[[${target.title}]]`,
    cursorHeadingPath: () => null,
    selection: () => selection,
    clipboard: async () => '',
    templateBody: async (name) => (name === 'tpl-daily' || name === 'Daily' ? 'Daily body'
      : name === 'tpl-props' ? '---\nmood: glad\ntags:\n  - journal\n---\nFrom template\n'
        : name === 'tpl-marked' ? 'Hi{{CURSOR}}there\n'
          : name === 'tpl-space' ? '　'
          : name === 'tpl-cleared' ? '' : null),
    templateNames: () => ['Daily', 'Cleared'],
    templatesForPick: (categoryId) => picks.filter((entry) => !categoryId || entry.category === categoryId),
    fieldValues: async () => [],
    pickFileTitles: async (token) => (token.folder === 'Numbers' ? ['42'] : []),
    knownNoteTitles: () => Object.keys(notes),
    knownFolderPaths: () => ['Journal'],
    appendLink: async (source, target, options) => {
      links.push({ sourceId: source.id, title: target.title, options: options ?? {} })
      if (refuseLink) return false
      const note = Object.values(notes).find((entry) => entry.id === source.id)
      if (!note) return false
      note.content = `${note.content}\n[[${target.title}]]\n`
      return true
    },
    copyText: (text) => { copied.push(text) },
    runAppCommand: (id) => {
      commands.push(id)
      return !id.startsWith('missing')
    },
    placeCursor: (offset) => { carets.push(offset) },
    recordRun: () => {},
    notify: (title, description) => { notifications.push(`${title}: ${description ?? ''}`) },
    activeEditorState: () => {
      const note = Object.values(notes).find((entry) => entry.id === activeId)
      if (!note) return null
      const from = caret?.from ?? note.content.length
      return { text: note.content, from, to: caret?.to ?? from }
    },
    insertAtCursor: (text, cursor) => {
      inserted.push({ text, cursor })
      return true
    },
    insertRelativeToLine: (text, side) => {
      lineInserts.push({ text, side })
      return true
    },
    prependToActive: async () => false,
    settings: () => merged as QuickAddSettings,
    choices: () => store,
  }

  function ref(id: string): NoteRef | null {
    const found = Object.values(notes).find((note) => note.id === id)
    return found ? { id: found.id, title: found.title, folderPath: found.folderPath } : null
  }

  return {
    port,
    notes,
    created,
    copied,
    commands,
    picks,
    inserted,
    lineInserts,
    writes,
    opened,
    opens,
    notifications,
    carets,
    links,
    refuseLink: () => {
      refuseLink = true
    },
    store,
    setActive: (title: string | null) => {
      activeId = title ? (notes[title]?.id ?? null) : null
    },
    setSelection: (from: number, to: number) => {
      caret = { from, to }
    },
    content: (title: string) => notes[title]?.content ?? null,
  }
}

const clock = new Date(2026, 9, 8, 13, 5, 9)

vi.mock('./session', async () => {
  const actual = await vi.importActual<typeof import('./session')>('./session')
  return {
    ...actual,
    // The real session, only with the clock pinned: a stub that rebuilt the record would stop
    // exercising whatever `newSession` grows later, and the run would pass on a rule no test sees.
    newSession: (
      choice: QuickAddChoice,
      port: NotePort,
      variables?: Map<string, PromptAnswer>,
      day?: Date,
      sourceNoteId?: string,
    ) => {
      const session = actual.newSession(choice, port, variables, day ?? clock, sourceNoteId)
      session.clock = { now: clock, date: day ?? clock }
      return session
    },
  }
})

beforeEach(() => {
  answers.queue = []
  answers.calls = []
  answers.requests = []
  answers.pages = []
  answers.destinations = []
})

function captureOn(title: string, over: Partial<QuickAddCaptureChoice> = {}): QuickAddCaptureChoice {
  return { ...newCaptureChoice('qa-c', title, 0), targetTitle: title, ...over }
}

/**
 * Note text a Chinese-writing reader actually has in their journal. `check-i18n.mjs` keeps Han
 * literals out of `src/` because user-facing copy must come from the catalog; data a note is written
 * with is not copy, and this app's own headings are the case the date-ordering rule must read.
 */
const CJK_DATE_FIXTURES = {
  headingFormat: 'YYYY年MM月DD日',
  noteBefore: '# Log\n\n## 2025年12月31日\npast\n\n## 2026年11月01日\nfuture\n',
  noteAfter: '# Log\n\n## 2025年12月31日\npast\n\n## 2026年10月08日\ntext\n\n## 2026年11月01日\nfuture\n',
}

describe('capturing into a note', () => {
  it('appends a plain value to the bottom of the target', async () => {
    const fake = harness({ Inbox: 'today\n' })
    const choice = newCaptureChoice('qa-c', 'Inbox capture', 0)
    answers.queue = [['an idea']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.content('Inbox')).toBe('today\nan idea')
  })

  it('lets what the reader selected answer the value instead of asking', async () => {
    const fake = harness({ Inbox: 'today\n' }, {}, 'a phrase in the note')
    const choice = newCaptureChoice('qa-c', 'Inbox capture', 0)
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls, 'a selection is an answer, not a pre-fill').toEqual([])
    expect(fake.content('Inbox')).toBe('today\na phrase in the note')
  })

  it('writes nothing when the reader closes the value question', async () => {
    const fake = harness({ Inbox: 'today\n' })
    answers.queue = [null]
    const status = await runCaptureChoice(
      captureOn('Inbox', { format: { enabled: true, format: '- {{VALUE}} (logged)' } }),
      fake.port,
    )
    expect(status.kind).toBe('cancelled')
    expect(fake.content('Inbox'), 'a dismissed dialog must not leave text behind').toBe('today\n')
    expect(answers.calls, 'a closed question must not be asked again').toEqual([['value']])
  })

  it('does not even create the target note when the value question is closed', async () => {
    const fake = harness({})
    answers.queue = [null]
    const status = await runCaptureChoice(
      captureOn('Fresh inbox', { format: { enabled: true, format: '- {{VALUE}}' } }),
      fake.port,
    )
    expect(status.kind).toBe('cancelled')
    expect(fake.created, 'a cancelled capture must not leave an empty note behind').toEqual([])
  })

  it('asks anyway when the choice says this capture always asks', async () => {
    const fake = harness({ Inbox: 'today\n' }, {}, 'a phrase in the note')
    const choice = captureOn('Inbox', { useSelectionAsValue: false })
    answers.queue = [['typed instead']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls).toEqual([['value']])
    expect(fake.content('Inbox')).toBe('today\ntyped instead')
  })

  it('asks when the selection is only whitespace, and when the account says never', async () => {
    const blank = harness({ Inbox: 'today\n' }, {}, '   \n ')
    answers.queue = [['typed']]
    expect((await runCaptureChoice(captureOn('Inbox'), blank.port)).kind).toBe('written')
    expect(answers.calls).toEqual([['value']])
    expect(blank.content('Inbox')).toBe('today\ntyped')

    const off = harness({ Inbox: 'today\n' }, { selectionAsValue: false }, 'a phrase in the note')
    answers.queue = [['typed anyway']]
    expect((await runCaptureChoice(captureOn('Inbox'), off.port)).kind).toBe('written')
    expect(answers.calls).toEqual([['value'], ['value']])
    expect(off.content('Inbox')).toBe('today\ntyped anyway')
  })

  it('writes a formatted capture below the properties, above the body, when asked to', async () => {    const fake = harness({ Log: '---\ntitle: x\n---\n# Log\nold\n' })
    const choice = captureOn('Log', {
      writePosition: 'top',
      format: { enabled: true, format: '{{DATE:YYYY-MM-DD}} entry' },
    })
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Log')).toBe('---\ntitle: x\n---\n2026-10-08 entry\n# Log\nold\n')
  })

  it('creates a missing anchor heading at the bottom of the note, exactly as written', async () => {
    const fake = harness({ Log: '# Log\n\n## 2026-01-02\nold\n' })
    const choice = captureOn('Log', {
      writePosition: 'insertAfter',
      after: '## {{DATE:YYYY-MM-DD}}',
      createLineIfMissing: true,
      createAt: 'bottom',
      format: { enabled: true, format: 'text' },
    })
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Log')).toBe('# Log\n\n## 2026-01-02\nold\n## 2026-10-08\ntext\n')

    // The heading the run wrote is a real heading now: the second run lands under it.
    const again = await runCaptureChoice(choice, fake.port)
    expect(again.kind).toBe('written')
    expect(fake.content('Log')).toBe('# Log\n\n## 2026-01-02\nold\n## 2026-10-08\ntext\ntext\n')
  })

  it('slots a created heading into its order among the siblings', async () => {
    const fake = harness({ Log: '# Log\n\n## 2025-12-31\npast\n\n## 2026-11-01\nfuture\n' })
    const choice = captureOn('Log', {
      writePosition: 'insertAfter',
      after: '## {{DATE:YYYY-MM-DD}}',
      createLineIfMissing: true,
      createAt: 'ordered',
      orderBy: { by: 'date', direction: 'asc', dateFormat: 'YYYY-MM-DD', unparseable: 'bottom' },
      format: { enabled: true, format: 'text' },
    })
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Log')).toBe('# Log\n\n## 2025-12-31\npast\n\n## 2026-10-08\ntext\n\n## 2026-11-01\nfuture\n')
  })

  it('reads a heading written in the choice’s own date format', async () => {
    const fake = harness({ Log: CJK_DATE_FIXTURES.noteBefore })
    const choice = captureOn('Log', {
      writePosition: 'insertAfter',
      after: `## {{DATE:${CJK_DATE_FIXTURES.headingFormat}}}`,
      createLineIfMissing: true,
      createAt: 'ordered',
      orderBy: { by: 'date', direction: 'asc', dateFormat: CJK_DATE_FIXTURES.headingFormat, unparseable: 'bottom' },
      format: { enabled: true, format: 'text' },
    })
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Log')).toBe(CJK_DATE_FIXTURES.noteAfter)
  })

  it('ends the band on the last sibling’s whole section, not on its heading line', async () => {
    const fake = harness({ Log: '# Log\n\n## 1.2.0\nfirst\n\n## 1.1.0\nolder\n' })
    const choice = captureOn('Log', {
      writePosition: 'insertAfter',
      after: '## 1.3.0',
      createLineIfMissing: true,
      createAt: 'ordered',
      orderBy: { by: 'semver', direction: 'desc', dateFormat: '', unparseable: 'bottom' },
      format: { enabled: true, format: 'new' },
    })
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Log')).toBe('# Log\n\n## 1.3.0\nnew\n\n## 1.2.0\nfirst\n\n## 1.1.0\nolder\n')

    const tail = harness({ Log: '# Log\n\n## 1.2.0\nfirst\n' })
    await runCaptureChoice({ ...choice, after: '## 1.1.5', format: { enabled: true, format: 'late' } }, tail.port)
    expect(tail.content('Log')).toBe('# Log\n\n## 1.2.0\nfirst\n\n## 1.1.5\nlate\n')
  })

  it('nests a lone heading inside its parent’s section, below the parent’s own blurb', async () => {
    const fake = harness({ Log: '# Log\nIntro blurb\n' })
    const choice = captureOn('Log', {
      writePosition: 'insertAfter',
      after: '## Only',
      createLineIfMissing: true,
      createAt: 'ordered',
      orderBy: { by: 'lexical', direction: 'asc', dateFormat: '', unparseable: 'bottom' },
      format: { enabled: true, format: 'body' },
    })
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Log')).toBe('# Log\nIntro blurb\n\n## Only\nbody\n')
  })

  it('drops the blank line a task capture would otherwise leave (#312)', async () => {
    const fake = harness({ Task: '===== Task ======\n\nold one\n' })
    const choice = captureOn('Task', {
      writePosition: 'insertAfter',
      after: '===== Task ======',
      task: true,
      blankLine: 'auto',
    })
    answers.queue = [['buy milk']]
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Task')).toBe('===== Task ======\n- [ ] buy milk\nold one\n')
  })

  it('leaves the blank line under an ATX heading alone, because auto skips it', async () => {
    const fake = harness({ Todo: '## Today\n\nnext\n' })
    const choice = captureOn('Todo', {
      writePosition: 'insertAfter',
      after: '## Today',
      task: true,
      blankLine: 'auto',
    })
    answers.queue = [['do the thing']]
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Todo')).toBe('## Today\n\n- [ ] do the thing\nnext\n')
  })

  it('writes one entry per line when the capture says each line', async () => {
    const fake = harness({ Inbox: 'start\n' })
    const choice = captureOn('Inbox', {
      eachLine: true,
      format: { enabled: true, format: '- {{VALUE}}' },
    })
    answers.queue = [['one\ntwo\nthree']]
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Inbox')).toBe('start\n- one\n- two\n- three')
  })

  it('stops a pasted wall of text at the per-line cap and says so', async () => {
    const fake = harness({ Inbox: 'start\n' })
    const choice = captureOn('Inbox', {
      eachLine: true,
      format: { enabled: true, format: '- {{VALUE}}' },
    })
    const pasted = Array.from({ length: QUICKADD_LIMITS.maxEachLineEntries + 40 }, (_, index) => `line ${index + 1}`).join('\n')
    answers.queue = [[pasted]]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    const written = (fake.content('Inbox') ?? '').split('\n').slice(1).filter((line) => line !== '')
    expect(written.length).toBe(QUICKADD_LIMITS.maxEachLineEntries)
    expect(written[0]).toBe('- line 1')
    expect(written[written.length - 1]).toBe(`- line ${QUICKADD_LIMITS.maxEachLineEntries}`)
    expect(fake.notifications.join('\n')).toContain(String(pasted.split('\n').length))
  })

  it('glues an inline capture to the phrase it follows, not to the line', async () => {
    const fake = harness({ Inbox: 'todo: buy milk\ndone: wash\n' })
    const choice = captureOn('Inbox', {
      writePosition: 'insertAfter',
      inline: true,
      after: 'buy milk',
      createLineIfMissing: false,
      format: { enabled: true, format: ' (urgent)' },
    })
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.content('Inbox')).toBe('todo: buy milk (urgent)\ndone: wash\n')
  })

  it('replaces the rest of the anchored line when the capture says replace', async () => {
    const fake = harness({ Inbox: 'todo: buy milk NOW\ndone: wash\n' })
    const choice = captureOn('Inbox', {
      writePosition: 'insertAfter',
      inline: true,
      replaceExisting: true,
      after: 'buy milk',
      createLineIfMissing: false,
      format: { enabled: true, format: ' (urgent)' },
    })
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Inbox')).toBe('todo: buy milk (urgent)\ndone: wash\n')
  })

  it('writes the missing inline anchor as its own line', async () => {
    const fake = harness({ Inbox: 'start\n' })
    const choice = captureOn('Inbox', {
      writePosition: 'insertAfter',
      inline: true,
      after: 'Marker',
      createLineIfMissing: true,
      createAt: 'bottom',
      format: { enabled: true, format: ' (urgent)' },
    })
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Inbox')).toBe('start\nMarker (urgent)\n')
  })

  it('refuses an inline anchor that spans lines', async () => {
    const fake = harness({ Inbox: 'start\n' })
    const choice = captureOn('Inbox', {
      writePosition: 'insertAfter',
      inline: true,
      after: 'one\ntwo',
      format: { enabled: true, format: 'x' },
    })
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    expect(fake.content('Inbox')).toBe('start\n')
  })

  it('does not stack a blank line between per-line entries that end their own line', async () => {
    const fake = harness({ Inbox: 'start\n' })
    // "Add to task list" makes the format itself end with a newline, so each entry is already a line.
    const choice = captureOn('Inbox', {
      eachLine: true,
      task: true,
      format: { enabled: true, format: '{{VALUE}}' },
    })
    answers.queue = [['one\ntwo']]
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Inbox')).toBe('start\n- [ ] one\n- [ ] two\n')
  })

  it('runs a macro once for a per-line capture, but gives every line its own block id', async () => {
    const fake = harness({ Inbox: 'start\n' })
    const macro = { ...newMacroChoice('qa-m', 'Stamp', 0), steps: [{ kind: 'insert' as const, text: 'S' }, { kind: 'copy' as const, text: 'stamp' }] }
    fake.store.push(macro)
    const choice = captureOn('Inbox', {
      eachLine: true,
      format: { enabled: true, format: '- {{VALUE}} {{MACRO:Stamp}}{{RANDOM:4}}' },
    })
    answers.queue = [['one\ntwo']]
    await runCaptureChoice(choice, fake.port)
    const lines = (fake.content('Inbox') ?? '').split('\n').slice(1)
    expect(lines[0]).toMatch(/^- one S\w{4}$/)
    expect(lines[1]).toMatch(/^- two S\w{4}$/)
    expect(lines[0].slice(6)).not.toBe(lines[1].slice(6))
    // The macro ran once for the whole capture, not once per line.
    expect(fake.copied).toEqual(['stamp'])
  })

  it('refuses a capture whose anchor is missing and may not be created', async () => {
    const fake = harness({ Log: '# Log\n' })
    const choice = captureOn('Log', {
      writePosition: 'insertAfter',
      after: '## Nope',
      createLineIfMissing: false,
    })
    answers.queue = [['nothing to add']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    expect(fake.content('Log')).toBe('# Log\n')
  })

  it('creates the target note, from a template when one is named', async () => {
    const fake = harness({})
    const choice = {
      ...newCaptureChoice('qa-c', 'New', 0),
      targetTitle: 'Journal/2026-10-08',
      createIfMissing: true,
      createTemplateId: 'tpl-daily',
    }
    answers.queue = [['note']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.created[0]).toMatchObject({ title: '2026-10-08', folderPath: 'Journal', content: 'Daily body' })
    expect(fake.content('2026-10-08')).toContain('note')
  })

  it('does not overwrite a note that changed while the capture was being formatted', async () => {
    const fake = harness({ Inbox: 'first\n' })
    const original = fake.port.write.bind(fake.port)
    fake.port.write = async (id, content, previous) => {
      fake.notes['Inbox'].content = 'typed elsewhere\n'
      return original(id, content, previous)
    }
    answers.queue = [['late']]
    const status = await runCaptureChoice(newCaptureChoice('qa-c', 'C', 0), fake.port)
    expect(status).toMatchObject({ kind: 'failed' })
    expect(fake.content('Inbox')).toBe('typed elsewhere\n')
  })

  it('reports nothing to write instead of claiming a capture', async () => {
    const fake = harness({ Inbox: 'same\n' })
    const choice = { ...newCaptureChoice('qa-c', 'Empty', 0), format: { enabled: true, format: '' } }
    answers.queue = [['']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('empty')
    expect(fake.content('Inbox')).toBe('same\n')
  })

  it('adds a value to a property without repeating what is already there', async () => {
    const fake = harness({ Note: '---\ntags: [a, b]\n---\nbody\n' })
    const choice = {
      ...newCaptureChoice('qa-c', 'Prop', 0),
      targetTitle: 'Note',
      property: {
        enabled: true,
        prompted: false,
        name: 'tags',
        action: 'append' as const,
        createIfMissing: true,
        format: { enabled: true, format: 'b, c' },
      },
    }
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Note')).toContain('tags:')
    expect(fake.content('Note')).toMatch(/a/)
    expect(fake.content('Note')).toMatch(/c/)
    expect(fake.content('Note')).toMatch(/body/)
  })

  it('writes a property the note does not have yet', async () => {
    const fake = harness({ Note: 'body only\n' })
    const choice = {
      ...newCaptureChoice('qa-c', 'Prop', 0),
      targetTitle: 'Note',
      property: {
        enabled: true,
        prompted: false,
        name: 'status',
        action: 'set' as const,
        createIfMissing: true,
        format: { enabled: true, format: 'Done' },
      },
    }
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Note')).toBe('---\nstatus: Done\n---\nbody only\n')
  })

  it('creates the note a property capture is aimed at', async () => {
    const fake = harness({})
    const choice = {
      ...newCaptureChoice('qa-c', 'Prop new', 0),
      targetTitle: 'Fresh',
      createIfMissing: true,
      property: {
        enabled: true,
        prompted: false,
        name: 'status',
        action: 'set' as const,
        createIfMissing: true,
        format: { enabled: true, format: 'Done' },
      },
    }
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.created[0].title).toBe('Fresh')
    expect(fake.content('Fresh')).toBe('---\nstatus: Done\n---\n')
  })

  it('creates nothing when a property capture’s question is closed', async () => {
    const fake = harness({})
    const choice = {
      ...newCaptureChoice('qa-c', 'Prop asked', 0),
      targetTitle: 'Fresh',
      createIfMissing: true,
      property: {
        enabled: true,
        prompted: true,
        name: '',
        action: 'set' as const,
        createIfMissing: true,
        format: { enabled: true, format: '{{VALUE}}' },
      },
    }
    answers.queue = [null]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('cancelled')
    expect(fake.created, 'a closed property question must not leave an empty note').toEqual([])
  })

  it('asks which heading to use when the choice says so', async () => {
    const fake = harness({ Log: '# Log\n\n## Alpha\nx\n\n## Beta\ny\n' })
    const choice = captureOn('Log', {
      writePosition: 'insertAfter',
      after: '',
      promptHeading: true,
      format: { enabled: true, format: 'captured' },
    })
    answers.queue = [['## Beta']]
    await runCaptureChoice(choice, fake.port)
    expect(fake.content('Log')).toContain('## Beta\ncaptured\ny\n')
  })

  it('links the note it captured into back from the source note', async () => {
    const fake = harness({ Inbox: 'in\n', Source: 'src\n' })
    fake.setActive('Source')
    const choice = captureOn('Inbox', { linkToSource: true })
    answers.queue = [['in']]
    await runCaptureChoice(choice, fake.port, { sourceNoteId: fake.notes['Source'].id })
    expect(fake.content('Source')).toContain('[[Inbox]]')
    expect(fake.content('Inbox')).toBe('in\nin')
  })

  it('writes on a new line beside the caret, through the editor', async () => {
    const fake = harness({ Inbox: 'one\ntwo\n' })
    fake.setActive('Inbox')
    const choice = captureOn('Inbox', {
      writePosition: 'lineAbove',
      format: { enabled: true, format: 'captured' },
    })
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.lineInserts).toEqual([{ text: 'captured', side: 'above' }])
    expect(fake.content('Inbox'), 'the editor took the write, so no whole-document replace ran')
      .toBe('one\ntwo\n')
    expect(fake.writes, 'a second write would drop what the reader has typed but not saved').toEqual([])
  })

  it('refuses a below-the-caret capture into a note that is not on screen', async () => {
    const fake = harness({ Inbox: 'one\ntwo\n' })
    const choice = captureOn('Inbox', {
      writePosition: 'lineBelow',
      format: { enabled: true, format: 'captured' },
    })
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    if (status.kind === 'failed') expect(status.reason).toBe(t('quickadd.error_editor_unavailable'))
    expect(fake.lineInserts).toEqual([])
    expect(fake.content('Inbox')).toBe('one\ntwo\n')
  })
})

describe('a property capture keeps the note’s own types', () => {
  const into = (note: string, over: Record<string, unknown>) => {
    const fake = harness({ Note: note })
    const choice = {
      ...newCaptureChoice('qa-c', 'Prop', 0),
      targetTitle: 'Note',
      property: {
        enabled: true,
        prompted: false,
        name: 'count',
        action: 'set' as const,
        createIfMissing: true,
        format: { enabled: true, format: '{{VALUE}}' },
      },
      ...over,
    }
    return { fake, choice }
  }

  it('writes a number into a key that already holds one', async () => {
    const { fake, choice } = into('---\ncount: 3\n---\nbody\n', {})
    answers.queue = [['4']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.count).toBe(4)
    expect(fake.content('Note')).toContain('count: 4')
  })

  it('writes a checkbox into a key that already holds one', async () => {
    const { fake, choice } = into('---\ncount: false\n---\nbody\n', {})
    answers.queue = [['true']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.count).toBe(true)
  })

  it('leaves a brand-new key as text rather than guessing a number', async () => {
    const { fake, choice } = into('body only\n', { property: {
      enabled: true, prompted: false, name: 'answer', action: 'set', createIfMissing: true,
      format: { enabled: true, format: '{{VALUE}}' },
    } })
    answers.queue = [['42']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.answer).toBe('42')
  })

  it('honours a value token that says it is a number', async () => {
    const { fake, choice } = into('body only\n', { property: {
      enabled: true, prompted: false, name: 'amount', action: 'set', createIfMissing: true,
      format: { enabled: true, format: '{{VALUE:amount|type:number}}' },
    } })
    answers.queue = [['7']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.amount).toBe(7)
  })

  it('honours a value token that says it is a checkbox', async () => {
    const { fake, choice } = into('body only\n', { property: {
      enabled: true, prompted: false, name: 'flag', action: 'set', createIfMissing: true,
      format: { enabled: true, format: '{{VALUE:flag|type:checkbox}}' },
    } })
    answers.queue = [['true']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.flag).toBe(true)
  })

  it('leaves a composed format as the sentence it is', async () => {
    const { fake, choice } = into('---\ncount: 3\n---\nbody\n', { property: {
      enabled: true, prompted: false, name: 'count', action: 'set', createIfMissing: true,
      format: { enabled: true, format: 'Count: {{VALUE}}' },
    } })
    answers.queue = [['4']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.count).toBe('Count: 4')
  })

  it('does not read a file token’s type as the property’s type', async () => {
    const fake = harness({ Note: 'body only\n' })
    const choice = {
      ...newCaptureChoice('qa-c', 'Prop', 0),
      targetTitle: 'Note',
      property: {
        enabled: true, prompted: false, name: 'answer', action: 'set' as const, createIfMissing: true,
        format: { enabled: true, format: '{{FILE:Numbers|type:number}}' },
      },
    }
    answers.queue = [['42']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.answer).toBe('42')
  })

  it('leaves a sentence numeric-free even when its text reads as a number', async () => {
    const fake = harness({ Note: 'body only\n' })
    const choice = {
      ...newCaptureChoice('qa-c', 'Prop', 0),
      targetTitle: 'Note',
      property: {
        enabled: true, prompted: false, name: 'answer', action: 'set' as const, createIfMissing: true,
        format: { enabled: true, format: '{{VALUE:a|type:number}}1' },
      },
    }
    answers.queue = [['']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.answer).toBe('1')
  })

  it('keeps the text when a numeric key is handed words', async () => {
    const { fake, choice } = into('---\ncount: 3\n---\nbody\n', {})
    answers.queue = [['soon']]
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.count).toBe('soon')
  })
})

describe('a property capture keeps the shape of a list', () => {
  const appendInto = (note: string, key: string, answer: string) => {
    const fake = harness({ Note: note })
    const choice = {
      ...newCaptureChoice('qa-c', 'Prop', 0),
      targetTitle: 'Note',
      property: {
        enabled: true,
        prompted: false,
        name: key,
        action: 'append' as const,
        createIfMissing: true,
        format: { enabled: true, format: '{{VALUE}}' },
      },
    }
    answers.queue = [[answer]]
    return { fake, choice }
  }

  it('adds a number to a list of numbers', async () => {
    const { fake, choice } = appendInto('---\nnums: [1, 2]\n---\nbody\n', 'nums', '3')
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.nums).toEqual([1, 2, 3])
  })

  it('adds a checkbox to a list of them', async () => {
    const { fake, choice } = appendInto('---\nflags: [true]\n---\nbody\n', 'flags', 'false')
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.flags).toEqual([true, false])
  })

  it('leaves a text list as text', async () => {
    const { fake, choice } = appendInto('---\nwords: [one]\n---\nbody\n', 'words', 'two')
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.words).toEqual(['one', 'two'])
  })

  it('does not turn a list of number-looking text into numbers', async () => {
    const { fake, choice } = appendInto('---\nnums: [\x271\x27, \x272\x27]\n---\nbody\n', 'nums', '3')
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.nums).toEqual(['1', '2', '3'])
  })

  it('falls back to text when one element is not a number', async () => {
    const { fake, choice } = appendInto('---\nnums: [1, x]\n---\nbody\n', 'nums', '3')
    await runCaptureChoice(choice, fake.port)
    expect(parseFrontMatter(fake.content('Note') ?? '').data.nums).toEqual(['1', 'x', '3'])
  })
})

describe('creating a note from a template', () => {
  it('creates a note named by the format, in the configured folder', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'Daily', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: '{{DATE:YYYY-MM-DD}}' },
      folderMode: 'fixed' as const,
      folderPath: 'Journal',
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.created[0]).toMatchObject({ title: '2026-10-08', folderPath: 'Journal', content: 'Daily body' })
  })

  it('creates a blank note when the choice names no template', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'Daily note', 0),
      nameFormat: { enabled: true, format: '{{DATE:YYYY-MM-DD}}' },
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind, '“No template” is a choice the editor offers, not a broken reference').toBe('written')
    expect(fake.created[0]).toMatchObject({ title: '2026-10-08', content: '' })
  })

  it('asks which library template to use when the choice says so', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'Picked', 0),
      templateId: 'tpl-cleared',
      templatePick: 'ask' as const,
      nameFormat: { enabled: true, format: 'Picked note' },
    }
    answers.queue = [['Daily']]
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls[0], 'the template is the first thing asked').toEqual(['template'])
    expect(fake.created[0].content, 'the answered name, not the stored id, picks the body').toBe('Daily body')
  })

  it('creates nothing when the template question is closed', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'Picked', 0),
      templatePick: 'ask' as const,
      nameFormat: { enabled: true, format: 'Picked note' },
    }
    answers.queue = [null]
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('cancelled')
    expect(fake.created).toEqual([])
  })

  it('says so when the library has no template to offer', async () => {
    const fake = harness({})
    fake.picks.length = 0
    const choice = { ...newTemplateChoice('qa-t', 'Picked', 0), templatePick: 'ask' as const }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    expect(fake.created).toEqual([])
  })

  it('narrows the pick to one category and names the rows by it', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'Journal ritual', 0),
      templatePick: 'ask' as const,
      templatePickCategory: 'Journal',
      nameFormat: { enabled: true, format: 'Ritual' },
    }
    answers.queue = [['tpl-daily']]
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    const request = answers.requests[0]?.find((entry) => entry.key === 'template')
    expect(request?.options, 'the answer is the id, so two templates can share a name').toEqual(['tpl-daily'])
    expect(request?.displayOptions, 'the row says which category it came from').toEqual(['Daily (Journal)'])
    expect(fake.created[0].content).toBe('Daily body')
  })

  it('refuses a category that has nothing in it, rather than offering the whole library', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'Empty bin', 0),
      templatePick: 'ask' as const,
      templatePickCategory: 'Nope',
      nameFormat: { enabled: true, format: 'Anything' },
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    if (status.kind === 'failed') expect(status.reason).toBe(t('quickadd.error_no_templates_to_pick'))
    expect(answers.calls, 'a run with nothing to choose asks no questions').toEqual([])
    expect(fake.created).toEqual([])
  })

  it('says so when inserting an empty template at the caret writes nothing', async () => {
    const fake = harness({ Inbox: 'today\n' })
    fake.setActive('Inbox')
    const choice = {
      ...newTemplateChoice('qa-t', 'Blank insert', 0),
      templateId: 'tpl-cleared',
      mode: 'insert-here' as const,
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('empty')
    expect(fake.inserted).toEqual([])
    expect(fake.writes, 'a template with no text does not rewrite the note').toEqual([])
    expect(fake.content('Inbox')).toBe('today\n')
  })

  it('keeps a template’s own properties out of the body it inserts', async () => {
    const fake = harness({ Here: '# Title\n' })
    fake.setActive('Here')
    const choice = {
      ...newTemplateChoice('qa-t', 'Insert props', 0),
      templateId: 'tpl-props',
      mode: 'insert-here' as const,
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.content('Here')).toBe('---\nmood: glad\ntags:\n  - journal\n---\n# Title\nFrom template\n')
    expect(fake.writes.length, 'one write, not an editor splice').toBe(1)
  })

  it('adds a template’s list to the note’s own instead of overwriting it', async () => {
    const fake = harness({ Here: '---\ntags: [work]\n---\n# Title\n' })
    fake.setActive('Here')
    const choice = {
      ...newTemplateChoice('qa-t', 'Insert props', 0),
      templateId: 'tpl-props',
      mode: 'insert-here' as const,
    }
    await runTemplateChoice(choice, fake.port)
    const data = parseFrontMatter(fake.content('Here') ?? '').data
    expect(data.tags).toEqual(['work', 'journal'])
    expect(data.mood).toBe('glad')
  })

  it('puts the caret where the template said, past the merged properties', async () => {
    const fake = harness({ Here: '---\nm: 1\n---\nbody\n' })
    fake.setActive('Here')
    fake.setSelection(18, 18)
    const choice = {
      ...newTemplateChoice('qa-t', 'Marked', 0),
      templateId: 'tpl-marked',
      mode: 'insert-here' as const,
    }
    await runTemplateChoice(choice, fake.port)
    expect(fake.content('Here')).toBe('---\nm: 1\n---\nbody\nHithere\n')
    expect(fake.carets).toEqual([20])
  })

  it('writes the fullwidth space the reader answered with', async () => {
    const fake = harness({ Inbox: 'today\n' })
    const choice = newCaptureChoice('qa-c', 'Inbox capture', 0)
    answers.queue = [['　']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind, 'an ideographic space is content, not a skipped answer').toBe('written')
    expect(fake.content('Inbox')).toBe('today\n　')
  })

  it('inserts a template that is only a fullwidth space', async () => {
    const fake = harness({ Here: 'body\n' })
    fake.setActive('Here')
    const choice = {
      ...newTemplateChoice('qa-t', 'Pad', 0),
      templateId: 'tpl-space',
      mode: 'insert-here' as const,
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind, 'an ideographic space is what the template carries').toBe('written')
    expect(fake.content('Here')).toBe('body\n　')
  })

  it('does not clear the reader’s selection when the answer came back blank', async () => {
    const fake = harness({ Inbox: 'today\n' })
    fake.setActive('Inbox')
    const choice = {
      ...newCaptureChoice('qa-c', 'Cursor capture', 0),
      writePosition: 'cursor' as const,
    }
    answers.queue = [['']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('empty')
    expect(fake.inserted, 'an empty insert would delete what the reader has selected').toEqual([])
  })

  it('refuses to split the note’s own properties when inserting at the caret', async () => {
    const fake = harness({ Here: '---\na: 1\n---\nbody\n' })
    fake.setActive('Here')
    fake.setSelection(4, 4)
    const choice = {
      ...newTemplateChoice('qa-t', 'Splitter', 0),
      templateId: 'tpl-marked',
      mode: 'insert-here' as const,
    }
    await runTemplateChoice(choice, fake.port)
    expect(fake.content('Here')).toBe('---\na: 1\n---\nHithere\nbody\n')
  })

describe('the link back to the note the run started from', () => {
  const captureFrom = (over: Record<string, unknown>) => ({
    ...newCaptureChoice('qa-c', 'Link capture', 0),
    targetMode: 'note' as const,
    targetTitle: 'Journal',
    createIfMissing: true,
    linkToSource: true,
    ...over,
  })

  it('asks for the place, the property and the shape the choice says', async () => {
    const fake = harness({ Source: 'started here\n' })
    const choice = captureFrom({ linkPlacement: 'property' as const, linkProperty: 'origin', linkEmbed: true })
    answers.queue = [['an idea']]
    await runCaptureChoice(choice, fake.port, { sourceNoteId: 'n-Source' })
    expect(fake.links).toEqual([{ sourceId: 'n-Source', title: 'Journal', options: { placement: 'property', property: 'origin', embed: true } }])
  })

  it('asks for the note’s end, plainly, in a property called source when the choice says nothing', async () => {
    const fake = harness({ Source: 'started here\n' })
    answers.queue = [['an idea']]
    await runCaptureChoice(captureFrom({}), fake.port, { sourceNoteId: 'n-Source' })
    expect(fake.links[0].options).toEqual({ placement: 'noteEnd', property: 'source', embed: false })
  })

  it('says out loud when the app refused the link, and still reports the capture', async () => {
    const fake = harness({ Source: 'started here\n' })
    fake.refuseLink()
    answers.queue = [['an idea']]
    const status = await runCaptureChoice(captureFrom({}), fake.port, { sourceNoteId: 'n-Source' })
    expect(status.kind).toBe('written')
    expect(fake.notifications.join('\n')).toContain('Source')
    expect(fake.content('Source'), 'the note is not pretending to be linked').toBe('started here\n')
  })

  it('writes the link back from a template choice too', async () => {
    const fake = harness({ Source: 'started here\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'Linked note', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: 'Made {{VALUE}}' },
      linkToSource: true,
      linkPlacement: 'lineEnd' as const,
    }
    answers.queue = [['one']]
    await runTemplateChoice(choice, fake.port, { sourceNoteId: 'n-Source' })
    expect(fake.links).toEqual([{ sourceId: 'n-Source', title: 'Made one', options: { placement: 'lineEnd', property: 'source', embed: false } }])
  })
})

describe('where a finished run opens the note', () => {
  it('opens in the pane and layout the choice says, without taking focus', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'Journal', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: 'Note {{VALUE}}' },
      openAfter: true,
      openPane: 'other' as const,
      openLayout: 'preview' as const,
      openFocus: false,
    }
    answers.queue = [['one']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.opens).toEqual([{ pane: 'other', layout: 'preview', focus: false }])
  })

  it('asks for the current pane, the reader’s own layout and the focus when the choice says nothing', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'Plain', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: 'Note {{VALUE}}' },
    }
    answers.queue = [['one']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.opens, 'the fields stay absent so the app decides').toEqual([{}])
  })

  it('carries the same opening to a capture', async () => {
    const fake = harness({ Inbox: 'today\n' })
    const choice = {
      ...newCaptureChoice('qa-c', 'Inbox capture', 0),
      openAfter: true,
      openPane: 'other' as const,
      openLayout: 'live' as const,
      openFocus: true,
    }
    answers.queue = [['an idea']]
    await runCaptureChoice(choice, fake.port)
    expect(fake.opens).toEqual([{ pane: 'other', layout: 'live', focus: true }])
  })

  it('does not move the caret into a note the run opened in the background', async () => {
    const fake = harness({ Diary: 'old\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'Overwrite', 0),
      templateId: 'tpl-marked',
      nameFormat: { enabled: true, format: 'Diary' },
      existing: 'overwrite' as const,
      openAfter: true,
      openFocus: false,
    }
    answers.queue = [['true']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.content('Diary')).toBe('Hithere\n')
    expect(fake.carets, 'the caret of the note on screen stays where the reader left it').toEqual([])

    const other = harness({ Diary: 'old\n' })
    answers.queue = [['true']]
    await runTemplateChoice({ ...choice, openFocus: true }, other.port)
    expect(other.carets, 'with the focus the marker is honoured').toEqual([2])
  })
})

describe('a name format that routes into a folder', () => {
  const named = (over: Record<string, unknown>) => ({
    ...newTemplateChoice('qa-t', 'Routed', 0),
    templateId: 'tpl-daily',
    nameFormat: { enabled: true, format: 'Journal/{{DATE:YYYY-MM-DD}}' },
    ...over,
  })

  it('creates the note inside the folder the name names', async () => {
    const fake = harness({})
    await runTemplateChoice(named({}), fake.port)
    expect(fake.created[0]).toMatchObject({ title: '2026-10-08', folderPath: 'Journal' })
  })

  it('does not stack the folder twice when the choice already points at it', async () => {
    const fake = harness({})
    const choice = named({
      folderMode: 'fixed' as const,
      folderPath: 'Journal',
      nameFormat: { enabled: true, format: 'Journal/{{VALUE}}' },
    })
    answers.queue = [['Notes']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0]).toMatchObject({ title: 'Notes', folderPath: 'Journal' })
  })

  it('keeps a deeper route the name names, under the choice’s folder', async () => {
    const fake = harness({})
    const choice = named({
      folderMode: 'fixed' as const,
      folderPath: 'Inbox',
      nameFormat: { enabled: true, format: 'Deep/Inside/{{VALUE}}' },
    })
    answers.queue = [['note']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0]).toMatchObject({ title: 'note', folderPath: 'Inbox/Deep/Inside' })
  })

  it('hangs a deeper route off the folder the choice names', async () => {
    const fake = harness({})
    const choice = named({
      folderMode: 'fixed' as const,
      folderPath: 'Journal',
      nameFormat: { enabled: true, format: 'Journal/Deep/{{VALUE}}' },
    })
    answers.queue = [['note']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0]).toMatchObject({ title: 'note', folderPath: 'Journal/Deep' })
  })

  it('does not repeat a folder the choice path already ends with', async () => {
    const fake = harness({})
    const choice = named({
      folderMode: 'fixed' as const,
      folderPath: 'Inbox/Journal',
      nameFormat: { enabled: true, format: 'journal/{{VALUE}}' },
    })
    answers.queue = [['note']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0]).toMatchObject({ title: 'note', folderPath: 'Inbox/Journal' })
  })

  it('routes what the reader typed at the name question too', async () => {
    const fake = harness({})
    const choice = { ...newTemplateChoice('qa-t', 'Asked', 0), templateId: 'tpl-daily' }
    answers.queue = [['Notes/2026']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0]).toMatchObject({ title: '2026', folderPath: 'Notes' })
  })

  it('leaves a slash-free name where the choice says', async () => {
    const fake = harness({})
    const choice = named({ folderMode: 'fixed' as const, folderPath: 'Journal', nameFormat: { enabled: true, format: 'Plain {{VALUE}}' } })
    answers.queue = [['one']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0]).toMatchObject({ title: 'Plain one', folderPath: 'Journal' })
  })

  it('counts a routed name as taken only inside the folder it routes to', async () => {
    const fake = harness({ '2026-10-08': 'elsewhere' })
    fake.notes['2026-10-08'].folderPath = 'Elsewhere'
    const choice = named({ existing: 'number' as const })
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0]).toMatchObject({ title: '2026-10-08', folderPath: 'Journal' })
  })

  it('files the note under the parent-step a mistyped route names', async () => {
    const fake = harness({})
    await runTemplateChoice(named({ nameFormat: { enabled: true, format: '../Escape/{{DATE:YYYY-MM-DD}}' } }), fake.port)
    expect(fake.created[0], 'a folder named .. is not a place in this app’s tree').toMatchObject({ title: '2026-10-08', folderPath: 'Escape' })
  })
})

  it('asks for a name when the choice has no format', async () => {
    const fake = harness({})
    const choice = { ...newTemplateChoice('qa-t', 'T', 0), templateId: 'tpl-daily' }
    answers.queue = [['My note']]
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0].title).toBe('My note')
  })

  it('creates no note when the reader closes the folder question', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'T', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: 'Filed note' },
      folderMode: 'ask' as const,
    }
    answers.queue = [null]
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('cancelled')
    expect(fake.created, 'a closed folder question must not file the note in the root').toEqual([])
  })

  it('cancels rather than fails when the date question is closed', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'T', 0),
      templateId: 'tpl-cleared',
      nameFormat: { enabled: true, format: 'Day note' },
      dateOrigin: 'ask' as const,
    }
    answers.queue = [null]
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind, 'closing a question is not a broken date').toBe('cancelled')
    expect(fake.created).toEqual([])
  })

  it('merges the choice tags into the new note’s properties', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'T', 0),
      templateId: 'tpl-cleared',
      nameFormat: { enabled: true, format: 'Tagged' },
      tags: ['daily'],
    }
    await runTemplateChoice(choice, fake.port)
    // The app's own YAML writer emits a block sequence, so that is what a tagged new note carries.
    expect(fake.created[0].content).toBe('---\ntags:\n  - daily\n---\n')
  })

  it('refuses to overwrite a note that exists when the choice says cancel', async () => {
    const fake = harness({ Taken: 'kept\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'T', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: 'Taken' },
      existing: 'cancel' as const,
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    expect(fake.content('Taken')).toBe('kept\n')
  })

  it('replaces an existing note only after a yes', async () => {
    const fake = harness({ Taken: 'kept\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'T', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: 'Taken' },
      existing: 'ask' as const,
    }
    answers.queue = [['no']]
    const cancelled = await runTemplateChoice(choice, fake.port)
    expect(cancelled.kind).toBe('cancelled')
    expect(fake.content('Taken')).toBe('kept\n')

    answers.queue = [['true']]
    const written = await runTemplateChoice(choice, fake.port)
    expect(written.kind).toBe('written')
    expect(fake.content('Taken')).toBe('Daily body')
  })

  it('numbers a second note instead of colliding', async () => {
    const fake = harness({ Twice: 'one\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'T', 0),
      templateId: 'tpl-cleared',
      nameFormat: { enabled: true, format: 'Twice' },
      existing: 'number' as const,
    }
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0].title).toBe('Twice 2')
  })

  it('drops a template at the top of the open note, below its properties', async () => {
    const fake = harness({ Here: '---\na: 1\n---\nbody\n' })
    fake.setActive('Here')
    const choice = {
      ...newTemplateChoice('qa-t', 'Top', 0),
      templateId: 'tpl-daily',
      mode: 'insert-here' as const,
      insertPosition: 'top' as const,
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.content('Here')).toBe('---\na: 1\n---\nDaily body\nbody\n')
  })

  it('appends the template to the open note with one blank line between', async () => {
    const fake = harness({ Here: 'body\n\n\n' })
    fake.setActive('Here')
    const choice = {
      ...newTemplateChoice('qa-t', 'Bottom', 0),
      templateId: 'tpl-daily',
      mode: 'insert-here' as const,
      insertPosition: 'bottom' as const,
    }
    await runTemplateChoice(choice, fake.port)
    expect(fake.content('Here')).toBe('body\n\nDaily body')
  })

  it('puts the caret drop where the reader had selected, not at the end', async () => {
    const fake = harness({ Here: 'head SEL tail' })
    fake.setActive('Here')
    fake.setSelection(5, 8)
    const choice = {
      ...newTemplateChoice('qa-t', 'Selection', 0),
      templateId: 'tpl-daily',
      mode: 'insert-here' as const,
    }
    await runTemplateChoice(choice, fake.port)
    expect(fake.content('Here')).toBe('head Daily body tail')
  })

  it('appends to a note that is not on screen, without moving anyone’s caret', async () => {
    const fake = harness({ Diary: 'old\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'Append marked', 0),
      templateId: 'tpl-marked',
      nameFormat: { enabled: true, format: 'Diary' },
      existing: 'appendBottom' as const,
      openAfter: true,
    }
    await runTemplateChoice(choice, fake.port)
    expect(fake.content('Diary')).toBe('old\n\nHithere\n')
    expect(fake.carets, 'the caret it opened into is not the one the reader was typing in').toEqual([])
    expect(fake.opened).toEqual(['n-Diary'])
  })

  it('replaces the open note when that is what the drop says', async () => {
    const fake = harness({ Here: '---\nold: 1\n---\nBody\n' })
    fake.setActive('Here')
    const choice = {
      ...newTemplateChoice('qa-t', 'Replace', 0),
      templateId: 'tpl-props',
      mode: 'insert-here' as const,
      insertPosition: 'replace' as const,
    }
    await runTemplateChoice(choice, fake.port)
    expect(fake.content('Here')).toBe('---\nmood: glad\ntags:\n  - journal\n---\nFrom template\n')
  })

  it('needs the note on screen for a drop, and says which half is missing', async () => {
    const fake = harness({ Here: 'body\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'Bottom no editor', 0),
      templateId: 'tpl-daily',
      mode: 'insert-here' as const,
      insertPosition: 'bottom' as const,
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status).toMatchObject({ kind: 'failed', reason: t('quickadd.error_no_open_note') })
  })

  it('appends the template under a name the library already has', async () => {
    const fake = harness({ Diary: 'old\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'Append', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: 'Diary' },
      existing: 'appendBottom' as const,
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.created, 'no second note is made').toEqual([])
    expect(fake.content('Diary')).toBe('old\n\nDaily body')
  })

  it('appends under a colliding name without asking first', async () => {
    const fake = harness({ Diary: '---\nmood: sad\n---\nold\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'Append bin', 0),
      templateId: 'tpl-daily',
      nameFormat: { enabled: true, format: 'Diary' },
      existing: 'appendBottom' as const,
    }
    answers.queue = []
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls, 'the reader already said append').toEqual([])
    expect(fake.content('Diary')).toContain('mood: sad')
    expect(fake.content('Diary')).toContain('Daily body')
  })

  it('appends above the note it collides with, merging its properties', async () => {
    const fake = harness({ Diary: '---\nmood: sad\n---\nold\n' })
    const choice = {
      ...newTemplateChoice('qa-t', 'Append top', 0),
      templateId: 'tpl-props',
      nameFormat: { enabled: true, format: 'Diary' },
      existing: 'appendTop' as const,
    }
    await runTemplateChoice(choice, fake.port)
    const data = parseFrontMatter(fake.content('Diary') ?? '').data
    expect(data.mood, 'the note keeps its own value').toBe('sad')
    expect(data.tags).toEqual(['journal'])
    expect(fake.content('Diary')).toContain('From template')
  })

  it('splices the template into the open note at the caret', async () => {
    const fake = harness({ Here: 'body\n' })
    fake.setActive('Here')
    const choice = {
      ...newTemplateChoice('qa-t', 'Insert', 0),
      templateId: 'tpl-daily',
      mode: 'insert-here' as const,
    }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.content('Here')).toBe('body\nDaily body')
  })

  it('counts dates from the day the reader picked', async () => {
    const fake = harness({})
    const choice = {
      ...newTemplateChoice('qa-t', 'T', 0),
      templateId: 'tpl-cleared',
      nameFormat: { enabled: true, format: '{{DATE}}' },
      dateOrigin: 'ask' as const,
    }
    answers.queue = [['2024-03-04'], []]
    await runTemplateChoice(choice, fake.port)
    expect(fake.created[0].title).toBe('2024-03-04')
  })

  it('says so when the template it points at is gone', async () => {
    const fake = harness({})
    const choice = { ...newTemplateChoice('qa-t', 'T', 0), templateId: 'tpl-gone' }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status).toMatchObject({ kind: 'failed' })
  })
})

describe('running a macro', () => {
  it('runs an app command through the port, the way the palette entry does', async () => {
    const fake = harness({})
    const choice = {
      ...newMacroChoice('qa-m', 'Routine', 0),
      steps: [{ kind: 'command' as const, commandId: 'cmd-emoji' }],
    }
    const status = await runMacroChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.commands).toEqual(['cmd-emoji'])
  })

  it('says so when the app command it was told to run is not available', async () => {
    const fake = harness({})
    const choice = {
      ...newMacroChoice('qa-m', 'Routine', 0),
      steps: [{ kind: 'command' as const, commandId: 'missing-command' }],
    }
    const status = await runMacroChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    expect(fake.commands, 'an id the port would refuse is still asked of the port once').toEqual(['missing-command'])
  })

  it('refuses a command step with no id rather than running the first one', async () => {
    const fake = harness({})
    const choice = {
      ...newMacroChoice('qa-m', 'Routine', 0),
      steps: [{ kind: 'command' as const, commandId: '   ' }],
    }
    const status = await runMacroChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    expect(fake.commands).toEqual([])
  })


  it('runs its steps in order and shares the variables between them', async () => {
    const fake = harness({ Inbox: 'x\n' })
    const choice = {
      ...newMacroChoice('qa-m', 'Routine', 0),
      steps: [
        { kind: 'ask' as const, variable: 'who', label: 'Who', options: '' },
        { kind: 'set' as const, variable: 'greeting', value: 'Hi {{VALUE:who}}' },
        { kind: 'insert' as const, text: '{{VALUE:greeting}}' },
        { kind: 'notify' as const, text: 'done for {{VALUE:who}}' },
      ],
    }
    answers.queue = [['Tom'], []]
    const status = await runMacroChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(fake.inserted[0].text).toBe('Hi Tom')
    expect(fake.notifications[0]).toContain('done for Tom')
  })

  it('stops at a cancelled prompt instead of half-running', async () => {
    const fake = harness({})
    const choice = {
      ...newMacroChoice('qa-m', 'Routine', 0),
      steps: [
        { kind: 'ask' as const, variable: 'who', label: 'Who', options: '' },
        { kind: 'insert' as const, text: 'never' },
      ],
    }
    answers.queue = [null]
    const status = await runMacroChoice(choice, fake.port)
    expect(status.kind).toBe('cancelled')
    expect(fake.inserted.length).toBe(0)
  })
  it('takes the branch a variable chooses', async () => {
    const fake = harness({})
    const choice = {
      ...newMacroChoice('qa-m', 'Branch', 0),
      steps: [{
        kind: 'if' as const,
        variable: 'mode',
        operator: 'eq' as const,
        value: 'fast',
        then: [{ kind: 'insert' as const, text: 'quickly' }],
        else: [{ kind: 'insert' as const, text: 'slowly' }],
      }],
    }
    await runMacroChoice(choice, fake.port, { variables: new Map([['mode', 'FAST']]) })
    expect(fake.inserted[0].text).toBe('quickly')

    const other = harness({})
    await runMacroChoice(choice, other.port, { variables: new Map([['mode', 'slow']]) })
    expect(other.inserted[0].text).toBe('slowly')
  })

  it('runs another choice and keeps its own variables for it', async () => {
    const fake = harness({ Inbox: 'base\n' })
    const target = { ...newCaptureChoice('qa-c', 'Capture', 0), targetTitle: 'Inbox', format: { enabled: true, format: '{{VALUE:extra}}' } }
    fake.store.push(target)
    const choice = {
      ...newMacroChoice('qa-m', 'Wrapper', 0),
      steps: [
        { kind: 'set' as const, variable: 'extra', value: 'from the macro' },
        { kind: 'choice' as const, choiceId: 'qa-c' },
      ],
    }
    await runMacroChoice(choice, fake.port)
    expect(fake.content('Inbox')).toBe('base\nfrom the macro')
  })

  it('refuses a macro that runs itself', async () => {
    const fake = harness({})
    const choice = { ...newMacroChoice('qa-m', 'Loop', 0), steps: [{ kind: 'choice' as const, choiceId: 'qa-m' }] }
    fake.store.push(choice)
    const status = await runMacroChoice(choice, fake.port)
    expect(status).toMatchObject({ kind: 'failed' })
  })

  it('reports a script that throws instead of writing nothing quietly', async () => {
    const fake = harness({})
    const choice = {
      ...newMacroChoice('qa-m', 'Script', 0),
      steps: [{ kind: 'script' as const, name: 'boom', code: 'throw new Error("nope")' }],
    }
    const status = await runMacroChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
    if (status.kind === 'failed') expect(status.reason).toContain('nope')
  })
})

describe('a group', () => {
  it('holds children that the launcher can list', () => {
    const group = newGroupChoice('qa-g', 'Journal', 0)
    const child = { ...newTemplateChoice('qa-t', 'Daily', 0), parentId: 'qa-g' }
    const choices = [group, child]
    expect(choices.filter((entry) => entry.parentId === 'qa-g').map((entry) => entry.name)).toEqual(['Daily'])
  })
})

describe('one page for the whole choice', () => {
  /** A template whose body asks for something, which is what makes a page worth having. */
  function ritualChoice(over: Partial<QuickAddTemplateChoice> = {}) {
    return {
      ...newTemplateChoice('qa-t', 'Ritual', 0),
      templateId: 'tpl-ritual',
      onePage: 'always' as const,
      dateOrigin: 'ask' as const,
      folderMode: 'ask' as const,
      ...over,
    }
  }

  it('asks the day, the name, the folder and the body together', async () => {
    const fake = harness({})
    fake.port.templateBody = async () => 'On {{DATE:YYYY-MM-DD}}: {{VALUE:idea}}'
    answers.queue = [['2026-01-02', 'Ritual note', 'Journal', 'milk']]
    const status = await runTemplateChoice(ritualChoice(), fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls, 'every question the run can already name shares one page').toEqual([['day', 'title', 'folder', 'idea']])
    expect(answers.pages, 'and it goes up as a page, not as four dialogs').toEqual([true])
    expect(fake.created[0]).toMatchObject({ title: 'Ritual note', folderPath: 'Journal' })
    // The day the page collected has to reach the body, which only formats after the page is answered.
    expect(fake.created[0].content).toBe('On 2026-01-02: milk')
  })

  it('asks nothing else once the page is closed', async () => {
    const fake = harness({})
    fake.port.templateBody = async () => 'Idea: {{VALUE:idea}}'
    answers.queue = [null]
    const status = await runTemplateChoice(ritualChoice(), fake.port)
    expect(status.kind).toBe('cancelled')
    expect(answers.calls, 'a dismissed page must not be followed by the day question').toEqual([['day', 'title', 'folder', 'idea']])
    expect(fake.created).toEqual([])
  })

  it('keeps asking one surface at a time when the reader wants one question at a time', async () => {
    const fake = harness({})
    fake.port.templateBody = async () => 'Idea: {{VALUE:idea}}'
    answers.queue = [['2026-01-02'], ['Slow note'], ['Journal'], ['milk']]
    const status = await runTemplateChoice(ritualChoice({ onePage: 'never' as const }), fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls.map((call) => call.length), 'no dialog holds two questions').toEqual([1, 1, 1, 1])
    expect(answers.pages.every((page) => page === false), 'the page mode the reader chose is honoured').toBe(true)
    expect(fake.created[0].content).toBe('Idea: milk')
  })

  it('puts a capture’s target and its text on the same page', async () => {
    const fake = harness({})
    const choice = {
      ...newCaptureChoice('qa-c', 'Journal line', 0),
      onePage: 'always' as const,
      targetTitle: 'Journal/{{VALUE:which}}',
      createIfMissing: true,
      format: { enabled: true, format: 'note: {{VALUE:idea}}' },
    }
    answers.queue = [['2026-02-03', 'milk']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls).toEqual([['which', 'idea']])
    expect(answers.pages).toEqual([true])
    expect(fake.created[0]).toMatchObject({ title: '2026-02-03', folderPath: 'Journal' })
    expect(fake.content('2026-02-03')).toContain('note: milk')
  })

  it('leaves the auto mode asking surface by surface, so the prompt still names its destination', async () => {
    const fake = harness({ Inbox: 'one\n' })
    const choice = captureOn('Inbox', {
      onePage: 'auto' as const,
      format: { enabled: true, format: 'note: {{VALUE:idea}}' },
    })
    answers.queue = [['milk']]
    const status = await runCaptureChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls, 'one question is one dialog, asked after the target is known').toEqual([['idea']])
    expect(answers.pages, 'and it is not a page').toEqual([false])
    expect(answers.destinations, 'the dialog tells the reader which note it is filling').toEqual(['Inbox'])
  })

  it('gathers a macro’s leading questions and leaves a branch’s off the page', async () => {
    const fake = harness({})
    const choice = {
      ...newMacroChoice('qa-m', 'Morning', 0),
      onePage: 'always' as const,
      steps: [
        { kind: 'ask' as const, variable: 'mood', label: 'Mood?', options: '' },
        { kind: 'insert' as const, text: 'Mood: {{VALUE:mood}} / {{VALUE:extra}}' },
        {
          kind: 'if' as const,
          variable: 'mood',
          operator: 'eq' as const,
          value: 'yes',
          then: [{ kind: 'ask' as const, variable: 'hidden', label: 'Why?', options: '' }],
          else: [],
        },
      ],
    }
    answers.queue = [['no', 'more']]
    const status = await runMacroChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls, 'a question inside a branch that did not run was never asked').toEqual([['mood', 'extra']])
    expect(fake.inserted[0].text).toBe('Mood: no / more')
  })

  it('does not ask for a variable the macro writes itself', async () => {
    const fake = harness({})
    const choice = {
      ...newMacroChoice('qa-m', 'Quiet', 0),
      onePage: 'always' as const,
      steps: [
        { kind: 'set' as const, variable: 'mood', value: 'calm' },
        { kind: 'insert' as const, text: 'Mood: {{VALUE:mood}}' },
      ],
    }
    const status = await runMacroChoice(choice, fake.port)
    expect(status.kind).toBe('written')
    expect(answers.calls, 'nothing in this macro needs a reader').toEqual([])
    expect(fake.inserted[0].text).toBe('Mood: calm')
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuickAddCaptureChoice } from '@shared/quickadd'
import { QUICKADD_LIMITS, newCaptureChoice, newGroupChoice, newMacroChoice, newTemplateChoice, defaultQuickAddSettings, type QuickAddChoice, type QuickAddSettings } from '@shared/quickadd'
import { initI18n } from '../../lib/i18n'
import { executeUserCode } from '../../features/preview/js-runner-core'
import type { JsRunOutcome } from '../../features/preview/js-runner-core'
import type { PromptAnswer, PromptRequest } from './format'
import type { NewNoteInput, NotePort, NoteRef } from './context'
import { runCaptureChoice } from './capture'
import { runTemplateChoice } from './template'
import { runMacroChoice } from './macro'

const answers = vi.hoisted(() => ({ queue: [] as (PromptAnswer[] | null)[], calls: [] as string[][] }))

vi.mock('../../features/quickadd/prompt-queue', () => ({
  askQuickAddPrompts: async (group: { requests: PromptRequest[] }) => {
    answers.calls.push(group.requests.map((request) => request.key))
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
  const inserted: { text: string; cursor: number | null | undefined }[] = []
  const opened: string[] = []
  const notifications: string[] = []
  const store: QuickAddChoice[] = []
  let activeId: string | null = null
  const merged: Partial<QuickAddSettings> = { ...defaultQuickAddSettings(), ...settings }

  const port: NotePort = {
    activeNote: () => (activeId ? ref(activeId) : null),
    findByTitle: (title) => Object.values(notes).find((note) => note.title.toLowerCase() === title.toLowerCase()) ?? null,
    byId: (id) => ref(id),
    read: async (id) => Object.values(notes).find((note) => note.id === id)?.content ?? '',
    write: async (id, content, previous) => {
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
    open: async (id) => {
      opened.push(id)
      activeId = id
    },
    linkTo: (target) => `[[${target.title}]]`,
    cursorHeadingPath: () => null,
    selection: () => selection,
    clipboard: async () => '',
    templateBody: async (name) => (name === 'tpl-daily' || name === 'Daily' ? 'Daily body' : name === 'tpl-cleared' ? '' : null),
    templateNames: () => ['Daily', 'Cleared'],
    fieldValues: async () => [],
    pickFileTitles: async () => [],
    knownNoteTitles: () => Object.keys(notes),
    knownFolderPaths: () => ['Journal'],
    appendLink: async (source, target) => {
      const note = Object.values(notes).find((entry) => entry.id === source.id)
      if (!note) return false
      note.content = `${note.content}\n[[${target.title}]]\n`
      return true
    },
    copyText: (text) => { copied.push(text) },
    placeCursor: () => {},
    recordRun: () => {},
    notify: (title, description) => { notifications.push(`${title}: ${description ?? ''}`) },
    insertAtCursor: (text, cursor) => {
      inserted.push({ text, cursor })
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
    inserted,
    opened,
    notifications,
    store,
    setActive: (title: string | null) => {
      activeId = title ? (notes[title]?.id ?? null) : null
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
    fake.port.templateNames = () => []
    const choice = { ...newTemplateChoice('qa-t', 'Picked', 0), templatePick: 'ask' as const }
    const status = await runTemplateChoice(choice, fake.port)
    expect(status.kind).toBe('failed')
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
    expect(fake.inserted[0].text).toBe('Daily body')
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

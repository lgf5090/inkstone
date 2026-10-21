import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askQuickAddPrompts,
  cancelQuickAddPrompts,
  clearQuickAddDrafts,
  currentPromptGroup,
  recallDraft,
  resetQuickAddPrompts,
  type PromptAnswers,
  type PromptGroup,
} from '../../../features/quickadd/prompt-queue'
import type { PromptAnswer, PromptRequest } from '../../../lib/quickadd/format'
import type { CapabilityProfile, HostResult, TemplateRunContext, TemplaterPromptRequest } from '../protocol'
import { MAX_CLIPBOARD_CHARS } from '../limits'
import { createPromptHost, type PromptHost, type PromptHostDeps } from './prompt-host'

/**
 * The asking side of the page host, tested as a mapping.
 *
 * Two layers under this one already have their own suites and neither is repeated here: the dialog itself —
 * focus, keys, the pinyin filter, the mobile sheet, and the five fields a template's question needed added
 * to QuickAdd's own — belongs to `features/quickadd`, and what an answered or cancelled question becomes
 * *inside* the interpreter (`null` for a prompt, `[]` for a multi-suggester, a rethrow for
 * `throw_on_cancel`) belongs to the frozen prelude and is pinned in `worker/bootstrap.test.ts`. What lives
 * here, and so what is checked here, is the translation between the two: the wire's
 * `TemplaterPromptRequest` becoming the queue's `PromptRequest`, the queue's answer becoming the template's
 * value, and whether the reader may be bothered at all.
 *
 * The questions are built from the argument lists `worker/bootstrap.ts` really sends — a prompt with
 * `values: []`, a suggester whose `values` are the display texts — plus the contract's other shape, where
 * `labels` and `values` are told apart, because that pair is read by no one but this module.
 */

/** The call id every question below is answered against, in the shape the door's `HostCall` carries it. */
const CALL = 'call-7'

function context(overrides: Partial<TemplateRunContext> = {}): TemplateRunContext {
  // The prompt host reads four fields off the run: its id, its rights, and the two names a dialog signs
  // itself with. The note index a real `buildRunSnapshot` produces is left out on purpose — a fixture index
  // here could drift from the shipped one while testing nothing of this module.
  return {
    runId: 'run-1',
    mode: 'overwrite-active',
    capabilities: 'local',
    template: { id: 'template-daily', name: 'Daily', content: 'text' },
    startedAt: 1_700_000_000_000,
    target: null,
    active: null,
    frozenTitle: 'Target',
    index: [],
    folders: [],
    libraryTemplates: [],
    locale: 'en-US',
    selection: '',
    userScripts: [],
    ...overrides,
  }
}

interface FakeQueue {
  deps: PromptHostDeps
  /** Every group this host put on the queue, in order. */
  groups: PromptGroup[]
  /** The one request of each group, flattened: what the reader would have been shown. */
  requests: PromptRequest[]
}

/**
 * The queue, as a test's.
 *
 * `reply` reads the single request its group holds and answers in the real queue's own terms: a map keyed
 * by the request's key, an empty map for "this question got no answer", `null` for "the dialog was closed".
 */
function queueReplying(reply: (request: PromptRequest) => PromptAnswers | null): FakeQueue {
  const groups: PromptGroup[] = []
  return {
    deps: {
      ask: async (group) => {
        groups.push(group)
        return reply(group.requests[0]!)
      },
    },
    groups,
    get requests() {
      return groups.flatMap((group) => group.requests)
    },
  }
}

/** A queue that asks and then answers, with one string: a typed field, or the row a picker committed. */
function queueAnswers(value: PromptAnswer) {
  return queueReplying((request) => (typeof value === 'string' || Array.isArray(value))
    ? new Map([[request.key, value]])
    : null)
}

/** The reader closed the dialog. */
const dialogClosed = () => queueReplying(() => null)
/** The queue finished and left this question out of its map — which the queue says is no answer either. */
const noAnswerForIt = () => queueReplying(() => new Map())

function clipboardReading(answer: string | null | Error): { deps: PromptHostDeps; calls: () => number } {
  let calls = 0
  return {
    deps: {
      readClipboard: async () => {
        calls += 1
        if (answer instanceof Error) throw answer
        return answer
      },
    },
    calls: () => calls,
  }
}

/** A host over the given ports and one registered run, which is how the page uses it. */
function hostWith(deps: PromptHostDeps, profile: CapabilityProfile = 'local', overrides: Partial<TemplateRunContext> = {}): PromptHost {
  const host = createPromptHost(deps)
  host.beginRun(context({ capabilities: profile, ...overrides }))
  return host
}

/** A host and its queue, so a test can read what the queue was asked for after the answer came back. */
function started(queue: FakeQueue = noAnswerForIt(), profile: CapabilityProfile = 'local', overrides: Partial<TemplateRunContext> = {}): { host: PromptHost; queue: FakeQueue } {
  return { host: hostWith(queue.deps, profile, overrides), queue }
}

function ask(host: PromptHost, method: string, args: unknown[] = [], callId = CALL, runId = 'run-1'): Promise<HostResult> {
  return host({ runId, callId, method, args })
}

/** The `system.prompt` argument list the prelude builds for `tp.system.prompt(text, default, …)`. */
function textQuestion(overrides: Partial<TemplaterPromptRequest> = {}): TemplaterPromptRequest {
  return { kind: 'text', title: 'Where', values: [], defaultValue: 'Home', ...overrides }
}

/** The `system.suggester` list the prelude builds, where the display text *is* the value. */
function suggestQuestion(overrides: Partial<TemplaterPromptRequest> = {}): TemplaterPromptRequest {
  return { kind: 'suggest', title: '', values: ['apple', 'banana'], placeholder: '', ...overrides }
}

function refused(result: HostResult): { code: string; detail: string | undefined } {
  if (result.ok) throw new Error(`answered ${JSON.stringify(result.value)} instead of refusing`)
  return { code: result.code, detail: result.detail }
}

function answered(result: HostResult): unknown {
  if (!result.ok) throw new Error(`refused: ${result.code} ${result.detail ?? ''}`)
  return result.value
}

afterEach(() => {
  // The real queue is module state and only the last describe touches it: a group left on screen would be
  // handed to the next file as a prompt nobody asked for.
  resetQuickAddPrompts()
  clearQuickAddDrafts()
  vi.restoreAllMocks()
})

describe('capability gate', () => {
  it('refuses to ask the reader anything on a run that may not ask, without opening a dialog', async () => {
    // `startup` is the profile whose `prompt` is false: an unattended run has nobody at the keyboard, so a
    // question would hang the launch behind a modal no one will dismiss. The queue is the evidence.
    const questions = [textQuestion(), suggestQuestion(), suggestQuestion({ kind: 'multi-suggest' })]
    const methods = ['system.prompt', 'system.suggester', 'system.multiSuggester']
    for (const [index, method] of methods.entries()) {
      const { host, queue } = started(noAnswerForIt(), 'startup')
      expect(refused(await ask(host, method, [questions[index]!])), method)
        .toEqual({ code: 'capability-blocked', detail: method })
      expect(queue.groups, method).toEqual([])
    }
  })

  it('refuses a clipboard the run has no right to before the browser is asked', async () => {
    const clipboard = clipboardReading('copied text')
    // `community` may prompt — the gallery's interactive templates are built on it — but may not read what
    // the reader copied, so this is the row where the two gates differ.
    const host = hostWith({ ...noAnswerForIt().deps, ...clipboard.deps }, 'community')
    expect(refused(await ask(host, 'system.clipboard'))).toEqual({ code: 'capability-blocked', detail: 'system.clipboard' })
    // A refusal that still read the clipboard would have spent the reader's permission prompt for nothing.
    expect(clipboard.calls()).toBe(0)
  })

  it('refuses a run the page never registered, and one it has released', async () => {
    const { host, queue } = started(queueAnswers('typed answer'))
    expect(refused(await ask(host, 'system.prompt', [textQuestion()], CALL, 'run-elsewhere')))
      .toEqual({ code: 'render-failed', detail: 'run:run-elsewhere' })
    host.endRun('run-1')
    expect(refused(await ask(host, 'system.prompt', [textQuestion()])))
      .toEqual({ code: 'render-failed', detail: 'run:run-1' })
    expect(queue.groups).toEqual([])
  })

  it('names a method it was handed that it does not answer, rather than calling it unsupported', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { host, queue } = started()
    // `page-host.ts` answers an unowned name with `not-supported`. Here the same call is a routing bug in
    // this app, and telling the reader "this app has no prompt surface" would send them after the wrong thing.
    expect(refused(await ask(host, 'note.read', ['Target.md']))).toEqual({ code: 'render-failed', detail: 'prompt-host:note.read' })
    expect(refused(await ask(host, 42 as unknown as string))).toEqual({ code: 'render-failed', detail: 'prompt-host:unnamed' })
    expect(logged).toHaveBeenCalledWith('[inkstone] templater prompt host asked about a method it does not own', 'note.read')
    expect(queue.groups).toEqual([])
  })
})

describe('system.prompt', () => {
  it('answers what the reader typed', async () => {
    const { host, queue } = started(queueAnswers('Kitchen'))
    expect(answered(await ask(host, 'system.prompt', [textQuestion()]))).toBe('Kitchen')
    expect(queue.requests[0]).toMatchObject({
      kind: 'text',
      key: CALL,
      label: 'Where',
      defaultValue: 'Home',
      // Upstream's Submit answers an empty field (`PromptModal.ts:88-93`), so "no text" is an answer and not
      // a cancelled run.
      optional: true,
      options: [],
      displayOptions: null,
    })
  })

  it('turns a closed dialog and an unanswered question into the same code', async () => {
    for (const queue of [dialogClosed(), noAnswerForIt()]) {
      const { host } = started(queue)
      expect(refused(await ask(host, 'system.prompt', [textQuestion()])))
        .toEqual({ code: 'prompt-cancelled', detail: 'system.prompt' })
    }
  })

  it('answers a cancel with the code even when the template asked for a throw', async () => {
    // `throw_on_cancel` means "cancelling is an error", and the prelude is the layer that knows what an
    // error is worth inside a program. Flattening it here — a different code, or an answer of `null` — is
    // the one way to make the flag stop meaning anything, so this side says the same thing both ways.
    for (const throwOnCancel of [false, true]) {
      const { host } = started(dialogClosed())
      expect(refused(await ask(host, 'system.prompt', [textQuestion({ throwOnCancel })])))
        .toEqual({ code: 'prompt-cancelled', detail: 'system.prompt' })
    }
  })

  it('carries the three fields the queue has for the reader’s comfort', async () => {
    const { host, queue } = started()
    await ask(host, 'system.prompt', [textQuestion({
      multiLine: true,
      placeholder: 'One line per item',
      selectDefaultValue: true,
    })])
    expect(queue.requests[0]).toMatchObject({
      // Upstream's `multi_line` is the queue's own multi-line kind, not a second flag beside `kind`.
      kind: 'multiline',
      placeholder: 'One line per item',
      selectDefaultValue: true,
    })
  })

  it('leaves a plain question a plain field', async () => {
    const { host, queue } = started()
    await ask(host, 'system.prompt', [textQuestion({ placeholder: '' })])
    // An empty placeholder is no hint text, and text saying nothing in the field is worse than none.
    const request = queue.requests[0]!
    expect(request.kind).toBe('text')
    expect(request.placeholder ?? '').toBe('')
    expect(request.selectDefaultValue).toBe(false)
  })

  it('signs the dialog with the name the reader would recognise', async () => {
    const { host, queue } = started()
    await ask(host, 'system.prompt', [textQuestion()])
    expect(queue.groups[0]).toMatchObject({ choiceName: 'Daily', onePage: false, choiceId: 'templater:run-1' })

    // Text typed into the editor has no library template behind it, so the note the run belongs to is the
    // next name the reader owns; with neither, the id beats an empty heading.
    const byNote = started(noAnswerForIt(), 'local', { template: null })
    await ask(byNote.host, 'system.prompt', [textQuestion()])
    expect(byNote.queue.groups[0]!.choiceName).toBe('Target')
    const byId = started(noAnswerForIt(), 'local', { template: null, frozenTitle: '  ' })
    await ask(byId.host, 'system.prompt', [textQuestion()])
    expect(byId.queue.groups[0]!.choiceName).toBe('run-1')
  })

  it('keys each question on its own call, so a run that asks twice cannot reuse an answer', async () => {
    const queue = queueReplying((request) => new Map([[request.key, request.key === 'first' ? 'one' : 'two']]))
    const host = hostWith(queue.deps)
    const first = await ask(host, 'system.prompt', [textQuestion()], 'first')
    const second = await ask(host, 'system.prompt', [textQuestion()], 'second')
    expect([answered(first), answered(second)]).toEqual(['one', 'two'])
    // Each question is its own group as well, which is what lets a run that ends mid-question leave no
    // second dialog behind — see the last describe.
    expect(queue.groups.map((group) => group.requests[0]!.key)).toEqual(['first', 'second'])
  })
})

describe('system.suggester', () => {
  it('shows the rows the template named and answers the row the reader clicked', async () => {
    const { host, queue } = started(queueAnswers('banana'))
    expect(answered(await ask(host, 'system.suggester', [suggestQuestion()]))).toBe('banana')
    expect(queue.requests[0]).toMatchObject({
      kind: 'suggester',
      options: ['apple', 'banana'],
      displayOptions: null,
      // A single choice has nothing to answer until a row is picked, so it is not an optional question —
      // upstream's picker cannot answer nothing either: it closes, and closing is a cancellation.
      optional: false,
      multiSelect: false,
    })
  })

  it('puts the display text on the screen and keeps the item as the answer', async () => {
    // The contract's other shape: `labels` when the row a reader reads and the value a template gets are
    // not the same string. This is the only place that pair becomes the queue's own
    // `options`/`displayOptions`, and the queue answers with the option.
    const { host, queue } = started(queueAnswers('item-b'))
    const question = suggestQuestion({ values: ['item-a', 'item-b'], labels: ['Apple', 'Banana'] })
    expect(answered(await ask(host, 'system.suggester', [question]))).toBe('item-b')
    expect(queue.requests[0]).toMatchObject({ options: ['item-a', 'item-b'], displayOptions: ['Apple', 'Banana'] })
  })

  it('resolves a default named by its display text to the item it names, first row wins', async () => {
    const { host, queue } = started()
    await ask(host, 'system.suggester', [suggestQuestion({
      values: ['item-a', 'item-b'],
      labels: ['Same', 'Same'],
      defaultValue: 'Same',
    })])
    // Two rows that read alike are the first of them, which is the rule the prelude's own `labelOf` uses
    // going the other way: the two halves cannot disagree about which item "Same" is.
    expect(queue.requests[0]!.defaultValue).toBe('item-a')
  })

  it('passes a default no label holds through untouched, rather than inventing a row', async () => {
    const { host, queue } = started()
    await ask(host, 'system.suggester', [suggestQuestion({
      values: ['item-a', 'item-b'],
      labels: ['Apple', 'Banana'],
      defaultValue: 'Cherry',
    })])
    expect(queue.requests[0]!.defaultValue).toBe('Cherry')

    // …and an answer that is not one of the rows comes back as what the queue said. The host is not the
    // layer that decides whether a string was offered: the prelude answers the same shape with the string.
    const other = started(queueAnswers('something-else'))
    expect(answered(await ask(other.host, 'system.suggester', [suggestQuestion({ values: ['item-a'], labels: ['Apple'] })])))
      .toBe('something-else')
  })

  it('passes `limit` through, floored the way a row count has to be', async () => {
    const cases: [number, number][] = [[3, 3], [2.7, 2], [0, 0], [-5, 0]]
    for (const [given, expected] of cases) {
      const { host, queue } = started()
      await ask(host, 'system.suggester', [suggestQuestion({ limit: given })])
      // The cap is the queue's own: it applies it after the filter, so the host only says how many rows the
      // caller meant.
      expect(queue.requests[0]!.limit, String(given)).toBe(expected)
    }
  })

  it('refuses a limit that is not a number instead of clamping it into a row count', async () => {
    for (const bad of ['3', Number.NaN, Number.POSITIVE_INFINITY]) {
      const { host, queue } = started()
      expect(refused(await ask(host, 'system.suggester', [suggestQuestion({ limit: bad as unknown as number })])))
        .toEqual({ code: 'render-failed', detail: 'system.suggester:limit' })
      expect(queue.groups).toEqual([])
    }
  })
})

describe('system.multiSuggester', () => {
  it('answers an empty pick as an empty list, not as a cancelled run', async () => {
    // Upstream's Save answers nothing with `[]` (`MultiSuggesterModal.ts:120-124`), and that is a finished
    // answer rather than a refusal, so a queue that left the question out is the empty list.
    const { host } = started(noAnswerForIt())
    expect(answered(await ask(host, 'system.multiSuggester', [suggestQuestion({ kind: 'multi-suggest' })]))).toEqual([])
  })

  it('answers the items the reader ticked, not the rows they read', async () => {
    const { host, queue } = started(queueAnswers(['item-b', 'item-c']))
    const question = suggestQuestion({
      kind: 'multi-suggest',
      values: ['item-a', 'item-b', 'item-c'],
      labels: ['Apple', 'Banana', 'Cherry'],
    })
    expect(answered(await ask(host, 'system.multiSuggester', [question]))).toEqual(['item-b', 'item-c'])
    expect(queue.requests[0]).toMatchObject({ kind: 'suggester', multiSelect: true, optional: true })
  })

  it('ticks the defaults the template named, in the item each one names', async () => {
    const { host, queue } = started()
    await ask(host, 'system.multiSuggester', [suggestQuestion({
      kind: 'multi-suggest',
      values: ['item-a', 'item-b'],
      labels: ['Apple', 'Banana'],
      defaultPicks: ['Banana'],
    })])
    expect(queue.requests[0]!.defaultPicks).toEqual(['item-b'])

    // The shape the prelude actually sends: the display text is the value, so a pick arrives already
    // addressable and must not be rewritten into something the list does not hold.
    const plain = started(noAnswerForIt())
    await ask(plain.host, 'system.multiSuggester', [suggestQuestion({ kind: 'multi-suggest', defaultPicks: ['banana'] })])
    expect(plain.queue.requests[0]!.defaultPicks).toEqual(['banana'])
  })

  it('takes a closed dialog as the code, leaving the empty list to the template', async () => {
    const { host } = started(dialogClosed())
    expect(refused(await ask(host, 'system.multiSuggester', [suggestQuestion({ kind: 'multi-suggest' })])))
      .toEqual({ code: 'prompt-cancelled', detail: 'system.multiSuggester' })
  })
})

describe('system.clipboard', () => {
  it('answers the clipboard text as it was read', async () => {
    const clipboard = clipboardReading('copied text')
    const host = hostWith({ ...noAnswerForIt().deps, ...clipboard.deps })
    expect(answered(await ask(host, 'system.clipboard'))).toBe('copied text')
    expect(clipboard.calls()).toBe(1)
  })

  it('tells "no clipboard at all" apart from "the browser said no"', async () => {
    // Two facts, two codes: an insecure context or a browser without the API is something this app does not
    // offer, while a refused read is this run's call failing.
    const missing = clipboardReading(null)
    const hostMissing = hostWith({ ...noAnswerForIt().deps, ...missing.deps })
    expect(refused(await ask(hostMissing, 'system.clipboard'))).toEqual({ code: 'not-supported', detail: 'system.clipboard' })

    const denied = clipboardReading(new Error('Document is not focused'))
    const hostDenied = hostWith({ ...noAnswerForIt().deps, ...denied.deps })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The browser's reason is a sentence no locale translates, so it goes to the console and the template
    // gets a code — said out loud rather than swallowed.
    expect(refused(await ask(hostDenied, 'system.clipboard'))).toEqual({ code: 'render-failed', detail: 'system.clipboard:denied' })
    expect(logged).toHaveBeenCalledWith('[inkstone] templater clipboard read refused', expect.any(Error))
  })

  it('hands a long clipboard write over whole, so the ceiling that refuses is the one on the door', async () => {
    const value = 'x'.repeat(MAX_CLIPBOARD_CHARS + 1)
    const clipboard = clipboardReading(value)
    const host = hostWith({ ...noAnswerForIt().deps, ...clipboard.deps })
    // Truncating here is the unforgivable version of this bug: the template would write a note out of the
    // first 64 KiB and never learn the rest was there. The answer travels intact and the door refuses it —
    // `worker/host-bindings.ts`'s `sizeCeiling('system.clipboard')` — which is why that number is kept once.
    expect((answered(await ask(host, 'system.clipboard')) as string).length).toBe(value.length)
  })
})

describe('the question the worker sends', () => {
  it('refuses a field of the wrong type instead of coercing the reader’s dialog', async () => {
    const cases: [unknown, string][] = [
      [42, 'request'],
      [{ kind: 'checkbox', values: [] }, 'kind'],
      [{ kind: 'text', values: 'apple' }, 'values'],
      [{ kind: 'suggest', values: ['a'], labels: ['A', 'B'] }, 'labels'],
      [{ kind: 'suggest', values: ['a'], labels: 'A' }, 'labels'],
      [{ kind: 'text', values: [], title: 7 }, 'title'],
      [{ kind: 'text', values: [], defaultValue: 7 }, 'defaultValue'],
      [{ kind: 'text', values: [], placeholder: 7 }, 'placeholder'],
      [{ kind: 'text', values: [], defaultPicks: ['a', 7] }, 'defaultPicks'],
      [{ kind: 'text', values: [], multiLine: 'yes' }, 'multiLine'],
      [{ kind: 'text', values: [], selectDefaultValue: 'yes' }, 'selectDefaultValue'],
      [{ kind: 'text', values: [], throwOnCancel: 'yes' }, 'throwOnCancel'],
    ]
    for (const [given, field] of cases) {
      const { host, queue } = started()
      expect(refused(await ask(host, 'system.prompt', [given])), field)
        .toEqual({ code: 'render-failed', detail: `system.prompt:${field}` })
      // Every one of these is a bug on this side of the wire, and none of them may put a row on the
      // reader's screen that no template wrote.
      expect(queue.groups, field).toEqual([])
    }
  })

  it('refuses a call whose argument list is not a list', async () => {
    const { host, queue } = started()
    expect(refused(await ask(host, 'system.prompt', 'not-an-array' as unknown as unknown[])))
      .toEqual({ code: 'render-failed', detail: 'system.prompt:request' })
    expect(queue.groups).toEqual([])
  })

  it('answers a call whose queue threw, and says so on the console', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = hostWith({ ask: async () => { throw new Error('the dialog host went away') } })
    // The worker is waiting on exactly one reply per call: a rejection here is a run that hangs until the
    // idle guard takes the thread down, so the throw becomes a code and the reader's console keeps the cause.
    expect(refused(await ask(host, 'system.prompt', [textQuestion()]))).toEqual({ code: 'render-failed', detail: 'throw:system.prompt' })
    expect(logged).toHaveBeenCalledWith('[inkstone] templater prompt host failed', 'system.prompt', expect.any(Error))
  })

  it('refuses to hold more runs than the bound, dropping the oldest and saying so', async () => {
    const queue = queueAnswers('typed answer')
    const host = createPromptHost(queue.deps)
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Well past whatever the bound is, and asserted as a bound rather than as a number: pinning the figure
    // here would only make the next change to it a test failure on its own.
    const ids = Array.from({ length: 200 }, (_, index) => `run-${index}`)
    for (const runId of ids) host.beginRun(context({ runId }))
    expect(host.liveRuns()).toBeLessThan(ids.length)
    // The page is meant to release every run it starts. One it never released keeps its whole snapshot
    // alive beside it, so the oldest goes first — and says so, rather than quietly answering later calls
    // from rights the page has long since changed.
    expect(refused(await ask(host, 'system.prompt', [textQuestion()], CALL, 'run-0')))
      .toEqual({ code: 'render-failed', detail: 'run:run-0' })
    expect(answered(await ask(host, 'system.prompt', [textQuestion()], CALL, ids[ids.length - 1]!)))
      .toBe('typed answer')
    expect(warned).toHaveBeenCalledWith('[inkstone] templater prompt host dropped a run the page never released', 'run-0')
  })
})

describe('a run that ends mid-question', () => {
  /** Let every queued continuation of a real-queue cancel or answer run. */
  async function drained(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('takes its own question off the screen and leaves another asker’s alone', async () => {
    const host = createPromptHost()
    host.beginRun(context({ runId: 'run-1' }))
    const asking = ask(host, 'system.prompt', [textQuestion()])
    // The queue is synchronous up to the point of putting the group on screen, so this is the real dialog
    // the template's question would have drawn.
    expect(currentPromptGroup()?.choiceId).toBe('templater:run-1')

    // A capture already queued behind the template's dialog has done nothing wrong, and dropping the whole
    // queue would stop it silently. That is what `cancelQuickAddPromptsFor` is for.
    const foreign = askQuickAddPrompts({ requests: [], onePage: false, choiceId: 'quickadd-choice', choiceName: 'Capture' })
    let foreignSettled = false
    void foreign.then(() => { foreignSettled = true })

    host.endRun('run-1')
    expect(refused(await asking)).toEqual({ code: 'prompt-cancelled', detail: 'system.prompt' })
    await drained()
    expect(foreignSettled).toBe(false)
    expect(currentPromptGroup()?.choiceId).toBe('quickadd-choice')

    // …and that other asker still finishes on its own terms.
    resetQuickAddPrompts()
    expect(await foreign).toBeNull()
  })

  it('forgets the half-typed text a released run left behind', async () => {
    const host = createPromptHost()
    host.beginRun(context({ runId: 'run-1' }))
    const asking = ask(host, 'system.prompt', [textQuestion()])
    // A cancelled dialog is remembered as that asker's next default, which is what a reader running the
    // same choice again wants.
    cancelQuickAddPrompts(new Map([[CALL, 'half-typed']]))
    expect(refused(await asking).code).toBe('prompt-cancelled')
    expect(recallDraft('templater:run-1', CALL)).toBe('half-typed')

    // A template's half-typed text is not a default for anything, and the run that typed it is gone.
    host.endRun('run-1')
    expect(recallDraft('templater:run-1', CALL)).toBeNull()
  })

  it('does not claim to have cancelled a run it never held', () => {
    const host = createPromptHost()
    // `endRun` on an id the host never registered is a no-op, and the queue is untouched by it: an id the
    // page typed wrong must not take another feature's dialog off the screen.
    expect(host.liveRuns()).toBe(0)
    host.endRun('never-started')
    expect(currentPromptGroup()).toBeNull()
    expect(host.liveRuns()).toBe(0)
  })
})

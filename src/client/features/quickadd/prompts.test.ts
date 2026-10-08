import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PromptRequest } from '../../lib/quickadd/format'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import {
  askQuickAddPrompts,
  cancelQuickAddPrompts,
  clearQuickAddDrafts,
  resetQuickAddPrompts,
} from './prompt-queue'
import { QuickAddPromptHost } from './prompts'
import { QuickAddPromptGate } from './prompt-gate'

function request(over: Partial<PromptRequest> = {}): PromptRequest {
  return {
    kind: 'text',
    key: 'who',
    label: 'Who',
    defaultValue: '',
    options: [],
    displayOptions: null,
    allowCustom: false,
    multiSelect: false,
    multiFormat: 'auto',
    optional: false,
    trim: false,
    caseStyle: null,
    numeric: {},
    dateFormat: null,
    withTime: false,
    ...over,
  }
}

function group(over: Partial<Parameters<typeof askQuickAddPrompts>[0]> = {}) {
  return {
    requests: [request()],
    onePage: false,
    choiceId: 'qa-choice',
    choiceName: 'Meeting note',
    ...over,
  }
}

let rendered: RenderedElement

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  clearQuickAddDrafts()
  resetQuickAddPrompts()
  rendered = renderElement(createElement(QuickAddPromptHost))
})

afterEach(() => {
  rendered.unmount()
  resetQuickAddPrompts()
})

function panel(): HTMLElement {
  const dialog = document.querySelector('[role="dialog"]')
  if (!(dialog instanceof HTMLElement)) throw new Error('no prompt dialog is mounted')
  return dialog
}

function field(root: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
  const input = root.querySelector('input:not([type="checkbox"]), textarea')
  if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement))
    throw new Error('no editable field in the prompt')
  return input
}

// React keeps its own value tracker on the DOM node, so assigning `.value` and firing `input` is
// not enough: the write has to go through the native setter for React to see it as a change.
function type(value: string, target?: HTMLInputElement | HTMLTextAreaElement): void {
  const input = target ?? field(panel())
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string, target: HTMLElement = panel()): Event {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function clickButton(root: HTMLElement, label: string): void {
  const button = [...root.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`no button labelled "${label}"`)
  act(() => {
    button.click()
  })
}

async function untilSettled<T>(promise: Promise<T>): Promise<T> {
  let result: T | undefined
  void promise.then((value) => {
    result = value
  })
  for (let attempt = 0; attempt < 20 && result === undefined; attempt += 1)
    await act(async () => {
      await Promise.resolve()
    })
  if (result === undefined) throw new Error('the prompt never settled')
  return result
}

describe('the prompt queue', () => {
  it('shows the group the run asked for and answers it', async () => {
    const asking = askQuickAddPrompts(group())
    await act(async () => {
      await Promise.resolve()
    })
    expect(panel().textContent).toContain('Who')
    type('Tom', field(panel()))
    clickButton(panel(), t('quickadd.prompt_ok'))
    const answers = await untilSettled(asking)
    expect(answers.get('who')).toBe('Tom')
  })

  it('holds the second group until the first is answered', async () => {
    const first = askQuickAddPrompts(group({ requests: [request({ key: 'a', label: 'A' })] }))
    const second = askQuickAddPrompts(group({ requests: [request({ key: 'b', label: 'B' })] }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(panel().textContent).toContain('A')
    expect(panel().textContent).not.toContain('B')

    type('one')
    clickButton(panel(), t('quickadd.prompt_ok'))
    await untilSettled(first)
    await act(async () => {
      await Promise.resolve()
    })
    expect(panel().textContent).toContain('B')
    type('two')
    clickButton(panel(), t('quickadd.prompt_ok'))
    expect((await untilSettled(second)).get('b')).toBe('two')
  })

  it('settles every waiting promise when the host goes away', async () => {
    const asking = askQuickAddPrompts(group())
    await act(async () => {
      await Promise.resolve()
    })
    rendered.unmount()
    const answers = await untilSettled(asking)
    expect(answers.size).toBe(0)
    rendered = renderElement(createElement(QuickAddPromptHost))
  })

  it('keeps what was typed when the run is cancelled, and offers it back next time', async () => {
    const first = askQuickAddPrompts(group())
    await act(async () => {
      await Promise.resolve()
    })
    type('half written')
    press('Escape', field(panel()))
    expect((await untilSettled(first)).get('who')).toBe('half written')

    const again = askQuickAddPrompts(group({ requests: [request({ optional: true })] }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(field(panel()).value).toBe('half written')
    type('')
    clickButton(panel(), t('quickadd.prompt_ok'))
    expect((await untilSettled(again)).get('who')).toBe('')
    // An answered prompt clears its draft, so a third run starts from the token's own default.
    const third = askQuickAddPrompts(group({ requests: [request({ optional: true })] }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(field(panel()).value).toBe('')
    type('fresh')
    clickButton(panel(), t('quickadd.prompt_ok'))
    expect((await untilSettled(third)).get('who')).toBe('fresh')
  })
})

describe('the gate that mounts the dialogs', () => {
  it('fetches the host only once a prompt is outstanding', async () => {
    rendered.unmount()
    rendered = renderElement(createElement(QuickAddPromptGate))
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    const asking = askQuickAddPrompts(group())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(panel().textContent).toContain('Who')
    type('through the gate')
    clickButton(panel(), t('quickadd.prompt_ok'))
    expect((await untilSettled(asking)).get('who')).toBe('through the gate')
  })
})

describe('the prompt kinds', () => {
  async function open(next: PromptRequest): Promise<void> {
    askQuickAddPrompts(group({ requests: [next] }))
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('commits a text answer on Enter and cancels the keystroke', async () => {
    await open(request())
    const input = field(panel())
    type('typed', input)
    const event = press('Enter', input)
    expect(event.defaultPrevented).toBe(true)
  })

  it('skips an optional prompt with an empty answer', async () => {
    await open(request({ optional: true, defaultValue: 'later' }))
    clickButton(panel(), t('quickadd.prompt_skip'))
  })

  it('offers a picker list and filters it as the author types', async () => {
    await open(request({ kind: 'suggester', options: ['Urgent', 'Normal', 'Someday'] }))
    expect(panel().querySelectorAll('[data-quickadd-option]').length).toBe(3)
    const filter = panel().querySelector('input') as HTMLInputElement
    type('nor', filter)
    const rows = [...panel().querySelectorAll('[data-quickadd-option]')].map((row) => row.getAttribute('data-quickadd-option'))
    expect(rows).toContain('Normal')
    expect(rows).not.toContain('Someday')
  })

  it('lets a picker answer be typed when |custom is on', async () => {
    await open(request({ kind: 'suggester', options: ['a', 'b'], allowCustom: true }))
    type('written by hand', panel().querySelector('input') as HTMLInputElement)
    const custom = panel().querySelector('[data-quickadd-custom]')
    expect(custom?.textContent).toContain('written by hand')
    act(() => {
      custom?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  })

  it('keeps a multi-select open until OK and answers with a list', async () => {
    const asking = askQuickAddPrompts(group({
      requests: [request({ kind: 'suggester', key: 'tags', label: 'Tags', options: ['x', 'y', 'z'], multiSelect: true })],
    }))
    await act(async () => {
      await Promise.resolve()
    })
    const rows = [...panel().querySelectorAll('[data-quickadd-option]')]
    act(() => {
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(panel().textContent).not.toContain(t('quickadd.prompt_selected', { count: 2 }))
    act(() => {
      rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(panel().textContent).toContain(t('quickadd.prompt_selected', { count: 2 }))
    clickButton(panel(), t('quickadd.prompt_ok'))
    expect(await untilSettled(asking)).toEqual(new Map([['tags', ['x', 'y']]]))
  })

  it('answers a checkbox as true or false words', async () => {
    const asking = askQuickAddPrompts(group({ requests: [request({ kind: 'checkbox', key: 'flag', label: 'Flag?' })] }))
    await act(async () => {
      await Promise.resolve()
    })
    clickButton(panel(), t('quickadd.prompt_yes'))
    expect((await untilSettled(asking)).get('flag')).toBe('true')
  })

  it('clamps a slider into its own bounds', async () => {
    await open(request({ kind: 'slider', key: 'n', label: 'N', numeric: { min: 2, max: 6, step: 1 } }))
    expect(panel().textContent).toContain('2')
    const slider = panel().querySelector('input[type="range"]') as HTMLInputElement
    expect(slider.max).toBe('6')
    expect(slider.min).toBe('2')
  })

  it('writes an ISO day from the date shortcuts', async () => {
    const asking = askQuickAddPrompts(group({ requests: [request({ kind: 'date', key: 'day', label: 'Day' })] }))
    await act(async () => {
      await Promise.resolve()
    })
    clickButton(panel(), t('quickadd.prompt_today'))
    clickButton(panel(), t('quickadd.prompt_ok'))
    const answer = (await untilSettled(asking)).get('day')
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    expect(answer).toBe(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
  })

  it('shows what an expression evaluates to before it is accepted', async () => {
    await open(request({ kind: 'math', key: 'sum', label: 'Sum' }))
    type('2*(3+4)')
    expect(panel().textContent).toContain('14')
    type('1/0')
    expect(panel().textContent).toContain(t('quickadd.prompt_math_error', { reason: '1 / 0 has no answer' }).split('{')[0])
  })

  it('applies the token case and trim to the answer it is given', async () => {
    const asking = askQuickAddPrompts(group({
      requests: [request({ key: 'title', label: 'Title', trim: true, caseStyle: 'title' })],
    }))
    await act(async () => {
      await Promise.resolve()
    })
    type('  hello world  ')
    clickButton(panel(), t('quickadd.prompt_ok'))
    expect((await untilSettled(asking)).get('title')).toBe('Hello World')
  })
})

describe('the one-page form', () => {
  it('asks everything at once and refuses to submit a blank required answer', async () => {
    const asking = askQuickAddPrompts(group({
      onePage: true,
      requests: [
        request({ key: 'a', label: 'Alpha' }),
        request({ key: 'b', label: 'Beta', kind: 'suggester', options: ['p', 'q'] }),
        request({ key: 'c', label: 'Gamma', optional: true }),
      ],
    }))
    await act(async () => {
      await Promise.resolve()
    })
    const root = panel()
    expect(root.querySelectorAll('[data-quickadd-page-row]').length).toBe(3)
    const submit = [...root.parentElement?.querySelectorAll('button') ?? []]
      .find((button) => button.textContent?.trim() === t('quickadd.prompt_ok')) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    type('filled', root.querySelector('[data-quickadd-page-row="a"] input') as HTMLInputElement)
    expect(submit.disabled).toBe(true)

    const option = root.querySelector('[data-quickadd-page-row="b"] [data-quickadd-option]') as HTMLElement
    act(() => {
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(submit.disabled).toBe(false)
    act(() => {
      submit.click()
    })
    const answers = await untilSettled(asking)
    expect(answers.get('a')).toBe('filled')
    expect(answers.get('b')).toBe('p')
    expect(answers.get('c')).toBe('')
  })

  it('names the note the run is about to write', async () => {
    askQuickAddPrompts(group({ destination: 'Inbox' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(panel().textContent).toContain('Inbox')
    expect(panel().textContent).toContain('Meeting note')
  })
})

describe('cancelling from the outside', () => {
  it('resolves the outstanding run with no answer', async () => {
    const asking = askQuickAddPrompts(group())
    await act(async () => {
      await Promise.resolve()
    })
    cancelQuickAddPrompts()
    expect((await untilSettled(asking)).size).toBe(0)
  })
})

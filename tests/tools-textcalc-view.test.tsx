// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { TextCalcView } from '../src/client/features/tools/calculator/textcalc/TextCalcView'

const DOCUMENT_KEY = 'inkstone.tools.textcalc.document'
const HISTORY_KEY = 'inkstone.tools.textcalc.history'

function textareaOf(view: RenderedElement): HTMLTextAreaElement {
  const field = view.container.querySelector('textarea')
  expect(field).toBeTruthy()
  return field as HTMLTextAreaElement
}

async function settle(milliseconds = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
}

async function typeInto(view: RenderedElement, value: string): Promise<void> {
  const field = textareaOf(view)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    if (setter) setter.call(field, value)
    else field.value = value
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(220)
}

function clickLabel(view: RenderedElement, label: string): void {
  const button = [...view.container.querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === label,
  )
  expect(button, `button labelled ${label}`).toBeTruthy()
  act(() => { button!.click() })
}

describe('text calculator view', () => {
  beforeAll(async () => {
    await initI18n()
    installTestGlobals()
  })

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('evaluates a document with variables and reports the last value', async () => {
    const view = renderElement(<TextCalcView />)
    await typeInto(view, 'a = 2\nb = a * 3\nb')
    const status = view.container.querySelector('[role="status"]')
    expect(status?.textContent).toBe('6')
    expect(view.container.textContent).toContain('6')
    view.unmount()
  })

  it('keeps an undefined-variable line from blocking later lines', async () => {
    const view = renderElement(<TextCalcView />)
    await typeInto(view, 'a = 2\nb = missing\nc = a * 4')
    expect(view.container.textContent).toContain(t('tools.calculator.textcalc.error.undefined_symbol'))
    const status = view.container.querySelector('[role="status"]')
    expect(status?.textContent).toBe('8')
    view.unmount()
  })

  it('marks both sides of a circular reference', async () => {
    const view = renderElement(<TextCalcView />)
    await typeInto(view, 'a = b\nb = a')
    const matches = view.container.textContent?.match(/Circular reference/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
    view.unmount()
  })

  it('refuses an over-limit document and keeps the text untouched', async () => {
    const text = Array.from({ length: 501 }, () => '1').join('\n')
    const view = renderElement(<TextCalcView />)
    await typeInto(view, text)
    const alert = view.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(t('tools.calculator.textcalc.limit.title'))
    expect(alert?.textContent).toContain('500')
    expect(textareaOf(view).value.split('\n')).toHaveLength(501)
    view.unmount()
  })

  it('persists the document so a remount restores it', async () => {
    const view = renderElement(<TextCalcView />)
    await typeInto(view, '1 + 1')
    expect(localStorage.getItem(DOCUMENT_KEY)).toBe('1 + 1')
    view.unmount()

    const restored = renderElement(<TextCalcView />)
    expect(textareaOf(restored).value).toBe('1 + 1')
    restored.unmount()
  })

  it('records history on Evaluate and persists it', async () => {
    const view = renderElement(<TextCalcView />)
    await typeInto(view, '1 + 1')
    const evaluate = [...view.container.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === t('tools.calculator.textcalc.evaluate'),
    )
    expect(evaluate).toBeTruthy()
    act(() => { evaluate!.click() })
    await settle(20)

    expect(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')).toHaveLength(1)

    clickLabel(view, t('tools.calculator.textcalc.history.title'))
    await settle(20)
    expect(document.body.textContent).toContain('2')
    view.unmount()
  })

  it('applies the thousands separator setting to evaluated values', async () => {
    const view = renderElement(<TextCalcView />)
    clickLabel(view, t('tools.calculator.textcalc.settings.title'))
    const toggle = [...document.body.querySelectorAll('[role="switch"]')].find(
      (node) => node.getAttribute('aria-label') === t('tools.calculator.textcalc.settings.thousands'),
    )
    expect(toggle).toBeTruthy()
    act(() => { (toggle as HTMLButtonElement).click() })
    await typeInto(view, '1234567')
    const status = view.container.querySelector('[role="status"]')
    expect(status?.textContent).toBe('1234567')
    view.unmount()
  })

  it('renders a mobile result list alongside the editor', () => {
    const view = renderElement(<TextCalcView />)
    const mobileList = view.container.querySelector('.md\\:hidden')
    expect(mobileList).toBeTruthy()
    expect(view.container.querySelector('[data-testid="textcalc-root"]')).toBeTruthy()
    view.unmount()
  })
})

// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoEditor, memoImageMarkdown } from './MemoEditor'

let view: RenderedElement | null = null
let lastValue = ''

function renderEditor(value = ''): HTMLElement {
  lastValue = value
  view = renderElement(createElement(MemoEditor, {
    value,
    label: 'Memo',
    placeholder: 'Write a memo',
    onChange: (next: string) => { lastValue = next },
  }))
  return view.container
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`no button named ${label}`)
  return button
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
  if (!button) throw new Error(`no button containing ${text}`)
  return button
}

function openInsertMenu(): HTMLElement {
  click(buttonNamed(document.body, t('memos.composer.insert')))
  const menu = document.querySelector<HTMLElement>('[role="menu"]')
  if (!menu) throw new Error('no insert menu')
  return menu
}

function setFieldValue(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function labeledInput(text: string): HTMLInputElement {
  const label = [...document.querySelectorAll('label')]
    .find((node) => node.textContent?.replace(/\*$/, '').trim() === text)
  const control = label?.htmlFor ? document.getElementById(label.htmlFor) : null
  if (!(control instanceof HTMLInputElement)) throw new Error(`no labeled input ${text}`)
  return control
}

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo editor insert menu', () => {
  it('inserts every block snippet at the cursor', () => {
    const cases = [
      { label: t('memos.composer.table'), snippet: '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n' },
      { label: t('memos.composer.callout'), snippet: '> [!note]\n> ' },
      { label: t('memos.composer.callout_toggle'), snippet: '> [!note]- Title\n> ' },
      { label: t('memos.composer.math_block'), snippet: '$$\n\n$$\n' },
      { label: t('memos.composer.code_block'), snippet: '```ts\n\n```\n' },
      { label: t('memos.composer.divider'), snippet: '---\n' },
    ]
    for (const item of cases) {
      act(() => { view?.unmount() })
      document.body.innerHTML = ''
      renderEditor('start')
      const menu = openInsertMenu()
      click(buttonWithText(menu, item.label))
      expect(lastValue).toContain(item.snippet)
    }
  })

  it('builds image markdown with optional sizes and alignment', () => {
    expect(memoImageMarkdown({ url: '/api/memos/files/a', alt: 'Chart', width: '', height: '', align: 'left' }))
      .toBe('![Chart](/api/memos/files/a)')
    expect(memoImageMarkdown({ url: '/api/memos/files/a', alt: 'Chart', width: '640', height: '', align: 'left' }))
      .toBe('![Chart|640](/api/memos/files/a)')
    expect(memoImageMarkdown({ url: '/api/memos/files/a', alt: 'Chart', width: '640', height: '480', align: 'left' }))
      .toBe('![Chart|640x480](/api/memos/files/a)')
    expect(memoImageMarkdown({ url: '/api/memos/files/a', alt: 'Chart', width: '640', height: '480', align: 'center' }))
      .toBe('::: center\n![Chart|640x480](/api/memos/files/a)\n:::\n')
    expect(memoImageMarkdown({ url: '/api/memos/files/a', alt: 'a|b[c]', width: '', height: '', align: 'right' }))
      .toBe('::: right\n![a\\|b\\[c\\]](/api/memos/files/a)\n:::\n')
  })

  it('opens the image dialog, validates the address and inserts the sized image', () => {
    renderEditor('')
    const menu = openInsertMenu()
    click(buttonWithText(menu, t('memos.composer.image')))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()

    const form = dialog!.querySelector('form')
    expect(form).not.toBeNull()
    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(dialog!.textContent).toContain(t('memos.composer.image_url_required'))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    setFieldValue(labeledInput(t('memos.composer.image_url')), 'javascript:alert(1)')
    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(dialog!.textContent).toContain(t('memos.composer.image_url_invalid'))

    setFieldValue(labeledInput(t('memos.composer.image_url')), '/api/memos/files/chart')
    setFieldValue(labeledInput(t('memos.composer.image_alt')), 'Chart')
    setFieldValue(labeledInput(t('memos.composer.image_width')), '640')
    setFieldValue(labeledInput(t('memos.composer.image_height')), '480')
    click(buttonWithText(dialog!, t('memos.composer.image_align_center')))
    click(buttonWithText(dialog!, t('memos.composer.insert')))

    expect(lastValue).toContain('::: center\n![Chart|640x480](/api/memos/files/chart)\n:::\n')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('refuses a non-numeric image size', () => {
    renderEditor('')
    click(buttonWithText(openInsertMenu(), t('memos.composer.image')))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const form = dialog!.querySelector('form')!
    setFieldValue(labeledInput(t('memos.composer.image_url')), '/api/memos/files/chart')
    setFieldValue(labeledInput(t('memos.composer.image_width')), 'wide')
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(dialog!.textContent).toContain(t('memos.composer.image_size_invalid'))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

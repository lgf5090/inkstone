// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoQuickFind } from './MemoQuickFind'

const api = vi.hoisted(() => ({
  views: { validate: vi.fn() },
}))

vi.mock('../api', () => ({ memosApi: api }))

let view: RenderedElement | null = null

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(text))
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function render(onClose = vi.fn()): ReturnType<typeof vi.fn> {
  view = renderElement(createElement(MemoQuickFind, {
    open: true,
    query: { q: '', filter: '' },
    onClose,
  }))
  return onClose
}

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/memos?tag=work&quick=pinned')
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the quick find dialog', () => {
  it('writes plain words into q and keeps the rest of the address', async () => {
    const onClose = render()
    const input = document.querySelector<HTMLInputElement>('input[data-autofocus]')
    expect(input).not.toBeNull()
    typeInto(input!, 'ship it')
    click(buttonByText(t('memos.quick_find.submit')))
    await flush()

    const params = new URLSearchParams(window.location.search)
    expect(params.get('q')).toBe('ship it')
    expect(params.get('tag')).toBe('work')
    expect(params.get('quick')).toBe('pinned')
    expect(api.views.validate).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('checks a CEL expression and stays open with the server message when it is invalid', async () => {
    api.views.validate.mockResolvedValue({ ok: false, error: { message: 'unexpected token', position: 3 } })
    const onClose = render()
    click(buttonByText(t('memos.quick_find.mode_cel')))
    const input = document.querySelector<HTMLInputElement>('input[data-autofocus]')
    typeInto(input!, 'bad (')
    click(buttonByText(t('memos.quick_find.submit')))
    await flush()

    expect(api.views.validate).toHaveBeenCalledWith('bad (')
    expect(document.body.textContent).toContain('unexpected token')
    expect(document.body.textContent).toContain(t('memos.views.validation_position', { position: 4 }))
    expect(onClose).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?tag=work&quick=pinned')
  })

  it('applies a CEL expression only after the server accepts it', async () => {
    api.views.validate.mockResolvedValue({ ok: true })
    const onClose = render()
    click(buttonByText(t('memos.quick_find.mode_cel')))
    const input = document.querySelector<HTMLInputElement>('input[data-autofocus]')
    typeInto(input!, 'has_incomplete_tasks')
    click(buttonByText(t('memos.quick_find.submit')))
    await flush()

    expect(api.views.validate).toHaveBeenCalledWith('has_incomplete_tasks')
    expect(new URLSearchParams(window.location.search).get('filter')).toBe('has_incomplete_tasks')
    expect(new URLSearchParams(window.location.search).get('tag')).toBe('work')
    expect(onClose).toHaveBeenCalled()
  })

  it('reports a validation request failure without navigating', async () => {
    api.views.validate.mockRejectedValue(new Error('offline'))
    const onClose = render()
    click(buttonByText(t('memos.quick_find.mode_cel')))
    typeInto(document.querySelector<HTMLInputElement>('input[data-autofocus]')!, 'pinned')
    click(buttonByText(t('memos.quick_find.submit')))
    await flush()

    expect(document.body.textContent).toContain(t('api.error.unknown'))
    expect(onClose).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?tag=work&quick=pinned')
  })

  it('refuses an empty query', async () => {
    const onClose = render()
    click(buttonByText(t('memos.quick_find.submit')))
    await flush()
    expect(document.body.textContent).toContain(t('memos.quick_find.required'))
    expect(onClose).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?tag=work&quick=pinned')
  })
})

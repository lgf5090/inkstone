// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoView } from '@shared/memos/types'
import { ConfirmHost } from '../../../components/overlay'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoViewsPage } from './MemoViewsPage'

const api = vi.hoisted(() => ({
  views: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), validate: vi.fn() },
}))

vi.mock('../api', () => ({ memosApi: api }))

function view(overrides: Partial<MemoView> = {}): MemoView {
  return {
    id: 'view-1',
    title: 'Open tasks',
    filter: 'has_task_list && has_incomplete_tasks',
    icon: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

let rendered: RenderedElement | null = null

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function render(): HTMLElement {
  rendered = renderElement(createElement(
    Fragment,
    null,
    createElement(MemoViewsPage),
    createElement(ConfirmHost),
  ))
  return rendered.container
}

function openCreate(): void {
  click(buttonNamed(t('memos.views.new')))
}

beforeEach(async () => {
  await initI18n()
  window.history.replaceState(null, '', '/memos/views')
  vi.clearAllMocks()
  api.views.list.mockResolvedValue({ views: [] })
  api.views.validate.mockResolvedValue({ ok: true })
  api.views.create.mockImplementation((input: { title: string; filter: string; icon?: string }) =>
    Promise.resolve(view({ id: 'view-2', title: input.title, filter: input.filter, icon: input.icon ?? '' })))
  api.views.update.mockImplementation((id: string, input: Partial<MemoView>) =>
    Promise.resolve(view({ ...input, id })))
  api.views.delete.mockResolvedValue({ ok: true })
})

afterEach(() => {
  act(() => { rendered?.unmount() })
  rendered = null
  document.body.innerHTML = ''
})

describe('the saved views page', () => {
  it('lists saved views and shows the empty state', async () => {
    api.views.list.mockResolvedValue({ views: [view()] })
    const host = render()
    await flush()
    expect(host.textContent).toContain('Open tasks')
    expect(host.textContent).toContain('has_task_list && has_incomplete_tasks')
    expect(host.textContent).toContain(t('memos.views.examples_title'))
    expect(host.querySelectorAll('[data-memo-view-example]')).toHaveLength(21)

    act(() => { rendered?.unmount() })
    rendered = null
    api.views.list.mockResolvedValue({ views: [] })
    const empty = render()
    await flush()
    expect(empty.textContent).toContain(t('memos.views.empty_title'))
  })

  it('validates before creating and points at the failing character', async () => {
    const host = render()
    await flush()
    openCreate()
    setValue(document.querySelector<HTMLInputElement>('input[data-autofocus]')!, 'Reading list')
    const filter = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
    setValue(filter, 'foo == 1')
    api.views.validate.mockResolvedValueOnce({
      ok: false,
      error: { message: 'unknown field "foo"', position: 0 },
    })
    click(buttonNamed(t('memos.views.check')))
    await flush()
    expect(document.body.textContent).toContain(
      t('memos.views.validation_error', { message: 'unknown field "foo"' }),
    )
    expect(document.body.textContent).toContain(
      t('memos.views.validation_position', { position: 1 }),
    )
    expect(api.views.create).not.toHaveBeenCalled()

    setValue(filter, 'pinned')
    click(buttonNamed(t('memos.views.check')))
    await flush()
    expect(document.body.textContent).toContain(t('memos.views.filter_valid'))

    api.views.list.mockResolvedValue({
      views: [view({ id: 'view-2', title: 'Reading list', filter: 'pinned' })],
    })
    click(buttonNamed(t('memos.common.save')))
    await flush(3)
    expect(api.views.create).toHaveBeenCalledWith({
      title: 'Reading list',
      filter: 'pinned',
      icon: '',
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host.textContent).toContain('Reading list')
  })

  it('starts a new view from an example expression', async () => {
    render()
    await flush()
    click(buttonNamed('pinned == false'))
    const filter = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
    expect(filter?.value).toBe('pinned == false')
  })

  it('edits and deletes a saved view', async () => {
    api.views.list.mockResolvedValue({ views: [view()] })
    render()
    await flush()
    click(document.querySelector(`button[aria-label="${t('memos.views.edit_named', { title: 'Open tasks' })}"]`)!)
    const title = document.querySelector<HTMLInputElement>('input[data-autofocus]')
    expect(title?.value).toBe('Open tasks')
    setValue(title!, 'Open tasks this week')
    api.views.list.mockResolvedValue({ views: [view({ title: 'Open tasks this week' })] })
    click(buttonNamed(t('memos.common.save')))
    await flush(3)
    expect(api.views.update).toHaveBeenCalledWith('view-1', {
      title: 'Open tasks this week',
      filter: 'has_task_list && has_incomplete_tasks',
      icon: '',
    })

    click(document.querySelector(`button[aria-label="${t('memos.views.delete_named', { title: 'Open tasks this week' })}"]`)!)
    expect(document.body.textContent).toContain(
      t('memos.views.delete_description', { title: 'Open tasks this week' }),
    )
    api.views.list.mockResolvedValue({ views: [] })
    click(buttonNamed(t('memos.common.delete')))
    await flush(3)
    expect(api.views.delete).toHaveBeenCalledWith('view-1')
  })

  it('shows loading and error states with a retry', async () => {
    api.views.list.mockImplementationOnce(() => new Promise(() => {}))
    const loading = render()
    await flush()
    expect(loading.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    act(() => { rendered?.unmount() })
    rendered = null

    api.views.list.mockRejectedValueOnce(new Error('offline'))
    const failed = render()
    await flush()
    expect(failed.textContent).toContain(t('memos.views.error_title'))
    click(buttonNamed(t('memos.common.retry')))
    await flush()
    expect(failed.textContent).toContain(t('memos.views.empty_title'))
  })
})

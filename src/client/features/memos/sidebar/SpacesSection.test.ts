// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoSpace } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { SpacesSection, type SpacesSectionProps } from './SpacesSection'

const api = vi.hoisted(() => ({
  spaces: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  stats: { get: vi.fn() },
}))

const routing = vi.hoisted(() => ({ navigateMemoUrl: vi.fn() }))

vi.mock('../api', () => ({ memosApi: api }))
vi.mock('../url-state', () => routing)

function space(overrides: Partial<MemoSpace> = {}): MemoSpace {
  return {
    id: 'space-1',
    title: 'Research',
    description: '',
    icon: '',
    memoCount: 2,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

let view: RenderedElement | null = null

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function render(overrides: Partial<SpacesSectionProps> = {}): HTMLElement {
  const props: SpacesSectionProps = {
    spaces: [space()],
    status: 'ready',
    error: null,
    activeSpaceId: null,
    onRetry: () => {},
    onNavigate: () => {},
    ...overrides,
  }
  view = renderElement(createElement(
    Fragment,
    null,
    createElement(SpacesSection, props),
  ))
  return view.container
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function menuItem(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.includes(text))
  if (!found) throw new Error(`no menu item named ${text}`)
  return found
}

function openActions(title = 'Research'): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('memos.spaces.actions', { title })}"]`,
  )
  if (!trigger) throw new Error('no space actions button')
  click(trigger)
}

function radioNamed(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="radio"]')]
    .find((radio) => radio.textContent?.trim() === text)
  if (!found) throw new Error(`no radio named ${text}`)
  return found
}

function openDeleteDialog(): HTMLElement {
  openActions()
  click(menuItem(t('memos.spaces.delete')))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('no delete dialog')
  return dialog
}

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  api.spaces.create.mockResolvedValue(space({ id: 'space-2', title: 'Studio' }))
  api.spaces.update.mockResolvedValue(space({ title: 'Research 2' }))
  api.spaces.delete.mockResolvedValue({ ok: true })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the spaces section', () => {
  it('creates a space from the modal form', async () => {
    const host = render()
    const create = host.querySelector<HTMLButtonElement>(`button[aria-label="${t('memos.spaces.create')}"]`)
    expect(create).not.toBeNull()
    click(create!)
    const title = document.querySelector<HTMLInputElement>('input[data-autofocus]')
    expect(title).not.toBeNull()
    setInputValue(title!, 'Studio')
    click(buttonNamed(t('memos.common.save')))
    await flush()
    expect(api.spaces.create).toHaveBeenCalledWith({ title: 'Studio', description: '', icon: '' })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reports a missing name without calling the API', async () => {
    const host = render()
    click(host.querySelector(`button[aria-label="${t('memos.spaces.create')}"]`)!)
    click(buttonNamed(t('memos.common.save')))
    await flush()
    expect(api.spaces.create).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(t('memos.spaces.title_required'))
  })

  it('edits a space through its row menu', async () => {
    render()
    openActions()
    click(menuItem(t('memos.spaces.edit')))
    const title = document.querySelector<HTMLInputElement>('input[data-autofocus]')
    expect(title?.value).toBe('Research')
    setInputValue(title!, 'Research 2')
    click(buttonNamed(t('memos.common.save')))
    await flush()
    expect(api.spaces.update).toHaveBeenCalledWith('space-1', {
      title: 'Research 2',
      description: '',
      icon: '',
    })
  })

  it('unfiles the memos when the delete dialog keeps its default', async () => {
    render()
    const dialog = openDeleteDialog()
    expect(dialog.textContent).toContain(t('memos.spaces.delete_description', { title: 'Research', count: 2 }))
    expect(radioNamed(t('memos.spaces.delete_mode_unfile')).getAttribute('aria-checked')).toBe('true')
    expect(dialog.textContent).toContain(t('memos.spaces.delete_mode_unfile_hint'))
    click(buttonNamed(t('memos.spaces.delete_confirm')))
    await flush()
    expect(api.spaces.delete).toHaveBeenCalledWith('space-1', 'unfile')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(routing.navigateMemoUrl).not.toHaveBeenCalled()
  })

  it('deletes the memos with the space when the destructive mode is chosen', async () => {
    render()
    const dialog = openDeleteDialog()
    click(radioNamed(t('memos.spaces.delete_mode_delete')))
    expect(radioNamed(t('memos.spaces.delete_mode_delete')).getAttribute('aria-checked')).toBe('true')
    expect(dialog.textContent).toContain(t('memos.spaces.delete_mode_delete_hint'))
    click(buttonNamed(t('memos.spaces.delete_confirm')))
    await flush()
    expect(api.spaces.delete).toHaveBeenCalledWith('space-1', 'delete')
  })

  it('leaves the space route after deleting the active space', async () => {
    render({ activeSpaceId: 'space-1' })
    openDeleteDialog()
    click(buttonNamed(t('memos.spaces.delete_confirm')))
    await flush()
    expect(api.spaces.delete).toHaveBeenCalledWith('space-1', 'unfile')
    expect(routing.navigateMemoUrl).toHaveBeenCalledWith(MEMOS_APP_PATH, '')
  })

  it('leaves the space alone when the delete dialog is cancelled', async () => {
    render()
    openDeleteDialog()
    click(buttonNamed(t('memos.common.cancel')))
    await flush()
    expect(api.spaces.delete).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reports a delete failure in the sidebar', async () => {
    api.spaces.delete.mockRejectedValueOnce(new Error('offline'))
    render()
    openDeleteDialog()
    click(buttonNamed(t('memos.spaces.delete_confirm')))
    await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain(t('memos.spaces.delete_failed'))
    expect(document.body.textContent).toContain(t('api.error.unknown'))
  })

  it('shows the loading and error states', async () => {
    const loading = render({ spaces: [], status: 'loading' })
    expect(loading.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    act(() => { view?.unmount() })
    view = null

    const onRetry = vi.fn()
    const failed = render({ spaces: [], status: 'error', error: 'offline', onRetry })
    expect(failed.textContent).toContain('offline')
    click(buttonNamed(t('memos.common.retry')))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

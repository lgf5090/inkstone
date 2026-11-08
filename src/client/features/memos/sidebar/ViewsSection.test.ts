// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { ViewsSection } from './ViewsSection'

const api = vi.hoisted(() => ({
  views: { list: vi.fn() },
}))

vi.mock('../api', () => ({ memosApi: api }))

let view: RenderedElement | null = null

function render(search = ''): HTMLElement {
  view = renderElement(createElement(ViewsSection, { search, onNavigate: () => {} }))
  return view.container
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`no button containing ${text}`)
  return button
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', MEMOS_APP_PATH)
  api.views.list.mockResolvedValue({ views: [] })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  window.history.replaceState(null, '', '/')
})

describe('the saved views sidebar section', () => {
  it('turns the empty state into a primary way to create a view', async () => {
    const container = render()
    await flush()
    expect(container.textContent).toContain(t('memos.sidebar.views_empty'))
    expect(container.textContent).toContain(t('memos.sidebar.views_empty_hint'))
    const create = buttonWithText(container, t('memos.sidebar.views_create'))
    act(() => { create.click() })
    expect(window.location.pathname).toBe(`${MEMOS_APP_PATH}/views`)
  })

  it('offers to save the live filter and carries it to the views page', async () => {
    window.history.replaceState(null, '', `${MEMOS_APP_PATH}?tag=work`)
    const container = render('?tag=work')
    await flush()
    const save = [...container.querySelectorAll<HTMLAnchorElement>('a')]
      .find((anchor) => anchor.textContent?.includes(t('memos.sidebar.views_save_current')))
    expect(save).not.toBeUndefined()
    expect(window.location.pathname).toBe(MEMOS_APP_PATH)
    expect(save!.getAttribute('href')).toContain('/views?filter=')
  })

  it('does not offer to save a filter when none is active', async () => {
    const container = render()
    await flush()
    expect(container.textContent).not.toContain(t('memos.sidebar.views_save_current'))
  })
})

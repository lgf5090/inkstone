// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memo } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoMapPage } from './MemoMapPage'

const api = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('../api', () => ({ memosApi: { list: api.list } }))

interface MemoMapDoubleProps {
  groups: { memoIds: string[]; latitude: number; longitude: number }[]
  label: string
  initialView: unknown
  onSelect: (selection: { latitude: number; longitude: number; memoIds: string[] }) => void
  onBlankClick: () => void
  onViewChange: (view: { latitude: number; longitude: number; zoom: number }) => void
}

interface MemoComposerDoubleProps {
  spaceId?: string | null
  initialLocation?: { latitude: number; longitude: number; placeholder: string } | null
  onSaved?: (memo: Memo) => void
  onCancel?: () => void
}

vi.mock('../components/MemoComposer', async () => {
  const React = await import('react')
  return {
    MemoComposer: (props: MemoComposerDoubleProps) => React.createElement(
      'div',
      {
        'data-testid': 'memo-composer-double',
        'data-space': props.spaceId ?? '',
        'data-location': JSON.stringify(props.initialLocation ?? null),
      },
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => props.onSaved?.({
            id: 'new-memo',
            location: props.initialLocation ?? null,
          } as Memo),
        },
        'save-memo-double',
      ),
      React.createElement('button', { type: 'button', onClick: props.onCancel }, 'cancel-memo-double'),
    ),
  }
})

vi.mock('../components/MemoMap', async () => {
  const React = await import('react')
  return {
    MemoMap: (props: MemoMapDoubleProps) => React.createElement(
      'div',
      { 'data-testid': 'memo-map', 'aria-label': props.label },
      React.createElement('span', { 'data-testid': 'group-count' }, String(props.groups.length)),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            const group = props.groups[0]
            if (!group) return
            props.onSelect({
              latitude: group.latitude,
              longitude: group.longitude,
              memoIds: group.memoIds,
            })
          },
        },
        'pick-group',
      ),
      React.createElement('button', { type: 'button', onClick: props.onBlankClick }, 'blank-map'),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => props.onViewChange({ latitude: 10, longitude: 20, zoom: 8 }),
        },
        'move-map',
      ),
    ),
  }
})

function memo(id: string, overrides: Partial<Memo> = {}): Memo {
  return {
    id,
    content: 'body',
    title: '',
    snippet: '',
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: null,
    location: { placeholder: 'Home', latitude: 37.7749, longitude: -122.4194 },
    properties: {
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: true,
    },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 1,
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

async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function renderPage(onOpenMemo?: (id: string) => void): HTMLElement {
  rendered = renderElement(createElement(
    Fragment,
    null,
    createElement(MemoMapPage, { onOpenMemo }),
  ))
  return rendered.container
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/memos/map')
  api.list.mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  act(() => { rendered?.unmount() })
  rendered = null
  document.body.innerHTML = ''
})

describe('the memo map page', () => {
  it('loads located memos, lists them with links and coordinates', async () => {
    api.list.mockResolvedValue({
      items: [memo('m-1', { snippet: 'Coffee downtown' }), memo('m-2', { location: { placeholder: '', latitude: 1, longitude: 2 } })],
      nextCursor: null,
    })
    const open = vi.fn()
    const container = renderPage(open)
    await flush()

    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'has_location', limit: 100, spaceId: undefined }),
      expect.any(AbortSignal),
    )
    expect(container.textContent).toContain(t('memos.map.count', { count: 2 }))
    expect(container.querySelector('[data-testid="memo-map"]')?.getAttribute('aria-label'))
      .toBe(t('memos.map.region'))
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="/memos/m/"]')]
    expect(links).toHaveLength(2)
    expect(links[0].textContent).toContain('Home')
    expect(links[0].textContent).toContain('Coffee downtown')
    expect(links[1].textContent).toContain('1, 2')

    click(links[0])
    expect(open).toHaveBeenCalledWith('m-1')
  })

  it('scopes the request to a space route', async () => {
    window.history.replaceState(null, '', '/memos/spaces/space-1/map')
    renderPage()
    await flush()
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 'space-1' }),
      expect.any(AbortSignal),
    )
  })

  it('shows the filtered empty state and clears the filter', async () => {
    window.history.replaceState(null, '', '/memos/map?filter=pinned')
    const container = renderPage()
    await flush()

    expect(container.textContent).toContain(t('memos.map.empty_filtered_title'))
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'has_location && (pinned)' }),
      expect.any(AbortSignal),
    )
    click(buttonNamed(t('memos.map.clear_filters')))
    await flush()
    expect(window.location.search).toBe('')
    expect(api.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: 'has_location' }),
      expect.any(AbortSignal),
    )
  })

  it('shows the plain empty state without a filter', async () => {
    const container = renderPage()
    await flush()
    expect(container.textContent).toContain(t('memos.map.empty_title'))
    expect(container.textContent).not.toContain(t('memos.map.empty_filtered_title'))
  })

  it('retries after a failed load', async () => {
    api.list
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [memo('m-1')], nextCursor: null })
    const container = renderPage()
    await flush()
    expect(container.textContent).toContain(t('memos.feed.error_title'))

    click(buttonNamed(t('memos.common.retry')))
    await flush()
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Home')
  })

  it('opens the selected location from the URL', async () => {
    window.history.replaceState(null, '', '/memos/map?memo=m-1')
    api.list.mockResolvedValue({ items: [memo('m-1')], nextCursor: null })
    const container = renderPage()
    await flush()

    expect(container.textContent).toContain(t('memos.map.selected_location'))
    expect(container.textContent).toContain('37.7749, -122.4194')
  })

  it('writes selected points into the URL and clears them on a blank map click', async () => {
    api.list.mockResolvedValue({ items: [memo('m-1')], nextCursor: null })
    const container = renderPage()
    await flush()

    click(buttonNamed('pick-group'))
    expect(window.location.search).toContain('memo=m-1')
    expect(container.textContent).toContain(t('memos.map.selected_location'))

    click(buttonNamed('blank-map'))
    expect(window.location.search).not.toContain('memo=')
    expect(container.textContent).not.toContain(t('memos.map.selected_location'))
  })

  it('replaces the URL view when the map moves', async () => {
    window.history.replaceState(null, '', '/memos/map?q=coffee')
    api.list.mockResolvedValue({ items: [memo('m-1')], nextCursor: null })
    renderPage()
    await flush()

    click(buttonNamed('move-map'))
    const params = new URLSearchParams(window.location.search)
    expect(params.get('lat')).toBe('10')
    expect(params.get('lng')).toBe('20')
    expect(params.get('zoom')).toBe('8')
    expect(params.get('q')).toBe('coffee')
  })

  it('reads every page up to the map cap', async () => {
    api.list
      .mockResolvedValueOnce({ items: [memo('m-1')], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [memo('m-2', { location: { placeholder: 'Two', latitude: 2, longitude: 2 } })], nextCursor: null })
    const container = renderPage()
    await flush()

    expect(api.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'next' }),
      expect.any(AbortSignal),
    )
    expect(container.textContent).toContain(t('memos.map.count', { count: 2 }))
  })

  it('creates a memo at the selected location and refreshes the map', async () => {
    window.history.replaceState(null, '', '/memos/spaces/space-1/map')
    api.list.mockResolvedValue({ items: [memo('m-1')], nextCursor: null })
    const container = renderPage()
    await flush()

    expect(container.textContent).not.toContain(t('memos.map.new_memo'))
    click(buttonNamed('pick-group'))
    await flush()
    click(buttonNamed(t('memos.map.new_memo')))
    await flush()

    const composer = document.querySelector<HTMLElement>('[data-testid="memo-composer-double"]')
    expect(composer).not.toBeNull()
    expect(composer!.dataset.space).toBe('space-1')
    const location = JSON.parse(composer!.dataset.location ?? 'null') as {
      latitude: number
      longitude: number
      placeholder: string
    }
    expect(location.latitude).toBe(37.7749)
    expect(location.longitude).toBe(-122.4194)
    expect(location.placeholder).toContain('37.7749')
    expect(location.placeholder).toContain('-122.4194')

    click(buttonNamed('save-memo-double'))
    await flush()
    expect(document.querySelector('[data-testid="memo-composer-double"]')).toBeNull()
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('closes the composer without reloading when creation is cancelled', async () => {
    api.list.mockResolvedValue({ items: [memo('m-1')], nextCursor: null })
    renderPage()
    await flush()
    click(buttonNamed('pick-group'))
    await flush()
    click(buttonNamed(t('memos.map.new_memo')))
    await flush()

    click(buttonNamed('cancel-memo-double'))
    await flush()
    expect(document.querySelector('[data-testid="memo-composer-double"]')).toBeNull()
    expect(api.list).toHaveBeenCalledTimes(1)
  })
})

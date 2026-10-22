// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMO_DISPLAY_DEFAULTS } from '@shared/memos/constants'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import type { MemoQuickFilter } from '../url-state'
import { MemoFilters } from './MemoFilters'

let view: RenderedElement | null = null

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

function render(quick: MemoQuickFilter[]): {
  onToggleQuick: ReturnType<typeof vi.fn>
  onRemoveQuick: ReturnType<typeof vi.fn>
} {
  const onToggleQuick = vi.fn()
  const onRemoveQuick = vi.fn()
  view = renderElement(createElement(MemoFilters, {
    query: { q: '', tag: null, filter: '', quick },
    display: MEMO_DISPLAY_DEFAULTS,
    onSearch: () => {},
    onRemoveTag: () => {},
    onRemoveFilter: () => {},
    onToggleQuick,
    onRemoveQuick,
    onClear: () => {},
    onSortChange: () => {},
    onDisplayChange: () => {},
  }))
  return { onToggleQuick, onRemoveQuick }
}

beforeEach(async () => {
  await initI18n()
  window.history.replaceState(null, '', '/memos')
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo filter row', () => {
  it('shows a chip for every enabled quick filter and removes one on press', () => {
    const { onRemoveQuick } = render(['pinned', 'has_link'])
    expect(view!.container.textContent).toContain(t('memos.feed.quick_pinned'))
    expect(view!.container.textContent).toContain(t('memos.feed.quick_has_link'))

    const chip = view!.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('memos.feed.remove_quick', { filter: t('memos.feed.quick_pinned') })}"]`,
    )
    expect(chip).not.toBeNull()
    click(chip!)
    expect(onRemoveQuick).toHaveBeenCalledWith('pinned')
  })

  it('toggles a quick filter from the filter menu', () => {
    const { onToggleQuick } = render([])
    const trigger = view!.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('memos.feed.filters')}"]`,
    )
    expect(trigger).not.toBeNull()
    click(trigger!)

    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
      .find((button) => button.textContent?.includes(t('memos.feed.quick_has_link')))
    expect(item).toBeDefined()
    expect(item?.getAttribute('aria-checked')).toBe('false')
    click(item!)
    expect(onToggleQuick).toHaveBeenCalledWith('has_link')
  })

  it('opens the advanced search from the search field', () => {
    render([])
    const trigger = view!.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('memos.feed.quick_find')}"]`,
    )
    expect(trigger).not.toBeNull()
    click(trigger!)
    expect(document.body.textContent).toContain(t('memos.quick_find.title'))
  })
})

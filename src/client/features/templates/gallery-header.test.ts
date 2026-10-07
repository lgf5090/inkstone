import { act, createElement, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { GalleryHeader } from './gallery-header'

let root: Root
let container: HTMLDivElement
const openMore = vi.fn()
const queryChanges: string[] = []

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
}

async function render(query: string) {
  const searchRef = { current: null } as RefObject<HTMLInputElement | null>
  const moreButtonRef = { current: null } as RefObject<HTMLButtonElement | null>
  await act(async () => {
    root.render(createElement(GalleryHeader, {
      query,
      onQueryChange: (value: string) => queryChanges.push(value),
      searchRef,
      onSearchFocusChange: () => {},
      selectMode: false,
      onToggleSelectMode: () => {},
      onOpenHelp: () => {},
      onNewTemplate: () => {},
      moreButtonRef,
      onOpenMore: openMore,
      onClose: () => {},
    }))
    await Promise.resolve()
  })
}

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  queryChanges.length = 0
  openMore.mockReset()
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('the template gallery header', () => {
  it('names the overflow trigger after the menu it opens, not after one of its items', async () => {
    await render('')
    expect(buttonNamed(t('common.more_actions'))).toBeDefined()
    expect(container.innerHTML.includes(t('templates.export_library'))).toBe(false)
  })

  it('opens the overflow menu from that trigger', async () => {
    await render('')
    const trigger = buttonNamed(t('common.more_actions'))!
    await act(async () => {
      trigger.click()
      await Promise.resolve()
    })
    expect(openMore).toHaveBeenCalledTimes(1)
  })

  it('claims Escape only while the search box has something to cancel', async () => {
    await render('')
    const input = container.querySelector<HTMLInputElement>('input')!
    expect(input.hasAttribute('data-owns-escape')).toBe(false)
    await render('sprint')
    expect(container.querySelector<HTMLInputElement>('input')!.getAttribute('data-owns-escape')).toBe('1')
  })

  it('clears the query through the dedicated control', async () => {
    await render('sprint')
    const clear = buttonNamed(t('common.clear'))!
    await act(async () => {
      clear.click()
      await Promise.resolve()
    })
    expect(queryChanges).toEqual([''])
  })
})

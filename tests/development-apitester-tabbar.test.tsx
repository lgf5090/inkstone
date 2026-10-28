// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CollectionNode } from '../src/shared/development/api-tester/types'
import { defaultRequest } from '../src/shared/development/api-tester/state'
import { TabBar } from '../src/client/features/development/api-tester/components/TabBar'
import { initI18n } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'

const views: RenderedElement[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.unmount()
})

beforeAll(async () => {
  await initI18n()
})

function requestNode(id: string, name: string): CollectionNode {
  return {
    id,
    type: 'request',
    kind: 'rest',
    name,
    parentId: null,
    order: 0,
    tags: [],
    updatedAt: 0,
    request: { ...defaultRequest(), method: 'GET', url: `https://api.example.com/${id}` },
  }
}

function renderTabs(activeId: string, onSelect = vi.fn(), onClose = vi.fn()) {
  const tabs = [requestNode('tab-a', 'Alpha'), requestNode('tab-b', 'Beta')]
  const view = renderElement(
    <TabBar tabs={tabs} activeId={activeId} results={{}} loading={{}} onSelect={onSelect} onClose={onClose} />,
  )
  views.push(view)
  const buttons = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  return { view, buttons, onSelect, onClose }
}

function press(element: HTMLElement, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('API tester tab bar keyboard', () => {
  it('moves selection and focus between tabs with the arrow keys', () => {
    const { buttons, onSelect } = renderTabs('tab-a')
    act(() => buttons[0].focus())

    press(buttons[0], 'ArrowRight')
    expect(onSelect).toHaveBeenCalledWith('tab-b')
    expect(document.activeElement).toBe(buttons[1])

    press(buttons[1], 'ArrowLeft')
    expect(onSelect).toHaveBeenLastCalledWith('tab-a')
    expect(document.activeElement).toBe(buttons[0])

    press(buttons[0], 'ArrowLeft')
    expect(onSelect).toHaveBeenLastCalledWith('tab-b')
    expect(document.activeElement).toBe(buttons[1])
  })

  it('closes the focused tab with Delete and moves focus to the surviving tab', () => {
    const { buttons, onClose } = renderTabs('tab-a')
    act(() => buttons[0].focus())

    press(buttons[0], 'Delete')
    expect(onClose).toHaveBeenCalledWith('tab-a')
    expect(document.activeElement).toBe(buttons[1])
  })

  it('keeps the decorative close button out of the tab order', () => {
    const { view } = renderTabs('tab-a')
    const close = view.container.querySelector<HTMLButtonElement>('button[title]')
    expect(close?.getAttribute('aria-hidden')).toBe('true')
    expect(close?.getAttribute('tabindex')).toBe('-1')
  })
})

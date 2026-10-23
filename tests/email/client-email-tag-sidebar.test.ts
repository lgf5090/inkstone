// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailTag } from '@shared/email/model'
import { renderElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { api } from '../../src/client/lib/api'
import { prompt } from '../../src/client/components/overlay'
import { EmailTagSidebar } from '../../src/client/features/email/EmailTagSidebar'

vi.mock('../../src/client/components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/components/overlay')>()
  return {
    ...actual,
    prompt: vi.fn(async () => null),
    confirm: vi.fn(async () => false),
  }
})

const tags: EmailTag[] = [
  { id: 't-work', name: 'work', color: '#3b82f6', count: 2 },
  { id: 't-meeting', name: 'work/meeting', color: null, count: 1 },
]

beforeEach(() => {
  vi.mocked(prompt).mockReset()
  vi.mocked(prompt).mockResolvedValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function tagRow(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button[data-tree-row]')]
    .find((node) => node.textContent?.includes(label))
  if (!found) throw new Error(`no tag row named ${label}`)
  return found
}

function menuItem(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no menu item named ${label}`)
  return found
}

function renderSidebar(activeTagName: string | null = null, rows: readonly EmailTag[] = tags) {
  const onSelect = vi.fn()
  const view = renderElement(createElement(EmailTagSidebar, {
    accountId: 'acc-tags',
    tags: rows,
    status: 'ready',
    error: null,
    activeTagName,
    onSelect,
    onReload: async () => undefined,
  }))
  return { view, onSelect }
}

describe('the tag tree', () => {
  it('nests tags, expands a branch and filters by the chosen tag', () => {
    const { view, onSelect } = renderSidebar()
    expect(() => tagRow('meeting')).toThrow()
    const work = tagRow('work')
    expect(work.closest('[role="treeitem"]')?.getAttribute('aria-level')).toBe('1')
    expect(work.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false')
    act(() => { button(t('email.tag.expand', { name: 'work' })).click() })
    const child = tagRow('meeting')
    expect(child.closest('[role="treeitem"]')?.getAttribute('aria-level')).toBe('2')
    act(() => { child.click() })
    expect(onSelect).toHaveBeenCalledWith('work/meeting')
    view.unmount()
  })

  it('reveals the branch holding the active tag and marks its row current', () => {
    const { view } = renderSidebar('work/meeting')
    const child = tagRow('meeting')
    expect(child.getAttribute('aria-current')).toBe('page')
    expect(child.closest('[role="treeitem"]')?.getAttribute('aria-level')).toBe('2')
    view.unmount()
  })

  it('creates a child tag under the row that opened the menu', async () => {
    const createTag = vi.spyOn(api.email, 'createTag').mockResolvedValue({
      id: 't-new', name: 'work/meeting2', color: null, count: 0,
    })
    const listTags = vi.spyOn(api.email, 'listTags').mockResolvedValue(tags)
    vi.mocked(prompt).mockResolvedValue('meeting2')
    const { view } = renderSidebar()
    act(() => {
      tagRow('work').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
    })
    expect(menuItem(t('email.tag.new_child'))).toBeTruthy()
    expect(menuItem(t('email.tag.rename'))).toBeTruthy()
    expect(menuItem(t('email.tag.delete'))).toBeTruthy()
    await act(async () => {
      menuItem(t('email.tag.new_child')).click()
      for (let index = 0; index < 10; index++) await Promise.resolve()
    })
    expect(createTag).toHaveBeenCalledWith('acc-tags', { name: 'work/meeting2' })
    expect(listTags).toHaveBeenCalledWith('acc-tags')
    view.unmount()
  })

  it('keeps a path-only parent to expansion and child creation', () => {
    const { view, onSelect } = renderSidebar(null, [{ id: 't-meeting', name: 'work/meeting', color: null, count: 1 }])
    const work = tagRow('work')
    act(() => { work.click() })
    expect(onSelect).not.toHaveBeenCalled()
    expect(tagRow('meeting')).toBeTruthy()
    act(() => {
      work.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
    })
    expect(menuItem(t('email.tag.new_child'))).toBeTruthy()
    const rename = [...document.querySelectorAll('[role="menuitem"]')]
      .some((node) => node.textContent?.trim() === t('email.tag.rename'))
    expect(rename).toBe(false)
    view.unmount()
  })
})

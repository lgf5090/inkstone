import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import type { NoteTemplateCategory } from '@shared/types'
import { CategoryRow, templateCategoryColor } from './gallery-controls'

let root: Root
let container: HTMLDivElement

function category(overrides: Partial<NoteTemplateCategory> = {}): NoteTemplateCategory {
  return { id: 'cat-1', name: 'Notes', builtin: false, position: 0, createdAt: 1, ...overrides }
}

async function render(row: NoteTemplateCategory) {
  await act(async () => {
    root.render(createElement(CategoryRow, {
      category: row,
      count: 3,
      active: false,
      onSelect: () => {},
      onRename: () => {},
      onDelete: () => {},
    }))
    await Promise.resolve()
  })
}

function mark(): HTMLElement | null {
  return container.querySelector<HTMLElement>('button span[aria-hidden="true"]')
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

describe('a category row', () => {
  it('shows the icon, tinted like a folder row, instead of the bare dot', async () => {
    await render(category({ icon: '🎯', color: '#059669' }))
    const glyph = mark()
    expect(glyph?.textContent).toBe('🎯')
    expect(glyph?.getAttribute('style') ?? '').toContain('rgb(5, 150, 105)')
    expect(container.textContent).toContain('Notes')
    expect(glyph?.querySelector('span[style]')).toBeNull()
  })

  it('falls back to a plain colour dot when the category has no icon', async () => {
    await render(category())
    const dot = mark()
    expect(dot?.textContent).toBe('')
    expect(dot?.getAttribute('style') ?? '').toContain('background-color')
  })

  it('prefers a stored colour and keeps deriving one when there is none', async () => {
    await render(category({ color: '#0891b2' }))
    expect(mark()?.getAttribute('style')).toContain('rgb(8, 145, 178)')
    const bare = category({ id: 'tasks', builtin: true })
    expect(templateCategoryColor(bare)).toBe(templateCategoryColor({ ...bare, color: null }))
    expect(templateCategoryColor({ ...bare, color: '#db2777' })).toBe('#db2777')
  })
})

/**
 * The kanban pickers offer choices the reader cannot name: a lucide button was labelled with its
 * source identifier (`CheckCircle`, read out letter by letter), a colour dot with its token id
 * (`slate`), and the card header's remove button said only "Remove tag" next to several tags. Every
 * one of those identifiers is also the value written into the fence, so the *display* name is what
 * has to change while the stored string must not. Each case mounts the real surface once per shipped
 * language, asks for the option by the message the resources hold for it, and then checks what the
 * click persists.
 */
import { act, createElement, type RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { KANBAN_COLOR_NAMES } from '../colors'
import type { KanbanProperty } from '../types'
import { CardHeader } from './kanban-card-header'
import { KanbanColumnMenu } from './kanban-column-menu'
import { KanbanIconBadge } from './kanban-icon-badge'
import { KanbanIconPicker } from './kanban-icon-picker'
import { TagCreatePopover } from './kanban-tag-picker'
import {
  installBilingualLabelHooks,
  LOCALES,
  type LocaleCode,
  messageIn,
  mountIn,
} from './kanban-bilingual-labels.test-helpers'

installBilingualLabelHooks()

/** The icons the picker offers, by the same identifier the fence stores. */
const ICON_NAMES = [
  'CheckCircle', 'Clock', 'AlertCircle', 'FileText', 'Calendar', 'Star', 'Flag',
  'Bookmark', 'Tag', 'User', 'Folder', 'Layers', 'Sparkles',
]

const NO_ANCHOR = { current: null } as unknown as RefObject<HTMLElement | null>
const NO_BUTTON_ANCHOR = { current: null } as unknown as RefObject<HTMLButtonElement | null>

/** The naming convention the pickers use: the identifier turned into a snake_case message key. */
function iconKey(name: string): string {
  return `preview.kanban_icon_${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`
}

function colorKey(color: string): string {
  return `preview.kanban_color_${color}`
}

function labelled(container: ParentNode): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('button[aria-label]')]
}

function byName(container: ParentNode, name: string): HTMLElement | null {
  return labelled(container).find((el) => el.getAttribute('aria-label') === name) ?? null
}

async function mountIconPicker(code: LocaleCode) {
  const onSelectIcon = vi.fn()
  const container = await mountIn(code, createElement(KanbanIconPicker, {
    open: true,
    panelId: 'icon-panel',
    anchorRef: NO_ANCHOR,
    onClose: vi.fn(),
    onSelectIcon,
  }))
  return { container, onSelectIcon }
}

async function openIconsTab(code: LocaleCode) {
  const { container, onSelectIcon } = await mountIconPicker(code)
  const tab = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((el) => el.textContent === messageIn(code, 'preview.kanban_tab_icons'))
  expect(tab, 'the picker offers no icons tab').toBeDefined()
  act(() => { tab!.click() })
  return { container, onSelectIcon }
}

describe('a lucide icon option', () => {
  it.each(LOCALES)('is named by the resource, not by its identifier, in %s', async (code) => {
    const { container } = await openIconsTab(code)
    for (const name of ICON_NAMES) {
      const label = messageIn(code, iconKey(name))
      expect(byName(container, label), `no option reads as ${label}`).not.toBeNull()
    }
  })

  it.each(LOCALES)('still stores the identifier it is drawn from in %s', async (code) => {
    const { container, onSelectIcon } = await openIconsTab(code)
    const star = byName(container, messageIn(code, iconKey('Star')))
    expect(star, 'no option is named after the star icon').not.toBeNull()
    act(() => { star!.click() })
    expect(onSelectIcon).toHaveBeenCalledWith('lucide:Star')
  })
})

describe('an icon stored on a card', () => {
  // The picker writes the identifier and the badge reads it back; if those two drift, the icon stops
  // drawing on the card and its raw stored text shows instead.
  it('draws every icon the picker can store', async () => {
    for (const name of ICON_NAMES) {
      const container = await mountIn(LOCALES[0], createElement(KanbanIconBadge, { icon: `lucide:${name}` }))
      expect(container.querySelector('svg'), `${name} draws no icon`).not.toBeNull()
      expect(container.textContent, `${name} fell back to its raw value`).not.toContain('lucide:')
    }
  })

  it('leaves an icon it does not know as its raw value', async () => {
    const container = await mountIn(LOCALES[0], createElement(KanbanIconBadge, { icon: 'lucide:ArrowRight' }))
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('lucide:ArrowRight')
  })
})

describe('an emoji option', () => {
  it.each(LOCALES)('lets the reader tool name the character, in %s', async (code) => {
    const { container, onSelectIcon } = await mountIconPicker(code)
    const grid = container.querySelector('[role="group"]')
    expect(grid, 'the emoji grid is not a named group').not.toBeNull()
    expect(grid!.getAttribute('aria-label')).toBe(messageIn(code, 'preview.kanban_tab_emoji'))
    const buttons = [...grid!.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.length, 'the emoji grid draws no option').toBeGreaterThan(10)
    for (const button of buttons) {
      expect(
        button.getAttribute('aria-label'),
        `the ${button.textContent} button overrides the character with a codepoint label`,
      ).toBeNull()
    }
    const emoji = buttons[0]!.textContent ?? ''
    expect(emoji).not.toBe('')
    act(() => { buttons[0]!.click() })
    expect(onSelectIcon).toHaveBeenCalledWith(emoji)
  })
})

describe('a tag colour dot', () => {
  async function mountTagPopover(code: LocaleCode) {
    const onAddTag = vi.fn()
    const container = await mountIn(code, createElement(TagCreatePopover, {
      panelId: 'tag-panel',
      existingTags: [],
      anchorRef: NO_BUTTON_ANCHOR,
      onClose: vi.fn(),
      onAddTag,
    }))
    return { container, onAddTag }
  }

  it.each(LOCALES)('is named by the resource and never by its token, in %s', async (code) => {
    const { container } = await mountTagPopover(code)
    const names = labelled(container).map((el) => el.getAttribute('aria-label') ?? '')
    const dots = names.filter((name) =>
      KANBAN_COLOR_NAMES.some((color) => name === messageIn(code, colorKey(String(color)))),
    )
    expect(dots.length, 'no colour dot carries a name from the resource').toBeGreaterThan(3)
    for (const color of KANBAN_COLOR_NAMES) {
      expect(names, `a dot is still named after its colour token: ${String(color)}`).not.toContain(String(color))
    }
  })

  it.each(LOCALES)('keeps storing its token id when chosen in %s', async (code) => {
    const { container, onAddTag } = await mountTagPopover(code)
    const blue = byName(container, messageIn(code, colorKey('blue')))
    expect(blue, 'no dot is named after blue').not.toBeNull()
    const input = container.querySelector<HTMLInputElement>('input')
    expect(input, 'the popover has no name field').not.toBeNull()
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, 'Launch')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { blue!.click() })
    const add = byName(container, messageIn(code, 'preview.kanban_add_tag'))
    expect(add, 'the popover has no add control').not.toBeNull()
    act(() => { add!.click() })
    expect(onAddTag).toHaveBeenCalledWith('Launch', 'blue')
  })
})

describe('a column colour dot', () => {
  it.each(LOCALES)('is named by the resource and still writes the token, in %s', async (code) => {
    const onChangeColor = vi.fn()
    const container = await mountIn(code, createElement(KanbanColumnMenu, {
      open: true,
      panelId: 'column-panel',
      anchorRef: NO_ANCHOR,
      groupKey: 'doing',
      label: 'Doing',
      color: 'green',
      onRename: vi.fn(),
      onClose: vi.fn(),
      onChangeColor,
      onChangeWipLimit: vi.fn(),
      onCollapse: vi.fn(),
    }))
    const dot = byName(container, messageIn(code, colorKey('red')))
    expect(dot, 'no dot is named after red').not.toBeNull()
    expect(byName(container, 'red'), 'a dot is still named after its colour token').toBeNull()
    act(() => { dot!.click() })
    expect(onChangeColor).toHaveBeenCalledWith('red')
  })
})

describe("the card header's tag remove button", () => {
  const tagsCol: KanbanProperty = {
    id: 'tags',
    name: 'Tags',
    type: 'multi-select',
    options: [
      { id: 'alpha', label: 'Alpha', color: 'blue' },
      { id: 'launch', label: 'Launch', color: 'green' },
    ],
  }

  it.each(LOCALES)('says which of the card tags it removes, in %s', async (code) => {
    const onUpdateTags = vi.fn()
    const container = await mountIn(code, createElement(CardHeader, {
      isSelected: false,
      itemId: 'i1',
      tagVals: ['alpha', 'launch'],
      tagsCol,
      onToggleSelect: vi.fn(),
      onOpenDetail: vi.fn(),
      onUpdateTags,
    }))
    const forTag = (name: string) =>
      byName(container, messageIn(code, 'preview.kanban_remove_tag_named', { name }))
    const removeAlpha = forTag('Alpha')
    expect(removeAlpha, 'no control says it removes Alpha').not.toBeNull()
    expect(forTag('Launch'), 'no control says it removes Launch').not.toBeNull()
    act(() => { removeAlpha!.click() })
    expect(onUpdateTags).toHaveBeenCalledWith('i1', ['launch'])
  })
})

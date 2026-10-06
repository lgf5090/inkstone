import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { renderMarkdown } from '../src/client/lib/markdown/renderer'
import { registerFenceBodies } from '../src/client/lib/markdown/fence-bodies'
import type { KanbanData } from '../src/client/lib/markdown/kanban/types'
import { destroyKanbans, mountKanbans, updateKanbanData } from '../src/client/lib/markdown/kanban'
import { kanbanEntryForNode } from '../src/client/lib/markdown/kanban/registry'
import { KanbanHeader } from '../src/client/lib/markdown/kanban/ui/kanban-header'

/**
 * A board's name is in the fence body, and the markup a fence renders does not read that body — so
 * the block head drew its own type name instead: the type name in the head, and the same word again
 * as the tab of the board view. A reader who had named the board saw that name nowhere, and saw a
 * twice repeated type name where the name belonged (user report 2026-09-23).
 *
 * The name now comes from the two layers that hold it, each in the host where it has the room:
 *
 *  - the note, where the registry writes it into the block's own head. The head is a few hundred
 *    pixels wide and its two other children take 60 of them, so the name has room there; the board's
 *    own header does not — a name drawn in that bar took the room the view strip needs to scroll its
 *    own tab into (the visual gate read a 26px strip for an 8-tab board when it was drawn there).
 *  - the overlay, where the same header draws it, because there is no block head in an overlay.
 *
 * Nothing is drawn for an untitled board: a placeholder would have to be translated, and nothing
 * re-renders this block when the language changes. The strings that are translated and do live in
 * markup the host made — the canvas's landmark name — are pinned in
 * `src/client/lib/markdown/kanban/registry-locale.test.ts`.
 */

const SCOPE = 'kanban-title-test'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  destroyKanbans(SCOPE)
  document.body.replaceChildren()
})

function headOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.kanban-block-head')
}

function titleOf(host: HTMLElement): string | null {
  return headOf(host)?.querySelector<HTMLElement>('.kanban-block-title')?.textContent ?? null
}

/**
 * A fence's body does not ride in the markup: the renderer hands the bodies to the host that inserts
 * the markup, and the block's index is the key back to them (`fence-bodies.ts`). A mount without that
 * registration reads as an empty fence, so the host here does what the preview pane does.
 */
function fence(body: string): HTMLElement {
  const host = document.createElement('div')
  host.className = 'ink-prose'
  const rendered = renderMarkdown(['# Note', '', '```kanban', body, '```'].join('\n'))
  host.innerHTML = rendered.html
  registerFenceBodies(host, rendered.fences)
  document.body.append(host)
  return host
}

async function mountFence(body: string): Promise<HTMLElement> {
  const host = fence(body)
  await act(async () => {
    await mountKanbans(host, { scope: SCOPE, noteId: 'note-1', editable: true })
  })
  return host
}

const OUTLINE_BODY = ['## To Do', '- [ ] First Task'].join('\n')
const TITLED_BODY = JSON.stringify({
  title: 'Gate Board',
  items: [{ id: '1', title: 'Task 1', properties: { status: 'todo' } }],
})

describe('the block head carries the board’s name, not its type', () => {
  it('leaves the head empty of a type name before anything is mounted', () => {
    const head = headOf(fence(OUTLINE_BODY))!
    expect(head.querySelector('.kanban-block-title')).toBeNull()
    expect(head.textContent).not.toContain(t('preview.kanban'))
  })

  it('still says which syntax the body holds, and keeps the door to the overlay', () => {
    const head = headOf(fence(OUTLINE_BODY))!
    expect(head.querySelector('.kanban-block-mode')?.textContent?.trim()).toBe('outline')
    expect(head.querySelector('[data-kanban-fullscreen]')).not.toBeNull()
  })

  it('shows the name the body carries, which the markup alone could not know', async () => {
    expect(titleOf(await mountFence(TITLED_BODY))).toBe('Gate Board')
  })

  it('shows nothing at all for an untitled board, rather than a word to translate', async () => {
    const host = await mountFence(OUTLINE_BODY)
    expect(titleOf(host)).toBeNull()
    expect(headOf(host)!.textContent).not.toContain(t('preview.kanban'))
    expect(headOf(host)!.textContent).not.toContain(t('preview.kanban_untitled'))
  })

  it('follows a rename, because the head belongs to the document rather than to one render', async () => {
    const host = await mountFence(TITLED_BODY)
    const block = host.querySelector<HTMLElement>('[data-kanban]')!
    const entry = kanbanEntryForNode(block)
    expect(entry, 'the mounted block has no entry to write through').not.toBeNull()
    await act(async () => {
      updateKanbanData(entry!, (prev) => ({ ...prev, title: 'Renamed Board' }))
    })
    expect(titleOf(host)).toBe('Renamed Board')
  })
})

function headerData(title?: string): KanbanData {
  return {
    title,
    activeViewId: 'v-board',
    views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 's1', label: 'To Do', color: 'gray' }] },
    ],
    items: [{ id: 'i1', title: 'Card', properties: { status: 's1' } }],
  }
}

function renderHeader(data: KanbanData, extra: Record<string, unknown> = {}): HTMLElement {
  const rendered = renderElement(createElement(KanbanHeader, {
    data,
    visibleItems: data.items,
    activeView: data.views[0]!,
    searchQuery: '',
    filters: [],
    sorts: [],
    onSelectView: vi.fn(),
    onSearchChange: vi.fn(),
    onChangeFilters: vi.fn(),
    onChangeSorts: vi.fn(),
    onAddItem: vi.fn(),
    viewOps: { createView: vi.fn(), renameView: vi.fn(), duplicateView: vi.fn(), deleteView: vi.fn(), moveView: vi.fn() },
    viewPanelId: 'view-panel',
    ...extra,
  }))
  mounted.push(rendered)
  return rendered.container
}

function titleHeading(container: HTMLElement): HTMLHeadingElement | null {
  return container.querySelector<HTMLHeadingElement>('[data-kanban-header] h2')
}

describe('the overlay draws the same name over its own bar', () => {
  it('shows it in the full screen board', () => {
    expect(titleHeading(renderHeader(headerData('Gate Board'), { isFullscreen: true }))?.textContent).toBe('Gate Board')
  })

  it('leaves a note’s own bar to the view strip, which is what has no room to spare', () => {
    expect(titleHeading(renderHeader(headerData('Gate Board')))).toBeNull()
  })

  it('falls back to the board’s type name, not to the wording cards use when they have no title', () => {
    const container = renderHeader(headerData(undefined), { isFullscreen: true })
    expect(titleHeading(container)?.textContent).toBe(t('preview.kanban'))
    expect(container.textContent).not.toContain(t('preview.kanban_untitled'))
  })

  it('renames in place when the name is double clicked', async () => {
    const onUpdateBoardTitle = vi.fn()
    const container = renderHeader(headerData('Gate Board'), { isFullscreen: true, onUpdateBoardTitle })
    await act(async () => {
      titleHeading(container)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    const input = container.querySelector<HTMLInputElement>('input[data-owns-escape="true"]')
    expect(input, 'the title did not turn into an input').not.toBeNull()

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'Renamed Board')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onUpdateBoardTitle).toHaveBeenCalledWith('Renamed Board')
  })
})

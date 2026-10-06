/**
 * The board's panels used to hang off the action row instead of the control that opened them: every
 * one of them was `absolute right-0 top-full`, and `right-0` resolved against `data-kanban-actions`,
 * so the filter, the sort and the view options all opened at the same corner of the row (user report
 * 2026-09-23: the sort and filter menus did not appear under their buttons, they appeared in one and
 * the same place). Nothing in the suite could see it — the panel was in the document, it had its name
 * and its role, and only a painted box would have shown where — so the placement is spelled out here
 * as numbers, the way `popover-placement.test.ts` does for the shared algebra.
 *
 * jsdom does not lay anything out, so the geometry is supplied: the anchor reports a rect and the
 * panel reports the size its own classes would have given it. What is asserted is the offset the
 * panel writes onto itself, and the two things the placement exists for — lining up with the control
 * it belongs to, and staying inside the room it was given.
 */
import { act, createElement, useRef, useState, type ReactNode, type RefObject } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanProperty } from '../types'
import { KanbanArchiveAction } from './kanban-archive'
import { KanbanColumnMenu } from './kanban-column-menu'
import { KanbanCsvAction } from './kanban-csv'
import { KanbanFilterPopover } from './kanban-filter-popover'
import { KanbanIconPicker } from './kanban-icon-picker'
import { KanbanPanel, clipPanelViewport } from './kanban-panel'
import { KanbanSortPopover } from './kanban-sort-popover'
import { KanbanViewOptions } from './kanban-view-options'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mount(node: ReactNode) {
  const rendered = renderElement(node)
  mounted.push(rendered)
  return rendered
}

interface Box {
  top: number
  left: number
  width: number
  height: number
}

function rect(box: Box): DOMRect {
  return {
    x: box.left,
    y: box.top,
    top: box.top,
    left: box.left,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    toJSON: () => box,
  } as DOMRect
}

/** The size a panel would have from its own classes, since jsdom reports zero for both. */
function stubSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(element, 'scrollHeight', { value: height, configurable: true })
}

function AnchorPanel({ align }: { align?: 'start' | 'end' }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(true)
  return createElement(
    'div',
    null,
    createElement('button', { ref: anchorRef, type: 'button', 'data-anchor': '' }, 'trigger'),
    createElement(KanbanPanel, {
      open,
      panelId: 'panel-1',
      label: 'Panel',
      anchorRef,
      onClose: () => setOpen(false),
      ...(align ? { align } : {}),
      className: 'w-72',
      children: createElement('p', null, 'content'),
    }),
  )
}

/**
 * Renders, then supplies the geometry the layout pass just read as zero, then renders once more: the
 * placement runs on every commit, so the second pass is the one that sees the numbers.
 */
function place(anchorBox: Box, panelBox: Box, align?: 'start' | 'end') {
  const element = () => createElement(AnchorPanel, { ...(align ? { align } : {}) })
  const rendered = mount(element())
  const apply = () => {
    const anchor = rendered.container.querySelector<HTMLElement>('[data-anchor]')!
    const panel = rendered.container.querySelector<HTMLElement>('[data-kanban-panel]')!
    anchor.getBoundingClientRect = () => rect(anchorBox)
    stubSize(panel, panelBox.width, panelBox.height)
    return panel
  }
  let panel = apply()
  rendered.rerender(element())
  panel = apply()
  rendered.rerender(element())
  return { container: rendered.container, panel }
}

describe('a panel is drawn inside the room it was given', () => {
  it('cuts the viewport down by every box that would clip it, innermost edge winning', () => {
    const viewport = { top: 0, right: 1024, bottom: 768, left: 0 }
    const outer = { top: 60, right: 1024, bottom: 768, left: 0 }
    const block = { top: 100, right: 900, bottom: 520, left: 40 }
    expect(clipPanelViewport(viewport, [])).toEqual(viewport)
    expect(clipPanelViewport(viewport, [outer])).toEqual({ top: 60, right: 1024, bottom: 768, left: 0 })
    expect(clipPanelViewport(viewport, [outer, block])).toEqual({ top: 100, right: 900, bottom: 520, left: 40 })
  })

  it('leaves an empty viewport alone when nothing clips it and the viewport is already the cut', () => {
    const viewport = { top: 10, right: 20, bottom: 30, left: 5 }
    const wider = { top: 0, right: 100, bottom: 100, left: 0 }
    expect(clipPanelViewport(viewport, [wider])).toEqual(viewport)
  })
})

describe('a panel is placed from the control it hangs off', () => {
  it('sits under that control, lined up with its end, with the panel gap between them', () => {
    const anchorBox = { top: 100, left: 400, width: 200, height: 30 }
    const { panel } = place(anchorBox, { top: 0, left: 0, width: 288, height: 200 })
    // right edge of the trigger (600) minus the panel's own width (288), and its bottom plus the gap
    expect(panel.style.left).toBe('312px')
    expect(panel.style.top).toBe('136px')
  })

  it('lines up with the start of the control when the caller asks for it', () => {
    const anchorBox = { top: 100, left: 400, width: 200, height: 30 }
    const { panel } = place(anchorBox, { top: 0, left: 0, width: 288, height: 200 }, 'start')
    expect(panel.style.left).toBe('400px')
    expect(panel.style.top).toBe('136px')
  })

  it('flips above the control when the room below is smaller than the panel', () => {
    const anchorBox = { top: 600, left: 400, width: 200, height: 30 }
    const { panel } = place(anchorBox, { top: 0, left: 0, width: 288, height: 200 })
    expect(panel.style.top).toBe('394px')
    expect(panel.style.maxHeight).toBe('586px')
  })

  it('caps its height to the room beside the control instead of running off the screen', () => {
    const anchorBox = { top: 600, left: 400, width: 200, height: 30 }
    const { panel } = place(anchorBox, { top: 0, left: 0, width: 288, height: 1200 })
    // Above the control there is 600 - 8 - 6 of room; the panel scrolls inside it rather than spilling
    expect(panel.style.maxHeight).toBe('586px')
    expect(panel.style.top).toBe('8px')
  })
})

/**
 * A board block narrow enough that a panel asking for `w-80` would stick out of both its sides. The
 * box it stands in is supplied by the test after the first render, the way `place` does it.
 */
function ClippedPanel() {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return createElement(
    'div',
    { 'data-clip': '', style: { overflow: 'hidden' } },
    createElement('button', { ref: anchorRef, type: 'button', 'data-anchor': '' }, 'trigger'),
    createElement(KanbanPanel, {
      open: true,
      panelId: 'panel-clip',
      label: 'Panel',
      anchorRef,
      onClose: () => {},
      className: 'w-80',
      children: createElement('p', null, 'content'),
    }),
  )
}

describe('a panel is never wider than the box it may be drawn in', () => {
  it('caps its width to the room inside the ancestor that would clip it', () => {
    // The note's board is 292px wide at a 1280px window and its block hides what leaves it, so a
    // 320px panel was drawn 36px past the edge that cuts it — the width class is a preference, the
    // box is the rule.
    const clipBox: Box = { top: 100, left: 700, width: 292, height: 400 }
    const rendered = mount(createElement(ClippedPanel, {}))
    const clip = rendered.container.querySelector<HTMLElement>('[data-clip]')!
    const anchor = rendered.container.querySelector<HTMLElement>('[data-anchor]')!
    const panel = rendered.container.querySelector<HTMLElement>('[data-kanban-panel]')!
    clip.getBoundingClientRect = () => rect(clipBox)
    anchor.getBoundingClientRect = () => rect({ top: 140, left: 900, width: 60, height: 28 })
    stubSize(panel, 320, 200)
    rendered.rerender(createElement(ClippedPanel, {}))
    // 292 of box, less the clearance kept from each edge.
    expect(panel.style.maxWidth).toBe('276px')
    // And 320 cannot fit beside a control ending at 960, so it is drawn from the box's own edge.
    expect(panel.style.left).toBe('708px')
    expect(panel.style.top).toBe('174px')
  })
})

describe('a panel stays where the keyboard can reach it', () => {
  it('is in the tree it was opened from rather than parked on the body', () => {
    const { container, panel } = place({ top: 100, left: 10, width: 100, height: 20 }, { top: 0, left: 0, width: 288, height: 200 })
    expect(container.contains(panel)).toBe(true)
    expect(document.body.querySelector('[data-kanban-panel]')).toBe(panel)
  })

  it('keeps the role, the id and the name the trigger points at', () => {
    const { panel } = place({ top: 100, left: 10, width: 100, height: 20 }, { top: 0, left: 0, width: 288, height: 200 })
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.id).toBe('panel-1')
    expect(panel.getAttribute('aria-label')).toBe('Panel')
  })

  it('is not positioned by the classes the misplaced panels used to carry', () => {
    const { panel } = place({ top: 100, left: 10, width: 100, height: 20 }, { top: 0, left: 0, width: 288, height: 200 })
    expect(panel.className).not.toContain('top-full')
    expect(panel.className).not.toContain('right-0')
    expect(panel.className).not.toContain('left-0')
  })
})

describe('a panel that is not open draws nothing', () => {
  it('renders no box at all while closed', () => {
    const anchorRef = { current: null }
    const rendered = mount(
      createElement(KanbanPanel, {
        open: false,
        panelId: 'p',
        label: 'Panel',
        anchorRef,
        onClose: () => {},
        children: createElement('p', null, 'x'),
      }),
    )
    expect(rendered.container.querySelector('[data-kanban-panel]')).toBeNull()
  })
})

describe('the panel listens for the click that dismisses it', () => {
  it('closes when a click lands outside it and its control', () => {
    const rendered = mount(createElement(AnchorPanel, {}))
    const panel = rendered.container.querySelector<HTMLElement>('[data-kanban-panel]')!
    expect(panel).not.toBeNull()
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(rendered.container.querySelector('[data-kanban-panel]')).toBeNull()
  })
})

/**
 * The archive shelf and the import/export panel each used to stop a press from reaching the board by
 * writing their own `stopPropagation` div, which is what `tests/client-raw-controls.test.ts` listed
 * them for. Both are drawn by this panel now, so the guard has to hold at this one place instead —
 * asserted by pressing the panel and watching the board's own reader, which is what "pressing inside
 * the shelf does not open the card behind it" means in the running app.
 */
function PressGuard({ onBoardPress }: { onBoardPress: () => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return createElement(
    'div',
    { 'data-board': '', onClick: onBoardPress, onMouseDown: onBoardPress },
    createElement('button', { ref: anchorRef, type: 'button', 'data-anchor': '' }, 'trigger'),
    createElement(KanbanPanel, {
      open: true,
      panelId: 'panel-guard',
      label: 'Panel',
      anchorRef,
      onClose: () => {},
      onClick: (event) => event.stopPropagation(),
      onMouseDown: (event) => event.stopPropagation(),
      className: 'w-72',
      children: createElement('p', null, 'content'),
    }),
  )
}

describe('a press inside the panel does not reach the board behind it', () => {
  it('keeps the click the panel was handed from bubbling up to the board', () => {
    const onBoardPress = vi.fn()
    const rendered = mount(createElement(PressGuard, { onBoardPress }))
    const panel = rendered.container.querySelector<HTMLElement>('[data-kanban-panel]')!
    act(() => {
      panel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onBoardPress).not.toHaveBeenCalled()
  })

  it('still lets a press outside it reach the board', () => {
    const onBoardPress = vi.fn()
    const rendered = mount(createElement(PressGuard, { onBoardPress }))
    const board = rendered.container.querySelector<HTMLElement>('[data-board]')!
    act(() => {
      board.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onBoardPress).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------------------------
// The wiring, for every panel the board can open.
//
// Each of these used to be positioned by classes rather than by numbers — `absolute right-0
// top-full` on the panel, resolved against `data-kanban-actions`, the whole action row — so the
// filter, the sort, the view options, the CSV door, the archive shelf and the icon picker all
// opened in the same corner of the row rather than under the control that asked for them (user
// report 2026-09-23). No class-level assertion could show that, and neither could the rest of the
// suite: the panel was in the document with the right role, name and id, and only a painted box
// revealed where it had landed.
//
// What is asserted here is the number the panel now writes on itself. It is derived from the rect
// of the control that opened it, so a panel wired back to the row reports the row's bottom edge
// instead — 46px away from the trigger's, which is the whole point of the numbers being different.
// ---------------------------------------------------------------------------------------------

const COLUMNS: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
]

/** The action row, and the one control inside it that a panel is supposed to hang off. */
const ROW_BOX: Box = { top: 60, left: 40, width: 900, height: 40 }
const TRIGGER_BOX: Box = { top: 100, left: 880, width: 40, height: 28 }
const PANEL_BOX: Box = { top: 0, left: 0, width: 288, height: 200 }

/** The gap the placement keeps under a control, and the clearance it keeps from the viewport edge. */
const GAP = 6

function WiredAnchor({ build }: { build: (anchorRef: RefObject<HTMLElement | null>) => ReactNode }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return createElement(
    'div',
    { 'data-row': '' },
    createElement('button', { ref: anchorRef, type: 'button', 'data-trigger': '' }, 'trigger'),
    build(anchorRef),
  )
}

/**
 * Opens the panel and hands back what it wrote on itself. The row and the trigger are given rects
 * that cannot be mistaken for each other, and a resize pass runs the placement again — which is the
 * only way the panel can be measured here, since jsdom lays nothing out and the panel's own size
 * exists only once it is in the document.
 */
function placeWired(
  build: (anchorRef: RefObject<HTMLElement | null>) => ReactNode,
  control: { selector?: string; press?: boolean } = {},
) {
  const rendered = mount(createElement(WiredAnchor, { build }))
  rendered.container.querySelector<HTMLElement>('[data-row]')!.getBoundingClientRect = () => rect(ROW_BOX)
  // The control the panel must hang off: the one the test wired, or — for the two panels that own
  // their own button — that button itself.
  const trigger = rendered.container.querySelector<HTMLElement>(control.selector ?? '[data-trigger]')!
  trigger.getBoundingClientRect = () => rect(TRIGGER_BOX)
  if (control.press) {
    act(() => {
      trigger.click()
    })
  }
  const panel = rendered.container.querySelector<HTMLElement>('[data-kanban-panel]')
  if (!panel) throw new Error('the panel did not open')
  stubSize(panel, PANEL_BOX.width, PANEL_BOX.height)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  return panel
}

/** Under its control, right-aligned to it, whichever row the control happens to sit in. */
function expectUnderTrigger(panel: HTMLElement): void {
  expect(panel.style.top).toBe(`${TRIGGER_BOX.top + TRIGGER_BOX.height + GAP}px`)
  expect(panel.style.left).toBe(`${TRIGGER_BOX.left + TRIGGER_BOX.width - PANEL_BOX.width}px`)
}

const anchored = [
  [
    'the filter panel',
    (anchorRef: RefObject<HTMLElement | null>) =>
      createElement(KanbanFilterPopover, {
        open: true,
        panelId: 'p',
        onClose: vi.fn(),
        anchorRef,
        columns: COLUMNS,
        filters: [],
        onChangeFilters: vi.fn(),
      }),
  ],
  [
    'the sort panel',
    (anchorRef: RefObject<HTMLElement | null>) =>
      createElement(KanbanSortPopover, {
        open: true,
        panelId: 'p',
        onClose: vi.fn(),
        anchorRef,
        columns: COLUMNS,
        sorts: [],
        onChangeSorts: vi.fn(),
      }),
  ],
  [
    'the view options panel',
    (anchorRef: RefObject<HTMLElement | null>) =>
      createElement(KanbanViewOptions, {
        open: true,
        panelId: 'p',
        onClose: vi.fn(),
        anchorRef,
        columns: COLUMNS,
        groupBy: 'status',
        onChangeGroupBy: vi.fn(),
      }),
  ],
  [
    'the icon picker',
    (anchorRef: RefObject<HTMLElement | null>) =>
      createElement(KanbanIconPicker, {
        open: true,
        panelId: 'p',
        onClose: vi.fn(),
        anchorRef,
        onSelectIcon: vi.fn(),
      }),
  ],
  [
    'the column menu',
    (anchorRef: RefObject<HTMLElement | null>) =>
      createElement(KanbanColumnMenu, {
        open: true,
        panelId: 'p',
        onClose: vi.fn(),
        anchorRef,
        groupKey: 'todo',
        label: 'To Do',
        onRename: vi.fn(),
        onChangeColor: vi.fn(),
        onChangeWipLimit: vi.fn(),
      }),
  ],
] as const

describe.each(anchored)('%s hangs off the control that opened it', (_name, build) => {
  it('is drawn under its own trigger rather than under the row that holds it', () => {
    const panel = placeWired(build)
    expectUnderTrigger(panel)
    expect(panel.style.top).not.toBe(`${ROW_BOX.top + ROW_BOX.height}px`)
  })
})

/** The two panels that own the button they open from, so the test presses it rather than wiring one. */
describe('the archive shelf hangs off the control that opened it', () => {
  it('lands under the archive button rather than under the action row', () => {
    const panel = placeWired(
      () =>
        createElement(KanbanArchiveAction, {
          items: [{ id: 'a', title: 'Filed away', properties: {}, archived: true }],
          deletedItems: [],
          onRestore: vi.fn(),
          onDelete: vi.fn(),
          onRestoreDeleted: vi.fn(),
          onPurge: vi.fn(),
        }),
      { selector: '[data-kanban-archive]', press: true },
    )
    expectUnderTrigger(panel)
  })
})

describe('the CSV panel hangs off the control that opened it', () => {
  it('lands under the CSV button rather than under the action row', () => {
    const panel = placeWired(
      () =>
        createElement(KanbanCsvAction, {
          title: 'Board',
          columns: COLUMNS,
          items: [],
          itemCount: 0,
          commitData: vi.fn(),
        }),
      { selector: '[data-kanban-csv]', press: true },
    )
    expectUnderTrigger(panel)
  })
})

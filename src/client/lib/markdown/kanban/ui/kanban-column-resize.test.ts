/**
 * A column sized by the type it holds is a guess, and the guess is wrong for the column whose
 * values run long: the reader can see it is cut off but has nowhere to say "wider", and the width
 * they do reach dies with the render (review #20's column-width half). The contract here is that a
 * width is a fact about the document — stored on the column, drawn from the store on every render,
 * changeable by pointer or by keyboard alone, and reversible to the type default.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { inLocale, messageIn } from './kanban-bilingual-labels.test-helpers'
import { KANBAN_COLUMN_COARSE_STEP, KANBAN_COLUMN_MAX_WIDTH, KANBAN_COLUMN_MIN_WIDTH, KANBAN_COLUMN_WIDTH_STEP } from '../column-width'
import type { KanbanData, KanbanProperty } from '../types'
import { KanbanTableView } from './kanban-table-view'
import { resizePropertyColumn } from './kanban-column-hooks'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
  // jsdom has no pointer capture. In a browser the captured element is handed every move, which is
  // what these tests do by dispatching each move at the handle itself.
  HTMLElement.prototype.setPointerCapture = function capture() {}
  HTMLElement.prototype.releasePointerCapture = function release() {}
})

const titleColumn = { id: 'title', name: 'Title', type: 'title' } as KanbanProperty
const specColumn = { id: 'spec', name: 'Spec file', type: 'text' } as KanbanProperty
const sizedColumn = { id: 'notes', name: 'Notes', type: 'text', width: 320 } as KanbanProperty

function tableData(columns: KanbanProperty[]): KanbanData {
  return {
    columns,
    items: [
      { id: 'a', title: 'Design spec', properties: { spec: 'docs/a.md', notes: 'long body' } },
      { id: 'b', title: 'Empty ticket', properties: { spec: 'docs/b.md' } },
    ],
    views: [{ id: 'v', name: 'Table', type: 'table' }],
  }
}

const mounted: ReturnType<typeof renderElement>[] = []

type ResizeSpy = Mock<(propertyId: string, width?: number) => void>
type SortSpy = Mock<(propertyId: string) => void>

function mountTable(
  columns: KanbanProperty[],
  overrides: { onResizeColumn?: ResizeSpy; onSortColumn?: SortSpy; applyResize?: boolean; resizeColumn?: boolean } = {},
) {
  let current = tableData(columns)
  const onSortColumn = overrides.onSortColumn ?? vi.fn<(propertyId: string) => void>()
  // `applyResize` wires the callback to the same pure rewriter the board uses and repaints this root,
  // so a committed width is read back out of the document rather than from what the spy was told.
  let rendered: ReturnType<typeof renderElement>
  const resizeSpy = overrides.onResizeColumn ??
    vi.fn<(propertyId: string, width?: number) => void>((propertyId, width) => {
      if (!overrides.applyResize) return
      current = resizePropertyColumn(current, propertyId, width)
      rendered.rerender(tableNode())
    })
  // A board the reader cannot size at all is one the table gets no writer for, not one handed a
  // writer that never runs.
  const onResizeColumn = overrides.resizeColumn === false ? undefined : resizeSpy
  function tableNode() {
    return createElement(KanbanTableView, {
      data: current,
      view: current.views[0]!,
      selectedIds: new Set<string>(),
      onToggleSelect: vi.fn(),
      onToggleAll: vi.fn(),
      onOpenDetail: vi.fn(),
      onUpdateProperty: vi.fn(),
      onUpdateMultiSelect: vi.fn(),
      onUpdateSubtasks: vi.fn(),
      onUpdateFiles: vi.fn(),
      onAddItem: vi.fn(),
      onAddColumn: vi.fn(),
      people: {},
      onSortColumn,
      onResizeColumn,
    })
  }
  rendered = renderElement(tableNode())
  mounted.push(rendered)
  return { container: rendered.container, onResizeColumn: resizeSpy, onSortColumn }
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function handle(container: ParentNode, propertyId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-kanban-column-resize="${propertyId}"]`)
  if (!el) throw new Error(`no resize handle for column "${propertyId}"`)
  return el
}

function cellsOf(container: ParentNode, propertyId: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-kanban-column="${propertyId}"]`)]
}

function bodyCells(container: ParentNode, propertyId: string): HTMLElement[] {
  // The first match is the header cell of that column.
  return cellsOf(container, propertyId).slice(1)
}

function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}

function valueOf(el: HTMLElement): number {
  return Number(el.getAttribute('aria-valuenow'))
}

// jsdom lays nothing out, so a test that needs a column to have been drawn at some width has to say
// so itself. `width` is read through a closure the test can move, which is how a redraw is faked.
function domRect(width: number): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, width, height: 40, right: width, bottom: 40, toJSON: () => ({}),
  } as DOMRect
}

function committed(spy: ResizeSpy): unknown[] {
  return spy.mock.calls.map(([, width]) => width)
}

describe('the width a column is drawn with', () => {
  it('draws the stored width on the header and on every cell of that column', () => {
    const { container } = mountTable([titleColumn, specColumn, sizedColumn])
    const sized = cellsOf(container, 'notes')
    expect(sized.length, 'the column is drawn once per row plus once in the header').toBe(3)
    for (const cell of sized) expect(cell.style.width).toBe('320px')
  })

  it('leaves a column nobody sized to its type default', () => {
    const { container } = mountTable([titleColumn, specColumn, sizedColumn])
    for (const cell of cellsOf(container, 'spec')) {
      expect(cell.style.width).toBe('')
      expect(cell.className).toContain('w-36')
    }
  })

  // The title stretches to fill the row, so a width on it has to replace that behaviour rather than
  // argue with it — and the minimum it carries would floor a resize below what was asked for.
  it('stops stretching a titled column once it has a width', () => {
    const { container } = mountTable([{ ...titleColumn, width: 200 }, specColumn])
    for (const cell of cellsOf(container, 'title')) {
      expect(cell.style.width).toBe('200px')
      expect(cell.className).not.toContain('flex-1')
      expect(cell.className).not.toContain('min-w-48')
    }
  })

  it('draws no width a stored value it cannot use would override', () => {
    const { container } = mountTable([titleColumn, { id: 'junk', name: 'Junk', type: 'text', width: 'wide' } as unknown as KanbanProperty])
    for (const cell of cellsOf(container, 'junk')) expect(cell.style.width).toBe('')
  })

  it('clamps a stored width to what the table is willing to draw', () => {
    const { container } = mountTable([titleColumn, { id: 'wild', name: 'Wild', type: 'text', width: 99999 } as KanbanProperty])
    expect(cellsOf(container, 'wild')[0]!.style.width).toBe(`${KANBAN_COLUMN_MAX_WIDTH}px`)
  })
})

describe('the width a splitter names', () => {
  // A focusable splitter that names no value is a control a reader cannot hear: the accessible name
  // and range are there but the one number that says where the column is now was left off for every
  // column nobody had sized yet.
  it('says how wide an unstored column is, from the edge it is drawn at', () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => domRect(240))
    try {
      const { container } = mountTable([titleColumn, specColumn])
      const el = handle(container, 'spec')
      expect(valueOf(el)).toBe(240)
      expect(el.getAttribute('aria-valuetext')).toBe(t('preview.kanban_column_width_value', { value0: 240 }))
    } finally {
      rect.mockRestore()
    }
  })

  it('keeps a stored width as the value an unstored edge would report', () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => domRect(240))
    try {
      const { container } = mountTable([titleColumn, { ...specColumn, width: 200 }])
      expect(valueOf(handle(container, 'spec'))).toBe(200)
    } finally {
      rect.mockRestore()
    }
  })

  // Handing a width back is the moment the answer moves out of the document and into the layout again,
  // and the splitter has to name the edge the table redrew rather than the one it read last.
  it('names the redrawn edge after the reader hands a width back', () => {
    let drawn = 240
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => domRect(drawn))
    try {
      const { container } = mountTable([titleColumn, { ...specColumn, width: 200 }], { applyResize: true })
      expect(valueOf(handle(container, 'spec'))).toBe(200)
      drawn = 144
      press(handle(container, 'spec'), 'Delete')
      expect(valueOf(handle(container, 'spec'))).toBe(144)
    } finally {
      rect.mockRestore()
    }
  })

})

describe('the resize handle', () => {
  it('is a splitter that says which column it sizes and how wide that column is', () => {
    const { container } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    expect(el.getAttribute('role')).toBe('separator')
    // The bar itself runs down the edge of the column, which is what the attribute describes — the
    // pointer travel along it is a separate matter, and the shell's splitter names it the same way.
    expect(el.getAttribute('aria-orientation')).toBe('vertical')
    expect(el.getAttribute('tabindex')).toBe('0')
    expect(el.getAttribute('aria-label')).toBe(t('preview.kanban_column_resize', { column: 'Spec file' }))
    expect(el.getAttribute('aria-valuemin')).toBe(String(KANBAN_COLUMN_MIN_WIDTH))
    expect(el.getAttribute('aria-valuemax')).toBe(String(KANBAN_COLUMN_MAX_WIDTH))
    expect(valueOf(el)).toBe(200)
    expect(el.getAttribute('aria-valuetext')).toBe(t('preview.kanban_column_width_value', { value0: 200 }))
    expect(el.getAttribute('title')).toBe(t('preview.kanban_column_resize_hint'))
  })

  // Attachments have no column in the document to write a width onto, and neither has a title column
  // the table had to invent: a handle on either would be a control that silently forgets the width it
  // was given.
  it('offers no handle for a column the document does not declare', () => {
    const { container } = mountTable([titleColumn, specColumn])
    expect(handle(container, 'spec')).toBeTruthy()
    expect(container.querySelector('[data-kanban-column-resize="files"]')).toBeNull()
    const invented = mountTable([specColumn]).container
    expect(invented.querySelector('[data-kanban-column-resize="title"]')).toBeNull()
    expect(handle(invented, 'spec'), 'a column the document does declare still gets one').toBeTruthy()
  })

  it('offers no handle at all when nothing can store the width', () => {
    const { container } = mountTable([titleColumn, specColumn], { resizeColumn: false })
    expect(container.querySelector('[role="separator"]')).toBeNull()
  })
})

describe('a splitter in the reader\'s language', () => {
  // Reading the phrase out of the zh-CN resource is what proves the splitter's name is a message and
  // not a string assembled in JSX, which no locale could reach.
  it('names the splitter in Chinese when the app speaks Chinese', async () => {
    const english = t('preview.kanban_column_resize', { column: 'Spec file' })
    await inLocale('zh-CN')
    try {
      const { container } = mountTable([titleColumn, specColumn])
      const label = messageIn('zh-CN', 'preview.kanban_column_resize', { column: 'Spec file' })
      expect(label).not.toBe(english)
      expect(container.querySelector(`[aria-label="${label}"]`)).toBeTruthy()
      expect(container.querySelector(`[title="${messageIn('zh-CN', 'preview.kanban_column_resize_hint')}"]`)).toBeTruthy()
    } finally {
      await inLocale('en-US')
    }
  })
})

describe('resizing from the keyboard', () => {
  it('steps the column wider and narrower, and writes the document only when told', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    press(el, 'ArrowRight')
    expect(valueOf(el)).toBe(200 + KANBAN_COLUMN_WIDTH_STEP)
    expect(committed(onResizeColumn), 'a step is a draft until the reader stops').toEqual([])
    press(el, 'ArrowLeft')
    press(el, 'ArrowLeft')
    expect(valueOf(el)).toBe(200 - KANBAN_COLUMN_WIDTH_STEP)
    press(el, 'Enter')
    expect(committed(onResizeColumn)).toEqual([200 - KANBAN_COLUMN_WIDTH_STEP])
  })

  it('follows a coarse step while the modifier is held', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    press(el, 'ArrowRight', { shiftKey: true })
    expect(valueOf(el)).toBe(200 + KANBAN_COLUMN_COARSE_STEP)
    press(el, 'Enter')
    expect(committed(onResizeColumn)).toEqual([200 + KANBAN_COLUMN_COARSE_STEP])
  })

  it('clamps at both ends of the range', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: KANBAN_COLUMN_MIN_WIDTH }])
    const el = handle(container, 'spec')
    press(el, 'ArrowLeft')
    expect(valueOf(el)).toBe(KANBAN_COLUMN_MIN_WIDTH)
    expect(committed(onResizeColumn), 'a column already at the floor has nothing to commit').toEqual([])
    press(el, 'End')
    expect(valueOf(el)).toBe(KANBAN_COLUMN_MAX_WIDTH)
    press(el, 'Home')
    expect(valueOf(el)).toBe(KANBAN_COLUMN_MIN_WIDTH)
    press(el, 'Enter')
    expect(committed(onResizeColumn)).toEqual([KANBAN_COLUMN_MIN_WIDTH])
  })

  it('ignores a key that is not its own', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    press(el, 'PageDown')
    press(el, 'a')
    expect(valueOf(el)).toBe(200)
    expect(committed(onResizeColumn)).toEqual([])
  })

})

describe('committing a step from the keyboard', () => {
  it('commits when the splitter loses focus, the way a renamed column does', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    press(el, 'ArrowRight')
    act(() => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(committed(onResizeColumn)).toEqual([200 + KANBAN_COLUMN_WIDTH_STEP])
    act(() => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(committed(onResizeColumn).length, 'leaving twice must not write twice').toBe(1)
  })

  it('discards the draft on Escape and keeps the width it was given', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    press(el, 'ArrowRight')
    expect(el.getAttribute('data-owns-escape'), 'canceling a step must not close the surface it sits in').toBe('true')
    press(el, 'Escape')
    expect(valueOf(el)).toBe(200)
    expect(el.getAttribute('data-owns-escape')).toBeNull()
    expect(committed(onResizeColumn)).toEqual([])
    for (const cell of bodyCells(container, 'spec')) {
      expect(cell.style.flexBasis, 'the live preview is gone, not left behind at the draft').toBe('')
      expect(cell.style.width).toBe('200px')
    }
  })

  it('puts the column back to its type default on Delete', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    press(handle(container, 'spec'), 'Delete')
    expect(committed(onResizeColumn)).toEqual([undefined])
  })
})

describe('which key presses the splitter takes', () => {
  it('takes the keyboard before the table does', () => {
    const { container } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    act(() => { el.dispatchEvent(event) })
    expect(event.defaultPrevented, 'an arrow the splitter answers must not also scroll the board').toBe(true)
    expect(valueOf(el)).toBe(200 + KANBAN_COLUMN_WIDTH_STEP)
  })

  // Escape is the splitter's only when it has something to give back. With no draft the key belongs
  // to whatever surface the table sits in, and swallowing it would trap the reader there.
  it('leaves Escape to the surface around it when there is nothing to cancel', () => {
    const { container } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    let reached = false
    const listen = () => { reached = true }
    document.addEventListener('keydown', listen)
    try {
      press(el, 'Escape')
      expect(reached, 'an Escape with no draft is not the splitter\'s to keep').toBe(true)
      press(el, 'ArrowRight')
      reached = false
      press(el, 'Escape')
      expect(reached, 'canceling a draft must not also close the panel behind it').toBe(false)
    } finally {
      document.removeEventListener('keydown', listen)
    }
  })
})

describe('resizing with the pointer', () => {
  it('follows the drag live and writes the document once, when the button is released', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, button: 0 })) })
    act(() => { el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 160 })) })
    expect(committed(onResizeColumn), 'the document is not a scratch pad for 60 moves a second').toEqual([])
    const preview = bodyCells(container, 'spec')[0]!
    expect(preview.style.flexBasis).toBe('260px')
    expect(preview.style.width, 'the stored width stays what the document says').toBe('200px')
    expect(cellsOf(container, 'files')[0]!.style.flexBasis, 'only the column being sized moves').toBe('')
    act(() => { el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 150 })) })
    expect(preview.style.flexBasis).toBe('250px')
    act(() => { el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 150 })) })
    expect(committed(onResizeColumn)).toEqual([250])
  })

  it('never drags a column past either end of the range', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    const down = () => act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100 })) })
    down()
    act(() => { el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: -9000 })) })
    expect(committed(onResizeColumn)).toEqual([KANBAN_COLUMN_MIN_WIDTH])
    down()
    act(() => { el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 9000 })) })
    expect(committed(onResizeColumn).at(-1)).toBe(KANBAN_COLUMN_MAX_WIDTH)
  })

  it('measures a column nobody sized from the edge it is drawn at', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, specColumn])
    const el = handle(container, 'spec')
    // jsdom lays nothing out, so an unmeasurable column starts at the narrowest width the table will
    // draw; in a browser this is the rendered header cell, which is where the drag should begin.
    act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100 })) })
    act(() => { el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 180 })) })
    expect(committed(onResizeColumn)).toEqual([KANBAN_COLUMN_MIN_WIDTH + 80])
  })

})

describe('the live preview of a drag', () => {
  // The preview is written straight onto the mounted cells to keep a move off React's path; if it
  // survived the commit the column would carry a second, invisible width the next render cannot see.
  it('clears the live preview once the drag is over', () => {
    const { container } = mountTable([titleColumn, { ...specColumn, width: 200 }], { applyResize: true })
    const el = handle(container, 'spec')
    act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100 })) })
    act(() => { el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 260 })) })
    for (const cell of bodyCells(container, 'spec')) {
      expect(cell.style.width, 'mid-drag the document still says 200').toBe('200px')
    }
    act(() => { el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 260 })) })
    for (const cell of cellsOf(container, 'spec')) {
      expect(cell.style.flexBasis).toBe('')
      expect(cell.style.flexGrow).toBe('')
      expect(cell.style.minWidth).toBe('')
      expect(cell.style.width, 'the width now comes from the document').toBe('360px')
    }
  })

  it('leaves the column alone when the drag is canceled', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    const el = handle(container, 'spec')
    act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100 })) })
    act(() => { el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 400 })) })
    act(() => { el.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true, cancelable: true })) })
    expect(committed(onResizeColumn)).toEqual([])
    for (const cell of cellsOf(container, 'spec')) {
      expect(cell.style.flexBasis).toBe('')
      expect(cell.style.width).toBe('200px')
    }
  })

})

describe('a click that lands on the splitter', () => {
  it('resets the column to its type default on a double-click', () => {
    const { container, onResizeColumn } = mountTable([titleColumn, { ...specColumn, width: 200 }])
    act(() => { handle(container, 'spec').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
    expect(committed(onResizeColumn)).toEqual([undefined])
  })

  // The button underneath the splitter spans the whole header, so the handle has to sit after it and
  // take the pointer: a click meant to size a column must never reorder the board.
  it('sits above the sort button and claims the pointer', () => {
    const { container, onSortColumn } = mountTable([titleColumn, specColumn])
    const el = handle(container, 'spec')
    const header = el.closest<HTMLElement>('[role="columnheader"]')!
    const sortButton = header.querySelector('button')!
    expect(header.contains(sortButton), 'the handle does not belong to a header that can sort').toBe(true)
    expect(sortButton.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100 })
    act(() => { el.dispatchEvent(event) })
    expect(event.defaultPrevented, 'text must not be selected under the drag').toBe(true)
    expect(onSortColumn).not.toHaveBeenCalled()
  })
})

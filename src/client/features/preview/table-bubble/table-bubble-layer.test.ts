import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseMarkdownTable, type ParsedTable } from '../../../lib/markdown/table-editor'
import { initI18n, t } from '../../../lib/i18n'
import { measureTable, type Box } from './geometry'
import { aimTable, type PanelState, type TableBubbleView } from './use-table-bubble'
import { TableBubbleLayer } from './TableBubbleLayer'

const SOURCE = [
  '| item | price | qty |',
  '| --- | ---: | :---: |',
  '| computer | 1600 | 5 |',
  '| phone | 12 | 50 |',
].join('\n')

function box(left: number, top: number, right: number, bottom: number): Box {
  return { top, left, right, bottom }
}

const TABLE = box(100, 200, 400, 300)
const CELLS = [box(100, 200, 200, 220), box(200, 200, 300, 220), box(300, 200, 400, 220)]
const ROWS = [box(100, 200, 400, 220), box(100, 220, 400, 260), box(100, 260, 400, 300)]
const SHAPE = measureTable(TABLE, CELLS, ROWS)

function parsedTable(): ParsedTable {
  return parseMarkdownTable(SOURCE.split('\n'), 0)!
}

let container: HTMLDivElement
let root: Root
let commits: ParsedTable[]
let inserts: Array<[axis: 'column' | 'row', edge: number]>
let drops: Array<[kind: 'column' | 'row', from: number, edge: number]>
let pinned: boolean[]
let panelRef: { current: PanelState | null }

function Harness({ view }: { view: TableBubbleView }) {
  return createElement(TableBubbleLayer, {
    view,
    onJumpToLine: () => {},
    onCopyText: () => {},
    tableSource: () => SOURCE,
    onDeleteTable: () => {},
  })
}

function renderLayer(overrides: Partial<TableBubbleView> = {}) {
  const view: TableBubbleView = {
    layerRef: { current: null },
    shape: SHAPE,
    panel: panelRef.current,
    marker: { column: null, row: null },
    hover: { column: null },
    editor: null,
    parsed: parsedTable(),
    line: 0,
    openPanel: (next) => {
      panelRef.current = next
      rerender()
    },
    closePanel: () => {
      panelRef.current = null
      rerender()
    },
    insertAt: (axis, edge) => {
      inserts.push([axis, edge])
    },
    dropOnEdge: (kind, from, edge) => {
      drops.push([kind, from, edge])
    },
    setPinned: (value) => {
      pinned.push(value)
    },
    commitCellEdit: () => {},
    cancelCellEdit: () => {},
    parseAimed: (aim) => aimTable(parsedTable(), aim),
    commit: (next) => {
      commits.push(next)
    },
    ...overrides,
  }
  act(() => root.render(createElement(Harness, { view })))
}

function rerender() {
  renderLayer()
}

function buttons(label: string): HTMLButtonElement[] {
  return [...container.ownerDocument.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)]
}

function stripButton(label: string): HTMLButtonElement {
  const found = buttons(label).at(-1)!
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

function click(node: HTMLElement) {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function pointer(node: HTMLElement, type: string, x: number, y: number) {
  act(() => {
    node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }))
  })
}

/** A row of an open `Menu`, found by the copy it shows rather than by an attribute it does not carry. */
function menuItem(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')]
    .find((node) => node.textContent?.trim() === label) ?? null
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom has no pointer capture, which a drag relies on to keep receiving moves outside the button.
  const proto = Element.prototype as unknown as { setPointerCapture: () => void, releasePointerCapture: () => void }
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  panelRef = { current: null }
  commits = []
  inserts = []
  drops = []
  pinned = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('aimTable', () => {
  it('maps the DOM row a handle counts to the index the parser counts', () => {
    expect(aimTable(parsedTable(), { kind: 'row', index: 0 }).cursorRowIndex).toBe(-1)
    expect(aimTable(parsedTable(), { kind: 'row', index: 1 }).cursorRowIndex).toBe(0)
    expect(aimTable(parsedTable(), { kind: 'row', index: 2 }).cursorRowIndex).toBe(1)
  })

  it('refuses to aim past the last row', () => {
    expect(aimTable(parsedTable(), { kind: 'row', index: 99 }).cursorRowIndex).toBe(1)
  })

  it('leaves the whole-table aim untouched', () => {
    const parsed = parsedTable()
    expect(aimTable(parsed, { kind: 'table', index: 0 })).toBe(parsed)
  })
})

describe('TableBubbleLayer handles', () => {
  it('draws one handle per column, one per row, and one for the table', () => {
    renderLayer()
    expect(buttons(t('preview.table_bubble_column_handle')).length).toBe(3)
    expect(buttons(t('preview.table_bubble_row_handle')).length).toBe(2)
    expect(buttons(t('preview.table_bubble_header_handle')).length).toBe(1)
    expect(buttons(t('preview.table_bubble_table_handle')).length).toBe(1)
  })

  it('draws nothing when the parser and the renderer disagree about the block', () => {
    renderLayer({ parsed: null })
    expect(container.querySelectorAll('button').length).toBe(0)
  })
})

describe('TableBubbleLayer column strip', () => {
  it('aligns the column whose handle was pressed and leaves the others', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_column_handle'))[1]!)
    click(stripButton(t('contextmenu.table_align_center')))
    expect(commits).toHaveLength(1)
    expect(commits[0]!.alignments).toEqual(['default', 'center', 'center'])
  })

  it('marks the alignment the column already has', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_column_handle'))[1]!)
    expect(stripButton(t('contextmenu.table_align_right')).getAttribute('aria-pressed')).toBe('true')
  })

  it('deletes the column whose handle was pressed', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_column_handle'))[0]!)
    click(stripButton(t('contextmenu.table_delete_col')))
    expect(commits[0]!.headerRow).toEqual(['price', 'qty'])
    expect(commits[0]!.alignments).toEqual(['right', 'center'])
  })

  it('closes on escape without writing', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_column_handle'))[0]!)
    const panel = document.querySelector<HTMLElement>('[role="toolbar"]')!
    expect(panel).not.toBeNull()
    act(() => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(panelRef.current).toBeNull()
    expect(commits).toHaveLength(0)
  })
})

describe('TableBubbleLayer row strip', () => {
  it('deletes the body row whose handle was pressed', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_row_handle'))[0]!)
    click(stripButton(t('contextmenu.table_delete_row')))
    expect(commits[0]!.rows).toEqual([['phone', '12', '50']])
  })

  it('inserts below the header as the first body row', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_header_handle'))[0]!)
    click(stripButton(t('contextmenu.table_insert_row_below')))
    expect(commits[0]!.rows[0]).toEqual(['', '', ''])
    expect(commits[0]!.headerRow).toEqual(['item', 'price', 'qty'])
  })

  it('refuses to duplicate the header row', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_header_handle'))[0]!)
    expect(stripButton(t('contextmenu.table_duplicate_row')).disabled).toBe(true)
  })
})

describe('TableBubbleLayer drag', () => {
  it('drops a row handle on the edge it was dragged to', () => {
    renderLayer()
    const handle = buttons(t('preview.table_bubble_row_handle'))[1]!
    pointer(handle, 'pointerdown', 87, 280)
    pointer(handle, 'pointermove', 87, 295)
    expect(document.querySelector('[data-dragging="true"]')).not.toBeNull()
    pointer(handle, 'pointerup', 87, 295)
    expect(drops).toEqual([['row', 2, 3]])
    expect(pinned).toEqual([true, false])
  })

  it('drops a column handle on the edge it was dragged to', () => {
    renderLayer()
    const handle = buttons(t('preview.table_bubble_column_handle'))[0]!
    pointer(handle, 'pointerdown', 130, 187)
    pointer(handle, 'pointermove', 300, 187)
    pointer(handle, 'pointerup', 300, 187)
    expect(drops).toEqual([['column', 0, 2]])
  })

  it('opens the menu instead of moving, when the handle did not travel', () => {
    renderLayer()
    const handle = buttons(t('preview.table_bubble_row_handle'))[0]!
    pointer(handle, 'pointerdown', 87, 240)
    pointer(handle, 'pointerup', 87, 241)
    click(handle)
    expect(drops).toEqual([])
    expect(pinned).toEqual([])
    expect(panelRef.current).toEqual({ kind: 'row', index: 1 })
  })

  it('leaves the header row where it is', () => {
    renderLayer()
    const handle = buttons(t('preview.table_bubble_header_handle'))[0]!
    pointer(handle, 'pointerdown', 87, 210)
    pointer(handle, 'pointermove', 87, 295)
    pointer(handle, 'pointerup', 87, 295)
    expect(drops).toEqual([])
  })
})

describe('TableBubbleLayer insert markers', () => {
  it('reports the edge a marker sits on', () => {
    renderLayer({ marker: { column: 2, row: null } })
    click(buttons(t('preview.table_bubble_insert_column'))[0]!)
    expect(inserts).toEqual([['column', 2]])
  })

  it('offers a row edge as well', () => {
    renderLayer({ marker: { column: null, row: 1 } })
    click(buttons(t('preview.table_bubble_insert_row'))[0]!)
    expect(inserts).toEqual([['row', 1]])
  })
})

describe('TableBubbleLayer table menu', () => {
  it('opens the whole-table list from the corner handle', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_table_handle'))[0]!)
    expect(menuItem(t('contextmenu.table_format'))).not.toBeNull()
    expect(menuItem(t('contextmenu.table_copy_csv'))).not.toBeNull()
    expect(menuItem(t('contextmenu.delete_block'))).not.toBeNull()
  })

  it('offers the rows this round added, once each', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_table_handle'))[0]!)
    const labels = [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')]
      .map((node) => node.textContent?.trim() ?? '')
    const csv = labels.filter((label) => label === t('contextmenu.table_copy_csv'))
    expect(csv).toHaveLength(1)
    expect(labels).toContain(t('contextmenu.table_move_col_left'))
    expect(labels).toContain(t('contextmenu.table_clear_col'))
  })

  it('tidies the table through the corner handle', () => {
    renderLayer()
    click(buttons(t('preview.table_bubble_table_handle'))[0]!)
    click(menuItem(t('contextmenu.table_format'))!)
    expect(commits).toHaveLength(1)
    expect(commits[0]!.headerRow).toEqual(['item', 'price', 'qty'])
  })
})

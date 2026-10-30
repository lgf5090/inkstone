// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { ResultGrid } from '../src/client/features/development/database/ResultGrid'

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const COLUMNS = ['id', 'name']
const ROWS = [[1, 'Ada'], [2, 'Bob'], [3, 'Cy']]

function press(target: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

function cell(container: HTMLElement, row: number, vcol: number): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-cell="${row}-${vcol}"]`)
  if (!element) throw new Error(`missing cell ${row}-${vcol}`)
  return element
}

describe('ResultGrid keyboard', () => {
  it('exposes grid roles and moves focus with arrow keys', () => {
    const onRowClick = vi.fn()
    rendered = renderElement(<ResultGrid columns={COLUMNS} rows={ROWS} onRowClick={onRowClick} />)
    const grid = rendered.container.querySelector('[role="grid"]')
    expect(grid?.getAttribute('aria-rowcount')).toBe('3')
    expect(grid?.getAttribute('aria-colcount')).toBe('3')
    expect(rendered.container.querySelector('[role="row"][aria-rowindex="2"]')).not.toBeNull()
    const first = cell(rendered.container, 0, 0)
    expect(first.getAttribute('role')).toBe('gridcell')
    expect(first.getAttribute('tabindex')).toBe('0')
    act(() => { first.focus() })
    expect(document.activeElement).toBe(first)
    press(first, 'ArrowDown')
    expect(document.activeElement).toBe(cell(rendered.container, 1, 0))
    press(document.activeElement as Element, 'ArrowRight')
    expect(document.activeElement).toBe(cell(rendered.container, 1, 1))
    press(document.activeElement as Element, 'Enter')
    expect(onRowClick).toHaveBeenCalledWith(1)
  })

  it('selects with Space and copies the focused cell with Ctrl+C', async () => {
    const onSelectionChange = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    rendered = renderElement(
      <ResultGrid columns={COLUMNS} rows={ROWS} selectedRows={new Set()} onSelectionChange={onSelectionChange} />,
    )
    const target = cell(rendered.container, 2, 1)
    act(() => { target.focus() })
    press(target, ' ')
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect([...onSelectionChange.mock.calls[0]![0] as Set<number>]).toEqual([2])
    press(target, 'c', { ctrlKey: true })
    await act(async () => { await Promise.resolve() })
    expect(writeText).toHaveBeenCalledWith('Cy')
  })

  it('starts editing on Enter and F2 when editable', () => {
    const onEdit = vi.fn()
    rendered = renderElement(
      <ResultGrid
        columns={COLUMNS}
        rows={ROWS}
        editable
        editing={null}
        editValue=""
        onEdit={onEdit}
        onEditValueChange={() => undefined}
        onEditCommit={() => undefined}
        onEditCancel={() => undefined}
      />,
    )
    const target = cell(rendered.container, 0, 1)
    act(() => { target.focus() })
    press(target, 'Enter')
    expect(onEdit).toHaveBeenLastCalledWith(0, 1)
    press(target, 'F2')
    expect(onEdit).toHaveBeenLastCalledWith(0, 1)
  })
})

import { act, createElement } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { PresentationInkLayer, inkKeyFor, strokePath, useInkBoard, type InkBoard, type InkPoint } from './presentation-ink'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

describe('strokePath', () => {
  it('draws nothing for no points, and a dot for one', () => {
    expect(strokePath([])).toBe('')
    expect(strokePath([{ x: 10, y: 20 }])).toBe('M 10 20 L 10 20')
  })

  it('joins a line through its points in order', () => {
    expect(strokePath([{ x: 0, y: 0 }, { x: 5, y: 6 }, { x: 9, y: 1 }])).toBe('M 0 0 L 5 6 L 9 1')
  })
})

describe('inkKeyFor', () => {
  it('separates the pages a mark could be made on', () => {
    expect(inkKeyFor(2, 0)).toBe('2:0')
    expect(inkKeyFor(2, 1)).not.toBe(inkKeyFor(2, 0))
    expect(inkKeyFor(3, 0)).not.toBe(inkKeyFor(2, 0))
  })
})

function Host({ page, held }: { page: string, held: { current: InkBoard | null } }) {
  held.current = useInkBoard(page)
  return null
}

describe('useInkBoard — the sheet of glass a page gets', () => {
  const point = (x: number, y: number): InkPoint => ({ x, y })

  it('lifts a stroke off the live line onto the page when the pointer comes up', () => {
    const held: { current: InkBoard | null } = { current: null }
    const view = renderElement(createElement(Host, { page: inkKeyFor(0, 0), held }))
    const board = () => {
      if (!held.current) throw new Error('the ink board never mounted')
      return held.current
    }
    act(() => {
      board().add(point(1, 1))
      board().extend(point(2, 2))
    })
    expect(board().strokes).toHaveLength(0)
    expect(board().live).toHaveLength(2)
    expect(board().hasMarks, 'a stroke under way is still a mark on the page').toBe(true)

    act(() => { board().finish() })
    expect(board().live).toHaveLength(0)
    expect(board().strokes).toEqual([{ points: [point(1, 1), point(2, 2)] }])

    act(() => { board().undo() })
    expect(board().strokes).toHaveLength(0)
    expect(board().hasMarks).toBe(false)
    view.unmount()
  })

  it('keeps a lifted stroke out of the board, so a tap that went nowhere is nothing to undo', () => {
    const held: { current: InkBoard | null } = { current: null }
    const view = renderElement(createElement(Host, { page: '0:0', held }))
    act(() => {
      held.current?.add(point(3, 4))
      held.current?.finish()
    })
    expect(held.current?.strokes).toEqual([{ points: [point(3, 4)] }])
    act(() => { held.current?.finish() })
    expect(held.current?.strokes).toHaveLength(1)
    view.unmount()
  })

  // The talk moves; the marks do not. A circle drawn over the numbers slide is there when the speaker
  // comes back for it, and is not painted over the slide after it.
  it('leaves each page holding only its own marks', () => {
    const held: { current: InkBoard | null } = { current: null }
    const view = renderElement(createElement(Host, { page: '0:0', held }))
    act(() => {
      held.current?.add(point(1, 1))
      held.current?.finish()
    })
    expect(held.current?.strokes).toHaveLength(1)

    act(() => { view.rerender(createElement(Host, { page: '1:0', held })) })
    expect(held.current?.strokes, 'the second page starts clean').toEqual([])
    expect(held.current?.hasMarks).toBe(false)

    act(() => { view.rerender(createElement(Host, { page: '0:0', held })) })
    expect(held.current?.strokes, 'the first page still has what was drawn on it').toHaveLength(1)
    view.unmount()
  })

  it('clears the page in front of the speaker and leaves the others alone', () => {
    const held: { current: InkBoard | null } = { current: null }
    const view = renderElement(createElement(Host, { page: '0:0', held }))
    act(() => {
      held.current?.add(point(1, 1))
      held.current?.finish()
    })
    act(() => { view.rerender(createElement(Host, { page: '1:0', held })) })
    act(() => {
      held.current?.add(point(8, 9))
      held.current?.finish()
      held.current?.clear()
    })
    expect(held.current?.strokes).toEqual([])
    act(() => { view.rerender(createElement(Host, { page: '0:0', held })) })
    expect(held.current?.strokes, 'erasing this page does not reach the one behind it').toHaveLength(1)
    view.unmount()
  })
})

function LayerHost({ active, onBegin, onExtend, onEnd }: {
  active: boolean
  onBegin: (point: InkPoint) => void
  onExtend: (point: InkPoint) => void
  onEnd: () => void
}) {
  return createElement(PresentationInkLayer, { active, strokes: [], live: [], onBegin, onExtend, onEnd })
}

describe('PresentationInkLayer', () => {
  const layerOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-presentation-ink]')
  const gesture = (layer: HTMLElement, type: string, x = 400, y = 300) => {
    act(() => {
      layer.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }))
    })
  }

  it('is not there for the pointer when the marker is off', () => {
    const { container } = renderElement(createElement(LayerHost, { active: false, onBegin: vi.fn(), onExtend: vi.fn(), onEnd: vi.fn() }))
    const layer = layerOf(container)
    expect(layer?.getAttribute('data-presentation-ink')).toBe('off')
    expect(layer?.className).toContain('pointer-events-none')
  })

  it('turns a drag into normalised points, and a click on the slide into nothing', () => {
    const onBegin = vi.fn()
    const onExtend = vi.fn()
    const onEnd = vi.fn()
    const { container } = renderElement(createElement(LayerHost, { active: true, onBegin, onExtend, onEnd }))
    const layer = layerOf(container)
    if (!layer) throw new Error('the ink layer did not render')
    // A stage with no layout still reports a box, so the percentages have something to divide by.
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    gesture(layer, 'pointerdown', 400, 300)
    expect(onBegin).toHaveBeenCalledWith({ x: 50, y: 50 })
    gesture(layer, 'pointermove', 200, 150)
    expect(onExtend).toHaveBeenCalledWith({ x: 25, y: 25 })
    gesture(layer, 'pointerup')
    expect(onEnd).toHaveBeenCalledTimes(1)

    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { layer.dispatchEvent(click) })
    expect(click.defaultPrevented, 'a stroke must not also turn the page').toBe(true)
  })

  it('lets a move through when no stroke is under way', () => {
    const onExtend = vi.fn()
    const { container } = renderElement(createElement(LayerHost, { active: true, onBegin: vi.fn(), onExtend, onEnd: vi.fn() }))
    gesture(layerOf(container)!, 'pointermove', 10, 10)
    expect(onExtend).not.toHaveBeenCalled()
  })
})

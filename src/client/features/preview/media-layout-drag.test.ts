import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { enhanceMediaLayouts } from './media-layout'
import {
  alignForShare,
  attachMediaLayoutHost,
  percentAfterDrag,
  rowHeightsAfterDrag,
  weightsAfterDrag,
} from './media-layout-drag'
import type { MediaSurface } from './media-layout-drag'

// i18n is left uninitialised so the toast assertions name the copy slot rather than a translation.

describe('the arithmetic of a resize', () => {
  it('shares a row between the two pictures the reader pulled apart', () => {
    expect(weightsAfterDrag([193, 393], [0, 1], -93)).toEqual([1, 4.9])
  })

  it('leaves the pictures that were not touched alone', () => {
    expect(weightsAfterDrag([200, 200, 400], [0, 1], -100)).toEqual([1, 3, 4])
  })

  it('never lets a picture be dragged to nothing', () => {
    const weights = weightsAfterDrag([100, 500], [0, 1], -900)
    expect(weights[0]).toBeGreaterThan(0)
    expect(weights[1]).toBeGreaterThan(1)
  })

  it('turns an edge drag into a percent of the line the block started from', () => {
    expect(percentAfterDrag(600, 40, 150)).toBe(50)
    expect(percentAfterDrag(600, 40, -540)).toBe(20)
    expect(percentAfterDrag(600, 100, 400)).toBe(100)
  })

  it('scales every row by the frame, not by the row that happens to be first', () => {
    expect(rowHeightsAfterDrag([240, 120], 360, -180)).toEqual([120, 60])
    expect(rowHeightsAfterDrag([240, 120], 360, 1800)).toEqual([1200, 600])
  })

  it('snaps a dragged picture to the third it is nearest', () => {
    expect(alignForShare(0.05)).toBe('left')
    expect(alignForShare(0.29)).toBe('left')
    expect(alignForShare(0.5)).toBe('center')
    expect(alignForShare(0.71)).toBe('right')
  })
})

const GALLERY = '::: media wrap=left width=40%\n![[a.png]] ![[b.png]] {w=1:2 h=240}\n![[clip.mp4]]\n:::\n'

const GRID = '::: media cols=2\n![[a.png]] ![[b.png]]\n![[clip.mp4]]\n:::\n'

/** A row list, addressed by the line each row was drawn from. */
function rects(root: HTMLElement): void {
  const block = root.querySelector<HTMLElement>('.markdown-media')!
  const rows = [...root.querySelectorAll<HTMLElement>('.markdown-media-row')]
  const cells = rows.map((row) => [...row.querySelectorAll<HTMLElement>('.markdown-media-cell')])
  block.dataset.rect = '0,0,600,374'
  rows[0]!.dataset.rect = '0,0,600,240'
  cells[0][0]!.dataset.rect = '0,0,193,240'
  cells[0][1]!.dataset.rect = '207,0,393,240'
  rows[1]!.dataset.rect = '0,254,600,120'
  cells[1][0]!.dataset.rect = '0,254,600,120'
}

function withHost(source: string = GALLERY): { host: HTMLElement, detach: () => void, commits: MediaEditLike[] } {
  const host = document.createElement('div')
  host.className = 'ink-prose'
  host.innerHTML = renderMarkdown(source).html
  enhanceMediaLayouts(host, { chart: false, mediaToolbar: true })
  document.body.append(host)
  const commits: MediaEditLike[] = []
  const surface: MediaSurface = {
    source: () => source,
    commit: (edit) => { commits.push(edit); return true },
    toast: vi.fn(),
  }
  const detach = attachMediaLayoutHost(host, () => surface)
  return { host, detach, commits }
}

interface MediaEditLike { start: number, end: number, lines: string[] }

function rect(this: Element): DOMRect {
  const raw = (this as HTMLElement).dataset.rect
  if (!raw) return new DOMRect(0, 0, 0, 0)
  const [x, y, width, height] = raw.split(',').map(Number)
  return new DOMRect(x, y, width, height)
}

const realRect = Element.prototype.getBoundingClientRect

// The stub is installed per test, not once for the file: the teardown below hands the prototype back to jsdom after every case,
// and a module-level patch would leave everything after the first test measuring zeros from a layout engine that does not exist.
beforeEach(() => {
  Element.prototype.getBoundingClientRect = rect
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
})

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect
  document.body.replaceChildren()
})

function pointer(node: HTMLElement, type: string, x: number, y = 0): void {
  node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, button: 0 }))
}

function applyEdit(source: string, edit: MediaEditLike): string {
  const lines = source.split('\n')
  lines.splice(edit.start, edit.end - edit.start + 1, ...edit.lines)
  return lines.join('\n')
}

describe('the drag gestures', () => {
  it('writes the new width when the frame’s right edge is dragged', () => {
    const { host, commits } = withHost()
    rects(host)
    const edge = host.querySelector<HTMLElement>('.media-edge-right')!
    pointer(edge, 'pointerdown', 600, 100)
    pointer(edge, 'pointermove', 750, 100)
    pointer(edge, 'pointerup', 750, 100)
    expect(commits).toHaveLength(1)
    expect(applyEdit(GALLERY, commits[0]!).split('\n')[0]).toBe('::: media wrap=left width=50%')
  })

  it('scales every row when the frame’s bottom edge is dragged', () => {
    const { host, commits } = withHost()
    rects(host)
    const edge = host.querySelector<HTMLElement>('.media-edge-bottom')!
    pointer(edge, 'pointerdown', 0, 374)
    pointer(edge, 'pointermove', 0, 187)
    pointer(edge, 'pointerup', 0, 187)
    expect(applyEdit(GALLERY, commits[0]!).split('\n')[1]).toBe('![[a.png]] ![[b.png]] {w=1:2 h=120}')
    expect(applyEdit(GALLERY, commits[0]!).split('\n')[2]).toBe('![[clip.mp4]] {h=60}')
  })

  it('shares the row between two pictures when their gap is dragged', () => {
    const { host, commits } = withHost()
    rects(host)
    const cell = host.querySelectorAll<HTMLElement>('.markdown-media-cell')[0]!
    pointer(cell, 'pointerdown', 200, 100)
    pointer(cell, 'pointermove', 107, 100)
    pointer(cell, 'pointerup', 107, 100)
    expect(commits).toHaveLength(1)
    expect(applyEdit(GALLERY, commits[0]!).split('\n')[1]).toBe('![[a.png]] ![[b.png]] {w=1:4.9 h=240}')
  })

  it('leaves the note untouched when Escape ends the drag', () => {
    const { host, commits } = withHost()
    rects(host)
    const edge = host.querySelector<HTMLElement>('.media-edge-right')!
    pointer(edge, 'pointerdown', 600, 100)
    pointer(edge, 'pointermove', 750, 100)
    edge.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }))
    pointer(edge, 'pointerup', 750, 100)
    expect(commits).toEqual([])
    expect(host.querySelector<HTMLElement>('.markdown-media')!.style.getPropertyValue('--media-width')).toBe('')
  })

  it('writes nothing for a press that never moved, and lets the click through', () => {
    const { host, commits } = withHost()
    rects(host)
    const cell = host.querySelectorAll<HTMLElement>('.markdown-media-cell')[0]!
    pointer(cell, 'pointerdown', 80, 100)
    pointer(cell, 'pointerup', 80, 100)
    expect(commits).toEqual([])
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    cell.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
  })

  it('snaps a lone picture to the side it was dropped near', () => {
    const { host, commits } = withHost()
    rects(host)
    const lone = host.querySelectorAll<HTMLElement>('.markdown-media-cell')[2]!
    pointer(lone, 'pointerdown', 560, 300)
    pointer(lone, 'pointermove', 580, 300)
    pointer(lone, 'pointerup', 580, 300)
    expect(commits).toHaveLength(1)
    expect(applyEdit(GALLERY, commits[0]!).split('\n')[2]).toBe('![[clip.mp4]] {align=right}')
  })

  it('offers a columned block no placement, because its track already decides where the picture sits', () => {
    const { host, commits } = withHost(GRID)
    rects(host)
    const lone = host.querySelectorAll<HTMLElement>('.markdown-media-cell')[2]!
    pointer(lone, 'pointerdown', 560, 300)
    pointer(lone, 'pointermove', 580, 300)
    pointer(lone, 'pointerup', 580, 300)
    expect(commits).toHaveLength(0)
  })

  it('never offers a gap strip on a columned block, and still offers one next door', () => {
    const grid = withHost(GRID)
    rects(grid.host)
    const first = grid.host.querySelectorAll<HTMLElement>('.markdown-media-cell')[0]!
    // Cell one ends at 193px and the strip would sit at 200px, so a hover at 190px is inside the grab band.
    pointer(first, 'pointermove', 190, 100)
    expect(grid.host.querySelectorAll('.media-splitter.is-media-shown')).toHaveLength(0)
    pointer(first, 'pointerdown', 190, 100)
    pointer(first, 'pointermove', 130, 100)
    pointer(first, 'pointerup', 130, 100)
    expect(grid.commits).toHaveLength(0)
    grid.detach()

    const flex = withHost()
    rects(flex.host)
    const edge = flex.host.querySelectorAll<HTMLElement>('.markdown-media-cell')[0]!
    pointer(edge, 'pointermove', 190, 100)
    expect(flex.host.querySelectorAll('.media-splitter.is-media-shown')).toHaveLength(1)
    pointer(edge, 'pointerdown', 190, 100)
    pointer(edge, 'pointermove', 130, 100)
    pointer(edge, 'pointerup', 130, 100)
    expect(flex.commits).toHaveLength(1)
    expect(applyEdit(GALLERY, flex.commits[0]!).split('\n')[1]).toContain('w=')
    flex.detach()
  })

  it('steps the width by keyboard, one press per undo', () => {
    const { host, commits } = withHost()
    rects(host)
    const edge = host.querySelector<HTMLElement>('.media-edge-right')!
    edge.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight' }))
    expect(commits).toHaveLength(1)
    expect(applyEdit(GALLERY, commits[0]!).split('\n')[0]).toBe('::: media wrap=left width=45%')
    edge.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowUp' }))
    expect(commits).toHaveLength(1)
  })

  it('refuses to write when the surface has nothing to write to', () => {
    const host = document.createElement('div')
    host.className = 'ink-prose'
    host.innerHTML = renderMarkdown(GALLERY).html
    enhanceMediaLayouts(host, { chart: false, mediaToolbar: true })
    document.body.append(host)
    rects(host)
    const detach = attachMediaLayoutHost(host, () => null)
    const edge = host.querySelector<HTMLElement>('.media-edge-right')!
    pointer(edge, 'pointerdown', 600, 100)
    pointer(edge, 'pointermove', 750, 100)
    pointer(edge, 'pointerup', 750, 100)
    expect(host.querySelector<HTMLElement>('.markdown-media')!.style.getPropertyValue('--media-width')).toBe('')
    detach()
  })
})

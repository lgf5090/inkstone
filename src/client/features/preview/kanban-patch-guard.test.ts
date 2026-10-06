import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { registerFenceBodies } from '../../lib/markdown/fence-bodies'
import { patchChildren } from './Preview'

const FENCE = '```'
const BODY_A = '{\n  "title": "A",\n  "items": []\n}'
const BODY_B = '{\n  "title": "B",\n  "items": []\n}'

function note(body: string): string {
  return `${FENCE}kanban\n${body}\n${FENCE}\n`
}

/** A host holding the markup for a note, with the fence bodies that markup was built from. */
function staged(source: string): HTMLElement {
  const rendered = renderMarkdown(source)
  const host = document.createElement('div')
  host.innerHTML = rendered.html
  registerFenceBodies(host, rendered.fences)
  return host
}

/** The live host after a board mounted: the canvas the registry appends, and the ready marker. */
function mounted(source: string): HTMLElement {
  const host = staged(source)
  const block = host.querySelector<HTMLElement>('[data-kanban]')!
  block.classList.remove('loading')
  block.classList.add('is-ready')
  const canvas = document.createElement('div')
  canvas.dataset.kanbanCanvas = '1'
  block.append(canvas)
  return host
}

function blockOf(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>('[data-kanban]')!
}

describe('patchChildren preserves a mounted board', () => {
  it('keeps the canvas subtree of a block whose body did not change', () => {
    const live = mounted(note(BODY_A))
    const canvas = blockOf(live).querySelector('[data-kanban-canvas]')!
    patchChildren(live, staged(note(BODY_A)))
    expect(blockOf(live).querySelector('[data-kanban-canvas]')).toBe(canvas)
    expect(blockOf(live).classList.contains('is-ready')).toBe(true)
  })

  // The shift has to come from within an existing block: adding a heading would change the number of
  // top-level children, and the diff replaces a block whose neighbour count moved before the guard
  // below it ever runs.
  it('re-stamps the line a shift above moved, though the block itself is unchanged', () => {
    const before = `one\ntwo\n\n${note(BODY_A)}`
    const after = `one\ntwo\nthree\n\n${note(BODY_A)}`
    const live = mounted(before)
    expect(blockOf(live).dataset.line).toBe('3')
    expect(blockOf(staged(after)).dataset.line).toBe('4')
    patchChildren(live, staged(after))
    expect(blockOf(live).dataset.line).toBe('4')
    expect(blockOf(live).querySelector('[data-kanban-canvas]')).not.toBeNull()
  })

  it('drops the subtree when the body changed, so the board re-reads the fence', () => {
    const live = mounted(note(BODY_A))
    patchChildren(live, staged(note(BODY_B)))
    expect(blockOf(live).querySelector('[data-kanban-canvas]')).toBeNull()
    expect(blockOf(live).classList.contains('is-ready')).toBe(false)
  })

  // The block head is preserved on an unchanged body, so a switch that leaves the body identical has
  // to be visible in the markup some other way — the class is the only thing that says so.
  it('does not preserve when the staged copy switched to showing its source', () => {
    const live = mounted(note(BODY_A))
    const stagedHost = staged(note(BODY_A))
    blockOf(stagedHost).classList.add('kanban-source')
    patchChildren(live, stagedHost)
    expect(blockOf(live).querySelector('[data-kanban-canvas]')).toBeNull()
  })

  // Two copies that resolve to no body at all are *equal* as strings, so without the empty check the
  // guard would call them an unchanged board and keep a subtree that has nothing to read.
  it('does not treat two unregistered copies as an unchanged board', () => {
    const bareLive = document.createElement('div')
    bareLive.innerHTML = renderMarkdown(note(BODY_A)).html
    const block = bareLive.querySelector<HTMLElement>('[data-kanban]')!
    const canvas = document.createElement('div')
    canvas.dataset.kanbanCanvas = '1'
    block.append(canvas)
    const bareStaged = document.createElement('div')
    bareStaged.innerHTML = renderMarkdown(note(BODY_A)).html
    patchChildren(bareLive, bareStaged)
    expect(bareLive.querySelector('[data-kanban-canvas]')).toBeNull()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { buildTextIndex } from '../src/client/features/reading/engine/text-index'
import { readEpubSelection } from '../src/client/features/reading/reader/epub-selection'

let host: HTMLDivElement | null = null
afterEach(() => {
  window.getSelection()?.removeAllRanges()
  host?.remove()
  host = null
})

function select(root: HTMLElement, start: number, end: number) {
  const range = document.createRange()
  range.setStart(root.firstChild!.firstChild!, start)
  range.setEnd(root.firstChild!.firstChild!, end)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return range
}

describe('EPUB selection extraction', () => {
  it('keeps chapter offsets and surrounding anchor text', () => {
    host = document.createElement('div')
    host.innerHTML = '<p>before selected after</p>'
    document.body.appendChild(host)
    const index = buildTextIndex(host)
    const range = select(host, 7, 15)
    range.getBoundingClientRect = () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) })
    expect(readEpubSelection(host, index)).toMatchObject({ start: 7, end: 15, text: 'selected', prefix: 'before ', suffix: ' after' })
  })

  it('drops a range that begins outside the chapter', () => {
    host = document.createElement('div')
    host.innerHTML = '<p>inside</p>'
    const outside = document.createElement('p')
    outside.textContent = 'outside'
    document.body.appendChild(outside)
    document.body.appendChild(host)
    const range = document.createRange()
    range.setStart(outside.firstChild!, 0)
    range.setEnd(host.firstChild!.firstChild!, 3)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(readEpubSelection(host, buildTextIndex(host))).toBeNull()
    outside.remove()
  })
})

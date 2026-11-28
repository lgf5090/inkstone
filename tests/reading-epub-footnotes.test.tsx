// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEpubFootnotes, type FootnotePreview } from '../src/client/features/reading/reader/use-epub-footnotes'
import type { EpubHandle } from '../src/client/features/reading/reader/useEpubHandle'
import { installTestGlobals } from '../src/client/lib/test-render'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); host = null })

describe('EPUB footnote controller', () => {
  it('reads a local note and jumps back to its fragment', async () => {
    installTestGlobals()
    host = document.createElement('div')
    host.innerHTML = '<a data-reader-fragment="note" class="footnote-ref">1</a><aside id="note" role="doc-endnote"><p>Note text</p><a href="back">Back</a></aside>'
    document.body.appendChild(host)
    const onFootnote = vi.fn<(preview: FootnotePreview | null) => void>()
    const jump = vi.fn()
    let controller!: ReturnType<typeof useEpubFootnotes>
    function Probe() {
      controller = useEpubFootnotes({ handle: { pkg: {} } as EpubHandle, slot: 2, docRef: { current: host }, jump, onFootnote })
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() => root!.render(createElement(Probe)))
    const anchor = host.querySelector<HTMLElement>('a')!
    let note: Awaited<ReturnType<typeof controller.noteFor>> = null
    await act(async () => { note = await controller.noteFor(anchor) })
    expect(note).toEqual({ text: 'Note text', chapter: 2, fragment: 'note' })
    act(() => controller.showNote(anchor, note!))
    const preview = onFootnote.mock.calls[0]![0]!
    expect(preview.text).toBe('Note text')
    act(() => preview.onJump())
    expect(jump).toHaveBeenCalledWith({ kind: 'epub', chapter: 2, offset: 0 }, 'note')
  })
})

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { EpubHandle } from './useEpubHandle'
import type { BookPosition } from '../position'
import { spineIndexFor, stripFragment } from '../engine/epub-package'
import { footnotePointerOf, noteTargetFromHtml, noteTextOf } from '../engine/footnotes'
import { cssEscape } from './css-escape'

export interface FootnotePreview {
  text: string
  label: string
  rect: DOMRect
  onJump: () => void
}

export function useEpubFootnotes({
  handle,
  slot,
  docRef,
  jump,
  onFootnote,
}: {
  handle: EpubHandle
  slot: number
  docRef: RefObject<HTMLDivElement | null>
  jump: (position: BookPosition, fragment?: string) => void
  onFootnote: (preview: FootnotePreview | null) => void
}) {
  const emit = useRef(onFootnote)
  useEffect(() => { emit.current = onFootnote }, [onFootnote])
  const noteCache = useRef(new Map<string, string | null>())
  const hoverTimer = useRef(0)
  const hovered = useRef<HTMLElement | null>(null)

  const noteFor = useCallback(async (anchor: HTMLElement): Promise<{ text: string; chapter: number; fragment: string } | null> => {
    const doc = docRef.current
    const fragment = anchor.dataset.readerFragment ?? ''
    if (!doc || !fragment) return null
    const href = anchor.dataset.readerHref ?? ''
    const local = href === '' ? doc.querySelector<HTMLElement>(`[id="${cssEscape(fragment)}"]`) : null
    if (!footnotePointerOf(anchor, local)) return null
    if (local) return { text: noteTextOf(local), chapter: slot, fragment }
    const chapter = spineIndexFor(handle.pkg, stripFragment(href))
    if (chapter < 0) return null
    const key = `${chapter}#${fragment}`
    const known = noteCache.current.get(key)
    if (known !== undefined) return known ? { text: known, chapter, fragment } : null
    const prepared = await handle.prepare(chapter)
    const element = prepared ? noteTargetFromHtml(prepared.html, fragment) : null
    const text = element ? noteTextOf(element) : null
    noteCache.current.set(key, text)
    return text ? { text, chapter, fragment } : null
  }, [docRef, handle, slot])

  const showNote = useCallback((anchor: HTMLElement, note: { chapter: number; fragment: string; text: string }) => {
    emit.current({
      text: note.text,
      label: (anchor.textContent ?? '').trim().slice(0, 12),
      rect: anchor.getBoundingClientRect(),
      onJump: () => {
        const href = anchor.dataset.readerHref ?? ''
        const chapter = href ? spineIndexFor(handle.pkg, stripFragment(href)) : slot
        emit.current(null)
        if (chapter >= 0) jump({ kind: 'epub', chapter, offset: 0 }, note.fragment)
      },
    })
  }, [handle.pkg, jump, slot])

  const onPointerOver = useCallback((event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLElement>('a[data-reader-fragment]')
    if (!anchor || anchor === hovered.current) return
    hovered.current = anchor
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      void noteFor(anchor).then((note) => {
        if (note && hovered.current === anchor) showNote(anchor, note)
      })
    }, 180)
  }, [noteFor, showNote])

  const onPointerOut = useCallback((event: ReactPointerEvent) => {
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLElement>('a[data-reader-fragment]')
    if (!anchor || anchor !== hovered.current) return
    hovered.current = null
    window.clearTimeout(hoverTimer.current)
  }, [])

  const jumpTo = useCallback((link: HTMLElement) => {
    const href = link.dataset.readerHref ?? ''
    const fragment = link.dataset.readerFragment
    if (!href) {
      jump({ kind: 'epub', chapter: slot, offset: 0 }, fragment)
      return
    }
    const target = spineIndexFor(handle.pkg, stripFragment(href))
    if (target < 0) return
    jump({ kind: 'epub', chapter: target, offset: 0 }, fragment)
  }, [handle.pkg, jump, slot])

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [slot])

  return { noteFor, showNote, onPointerOver, onPointerOut, jumpTo }
}

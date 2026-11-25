import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { NoteSummary } from '@shared/types'
import { useBreakpoint } from '../../lib/hooks'

function scrollParentOf(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement
  while (parent && parent !== document.body) {
    const overflowY = getComputedStyle(parent).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return parent
    parent = parent.parentElement
  }
  return null
}

function useSidebarWindow(count: number, rowHeight: number, resetKey: string) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const [range, setRange] = useState({ start: 0, end: 0 })
  const overscan = 4

  const update = useCallback(() => {
    const node = containerRef.current
    if (!node || count === 0) {
      setRange({ start: 0, end: 0 })
      return
    }
    const rect = node.getBoundingClientRect()
    if (rect.height === 0 && rect.top === 0 && rect.bottom === 0) {
      setRange({ start: 0, end: Math.min(count, 60) })
      return
    }
    const scrollParent = scrollParentOf(node)
    scrollParentRef.current = scrollParent
    const clip = scrollParent?.getBoundingClientRect()
    const top = Math.max(rect.top, clip?.top ?? 0, 0)
    const bottom = Math.min(rect.bottom, clip?.bottom ?? window.innerHeight, window.innerHeight)
    if (bottom <= top) {
      setRange({ start: 0, end: 0 })
      return
    }
    const first = Math.max(0, Math.floor((top - rect.top) / rowHeight))
    const last = Math.min(count - 1, Math.ceil((bottom - rect.top) / rowHeight) - 1)
    const start = Math.max(0, first - overscan)
    const end = Math.min(count, last + overscan + 1)
    setRange((current) => current.start === start && current.end === end ? current : { start, end })
  }, [count, rowHeight])

  useLayoutEffect(() => {
    setRange({ start: 0, end: 0 })
    update()
  }, [resetKey, update])

  useLayoutEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(node)
    const scrollParent = scrollParentOf(node)
    if (scrollParent) observer?.observe(scrollParent)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [resetKey, update])

  const ensureVisible = useCallback((index: number) => {
    const node = containerRef.current
    if (!node || index < 0 || index >= count) return
    const rect = node.getBoundingClientRect()
    const scrollParent = scrollParentRef.current ?? scrollParentOf(node)
    const clip = scrollParent?.getBoundingClientRect()
    const top = Math.max(rect.top, clip?.top ?? 0, 0)
    const bottom = Math.min(rect.bottom, clip?.bottom ?? window.innerHeight, window.innerHeight)
    const rowTop = rect.top + index * rowHeight
    const rowBottom = rowTop + rowHeight
    const delta = rowTop < top ? rowTop - top : rowBottom > bottom ? rowBottom - bottom : 0
    if (delta && scrollParent) scrollParent.scrollTop += delta
    else if (delta) window.scrollBy(0, delta)
    update()
  }, [count, rowHeight, update])

  return { containerRef, ...range, ensureVisible }
}

export function WindowedNoteRows({ notes, resetKey, renderNote }: {
  notes: readonly NoteSummary[]
  resetKey: string
  renderNote: (note: NoteSummary, index: number) => ReactNode
}) {
  const breakpoint = useBreakpoint()
  const rowHeight = breakpoint === 'mobile' ? 45 : 31
  const virtual = useSidebarWindow(notes.length, rowHeight, resetKey)
  const pendingFocus = useRef<{ index: number; id: string } | null>(null)
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-sidebar-note-index]')
    if (!row || !virtual.containerRef.current?.contains(row)) return
    const index = Number(row.dataset.sidebarNoteIndex)
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    if (next < 0 || next >= notes.length) return
    event.preventDefault()
    event.stopPropagation()
    pendingFocus.current = { index: next, id: notes[next]!.id }
    virtual.ensureVisible(next)
  }
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending || notes[pending.index]?.id !== pending.id) return
    if (pending.index < virtual.start || pending.index >= virtual.end) return
    const wrapper = virtual.containerRef.current?.querySelector<HTMLElement>(`[data-sidebar-note-index="${pending.index}"]`)
    const row = wrapper?.querySelector<HTMLElement>('[data-tree-row]')
    row?.focus({ preventScroll: true })
    pendingFocus.current = null
  }, [notes, virtual.containerRef, virtual.end, virtual.start])
  const total = notes.length * rowHeight
  return (<div ref={virtual.containerRef} data-sidebar-window role="presentation" onKeyDownCapture={onKeyDownCapture}>
    {virtual.start > 0 && <div aria-hidden="true" style={{ height: virtual.start * rowHeight }}/>}
    <div className="space-y-px">
      {notes.slice(virtual.start, virtual.end).map((note, offset) => {
        const index = virtual.start + offset
        return <div key={note.id} data-sidebar-note-index={index}>{renderNote(note, index)}</div>
      })}
    </div>
    {virtual.end < notes.length && <div aria-hidden="true" style={{ height: total - virtual.end * rowHeight }}/>}
  </div>)
}

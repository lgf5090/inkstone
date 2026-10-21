import { useMemo, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { decodeDataValue } from '../../../lib/markdown/data-attr'
import { renderMarkdown } from '../../../lib/markdown/renderer'

export interface MemoBodyProps {
  content: string
  onTagPress?: (tag: string) => void
  className?: string
}

function memoHtml(content: string): string {
  const rendered = renderMarkdown(content, { hideFrontMatter: true })
  if (!rendered.html.includes('task-list-item-checkbox')) return rendered.html
  const frame = document.createElement('template')
  frame.innerHTML = rendered.html
  for (const input of frame.content.querySelectorAll('input[type="checkbox"]')) {
    input.setAttribute('disabled', '')
  }
  return frame.innerHTML
}

export function MemoBody({ content, onTagPress, className }: MemoBodyProps): ReactElement | null {
  const html = useMemo(() => (content.trim() ? memoHtml(content) : ''), [content])
  if (!html) return null
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const tag = target.closest<HTMLElement>('[data-tag]')
    if (tag) {
      event.preventDefault()
      const value = decodeDataValue(tag.dataset.tag)
      if (value) onTagPress?.(value)
      return
    }
    if (target.closest('a[data-wikilink]')) event.preventDefault()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!onTagPress || (event.key !== 'Enter' && event.key !== ' ')) return
    const target = event.target instanceof Element ? event.target : null
    const tag = target?.closest<HTMLElement>('[data-tag]')
    if (!tag) return
    event.preventDefault()
    const value = decodeDataValue(tag.dataset.tag)
    if (value) onTagPress(value)
  }
  return (
    <div
      className={cn('ink-prose min-w-0 text-[length:var(--text-13)]', className)}
      onClick={onClick}
      onKeyDown={onKeyDown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

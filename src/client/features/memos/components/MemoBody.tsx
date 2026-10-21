import { useMemo, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { MemoTagRule } from '@shared/memos/types'
import { cn } from '../../../lib/cn'
import { decodeDataValue } from '../../../lib/markdown/data-attr'
import { renderMarkdown } from '../../../lib/markdown/renderer'
import { findMentionRanges } from '../mentions'
import { matchingMemoTagRule } from '../tag-rules'
import { findMemoTasks, toggleMemoTask } from '../task-toggle'

const NO_TAG_RULES: readonly MemoTagRule[] = []

export interface MemoBodyProps {
  content: string
  tagRules?: readonly MemoTagRule[]
  onTagPress?: (tag: string) => void
  onToggleTask?: (nextContent: string) => void
  className?: string
}

function linkMentions(root: DocumentFragment): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text) nodes.push(node)
    node = walker.nextNode()
  }
  for (const textNode of nodes) {
    const text = textNode.data
    if (!text.includes('@')) continue
    const parent = textNode.parentElement
    if (!parent || parent.closest('code, pre, a, script, style')) continue
    const ranges = findMentionRanges(text)
    if (ranges.length === 0) continue
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const range of ranges) {
      if (range.start > cursor) fragment.append(document.createTextNode(text.slice(cursor, range.start)))
      const anchor = document.createElement('a')
      anchor.href = `${MEMOS_APP_PATH}/u/${encodeURIComponent(range.username)}`
      anchor.dataset.mention = range.username
      anchor.textContent = text.slice(range.start, range.end)
      fragment.append(anchor)
      cursor = range.end
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)))
    textNode.replaceWith(fragment)
  }
}

function paintTagRules(root: DocumentFragment, tagRules: readonly MemoTagRule[]): void {
  for (const tag of root.querySelectorAll<HTMLElement>('[data-tag]')) {
    const value = decodeDataValue(tag.dataset.tag)
    if (!value) continue
    const rule = matchingMemoTagRule(value, tagRules)
    if (!rule?.backgroundColor) continue
    const dot = document.createElement('span')
    dot.dataset.memoTagDot = ''
    dot.setAttribute('aria-hidden', 'true')
    dot.className = 'mr-1 inline-block size-[6px] rounded-[var(--r-full)] align-middle'
    dot.style.backgroundColor = rule.backgroundColor
    tag.prepend(dot)
  }
}

function memoHtml(
  content: string,
  interactiveTasks: boolean,
  tagRules: readonly MemoTagRule[],
): string {
  const rendered = renderMarkdown(content, { hideFrontMatter: true })
  const hasTags = tagRules.length > 0 && rendered.html.includes('data-tag=')
  if (!rendered.html.includes('task-list-item-checkbox') && !rendered.html.includes('@') && !hasTags) {
    return rendered.html
  }
  const frame = document.createElement('template')
  frame.innerHTML = rendered.html
  if (!interactiveTasks) {
    for (const input of frame.content.querySelectorAll('input[type="checkbox"]')) {
      input.setAttribute('disabled', '')
    }
  }
  linkMentions(frame.content)
  if (hasTags) paintTagRules(frame.content, tagRules)
  return frame.innerHTML
}

export function MemoBody({
  content,
  tagRules = NO_TAG_RULES,
  onTagPress,
  onToggleTask,
  className,
}: MemoBodyProps): ReactElement | null {
  const interactiveTasks = onToggleTask !== undefined
  const html = useMemo(
    () => (content.trim() ? memoHtml(content, interactiveTasks, tagRules) : ''),
    [content, interactiveTasks, tagRules],
  )
  if (!html) return null
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const checkbox = target.closest<HTMLInputElement>('input[type="checkbox"]')
    if (checkbox) {
      event.preventDefault()
      if (!onToggleTask) return
      const boxes = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      const index = boxes.indexOf(checkbox)
      if (index < 0) return
      const tasks = findMemoTasks(content)
      const line = Number(checkbox.dataset.taskLine)
      const marker = tasks.find((task) => Number.isInteger(line) && task.line === line) ?? tasks[index]
      if (!marker) return
      const next = toggleMemoTask(content, marker.index)
      if (next) onToggleTask(next)
      return
    }
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

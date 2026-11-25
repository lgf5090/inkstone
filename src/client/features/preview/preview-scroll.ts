import type { RefObject } from 'react'
import { slugifyHeading } from '@shared/markdown-utils'
import { preferredScrollBehavior } from '../../lib/motion'
import type { parseWikiTarget } from '../../lib/markdown/renderer'
import { revealPreviewTarget } from './markdown-tabs'

export function rewriteAssetUrls(root: HTMLElement, rewrite: (url: string) => string | null): void {
  for (const element of root.querySelectorAll<HTMLElement>('[src], [href]')) {
    for (const attribute of ['src', 'href']) {
      const value = element.getAttribute(attribute)
      if (!value) continue
      const next = rewrite(value)
      if (next) element.setAttribute(attribute, next)
    }
  }
}

export function scrollToWikiTarget(
  hostRef: RefObject<HTMLDivElement | null>,
  target: ReturnType<typeof parseWikiTarget>,
  isCurrent: () => boolean,
): () => void {
  if (!target.heading && !target.blockId) return () => {}
  const id = target.blockId ? `^${target.blockId}` : slugifyHeading(target.heading!)
  let attempts = 0
  let timer = 0
  let cancelled = false
  const find = () => {
    if (cancelled || !isCurrent()) return
    const element = hostRef.current?.querySelector(`#${CSS.escape(id)}`)
    if (element) scrollElementIntoView(element)
    else if (++attempts < 12) timer = window.setTimeout(find, 50)
  }
  find()
  return () => {
    cancelled = true
    window.clearTimeout(timer)
  }
}

export function scrollElementIntoView(element: Element | null | undefined): void {
  revealPreviewTarget(element)
  element?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' })
}

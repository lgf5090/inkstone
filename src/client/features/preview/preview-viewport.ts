import { truncateText } from '@shared/text-utils'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { previewSourceAnchors } from './preview-anchors'

export interface PreviewViewport {
  atTop: boolean
  atBottom: boolean
  scrollTop: number
  line: number | null
  tagName: string | null
  signature: string | null
  offset: number
}

export function capturePreviewViewport(scroller: HTMLElement, host: HTMLElement): PreviewViewport {
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const atTop = scroller.scrollTop <= 2
  const atBottom = maxScroll > 0 && scroller.scrollTop >= maxScroll - 4
  const scrollerRect = scroller.getBoundingClientRect()
  const viewportTop = scrollerRect.top + previewPaddingTop(scroller)
  const anchors = previewSourceAnchors(host)
  const anchor =
    anchors.reduce<HTMLElement | null>((closest, candidate) => {
      if (!closest) return candidate
      const closestDistance = Math.abs(closest.getBoundingClientRect().top - viewportTop)
      const candidateDistance = Math.abs(candidate.getBoundingClientRect().top - viewportTop)
      return candidateDistance < closestDistance ? candidate : closest
    }, null)

  return {
    atTop,
    atBottom,
    scrollTop: scroller.scrollTop,
    line: anchor ? sourceLine(anchor) : null,
    tagName: anchor?.tagName ?? null,
    signature: anchor ? previewAnchorSignature(anchor) : null,
    offset: anchor ? anchor.getBoundingClientRect().top - scrollerRect.top : 0,
  }
}

export function restorePreviewViewport(
  scroller: HTMLElement,
  host: HTMLElement,
  snapshot: PreviewViewport,
): void {
  if (snapshot.atTop) {
    if (snapshot.scrollTop > 0.5) scroller.scrollTop = 0
    return
  }
  if (snapshot.atBottom) {
    const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (Math.abs(scroller.scrollTop - bottom) > 0.5) scroller.scrollTop = bottom
    return
  }

  const anchors = previewSourceAnchors(host)
  let anchor: HTMLElement | null = null

  if (snapshot.signature) {
    const matches = anchors.filter(
      (candidate) => previewAnchorSignature(candidate) === snapshot.signature,
    )
    anchor = closestSourceLine(matches, snapshot.line)
  }
  if (!anchor && snapshot.line != null) {
    const sameLine = anchors.filter(
      (candidate) =>
        sourceLine(candidate) === snapshot.line &&
        (!snapshot.tagName || candidate.tagName === snapshot.tagName),
    )
    anchor = sameLine[0] ?? closestSourceLine(anchors, snapshot.line)
  }

  if (!anchor) {
    const fallback = Math.min(
      snapshot.scrollTop,
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    )
    if (Math.abs(scroller.scrollTop - fallback) > 0.5) scroller.scrollTop = fallback
    return
  }

  const currentOffset =
    anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const correction = currentOffset - snapshot.offset
  if (Math.abs(correction) > 0.5) scroller.scrollTop += correction
}

function closestSourceLine(
  elements: HTMLElement[],
  targetLine: number | null,
): HTMLElement | null {
  if (!elements.length) return null
  if (targetLine == null) return elements[0]!
  return elements.reduce((closest, candidate) => {
    const closestDistance = Math.abs((sourceLine(closest) ?? targetLine) - targetLine)
    const candidateDistance = Math.abs((sourceLine(candidate) ?? targetLine) - targetLine)
    return candidateDistance < closestDistance ? candidate : closest
  })
}

function sourceLine(element: HTMLElement): number | null {
  const value = Number(element.dataset.line)
  return Number.isFinite(value) ? value : null
}

function previewAnchorSignature(element: HTMLElement): string {
  const kind =
    element.dataset.lang ??
    (element.dataset.math ? decodeDataValue(element.dataset.math) : undefined) ??
    (element.dataset.mermaid ? decodeDataValue(element.dataset.mermaid) : undefined) ??
    element.tagName
  const text = truncateText((element.textContent ?? '').replace(/\s+/g, ' ').trim(), 240)
  return `${element.tagName}\u0000${kind}\u0000${text}`
}

function previewPaddingTop(scroller: HTMLElement): number {
  const value = Number.parseFloat(getComputedStyle(scroller).paddingTop)
  return Number.isFinite(value) ? value : 0
}

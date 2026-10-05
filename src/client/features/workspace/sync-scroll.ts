import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { EditorView } from '@codemirror/view'
import { previewSourceAnchors } from '../preview/preview-anchors'

export interface PreviewAnchor {
  line: number
  top: number
}

type ScrollSide = 'editor' | 'preview'
type ScrollEdge = 'top' | 'bottom' | null

const EDGE_EPSILON = 2
const DRIVER_IDLE_MS = 160

export function useSyncScroll(
  view: EditorView | null,
  previewRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): () => void {
  const anchorsRef = useRef<PreviewAnchor[] | null>(null)
  const curveRef = useRef<{
    from: PreviewAnchor[]
    lines: number
    paddingTop: number
    max: number
    curve: PreviewAnchor[]
  } | null>(null)
  const driverRef = useRef<ScrollSide | null>(null)
  const frameRef = useRef(0)
  const releaseRef = useRef(0)

  const invalidate = useCallback(() => {
    anchorsRef.current = null
    curveRef.current = null
  }, [])

  useEffect(() => {
    if (!enabled || !view) return
    const preview = previewRef.current
    if (!preview) return

    const editor = view.scrollDOM
    driverRef.current = null
    anchorsRef.current = null
    curveRef.current = null

    const getCurve = (paddingTop: number, max: number): PreviewAnchor[] => {
      anchorsRef.current ??= measurePreviewAnchors(preview)
      const anchors = anchorsRef.current
      const lines = view.state.doc.lines
      const cached = curveRef.current
      // Scrolling asks for the curve once per frame; rebuilding it walked and re-allocated
      // every anchor (2858 at 1 MB notes) 60 times a second.
      if (cached && cached.from === anchors && cached.lines === lines
        && cached.paddingTop === paddingTop && cached.max === max)
        return cached.curve
      const curve = buildScrollCurve(anchors, lines, paddingTop, max)
      curveRef.current = { from: anchors, lines, paddingTop, max, curve }
      return curve
    }

    const syncFromEditor = () => {
      const previewMax = maxScroll(preview)
      const edge = scrollEdge(editor.scrollTop, maxScroll(editor))
      if (edge === 'top') {
        setScrollTop(preview, 0)
        return
      }
      if (edge === 'bottom') {
        setScrollTop(preview, previewMax)
        return
      }

      const paddingTop = previewPaddingTop(preview)
      const target = previewTopForLine(getCurve(paddingTop, previewMax), editorLineAtScroll(view, editor.scrollTop))
      setScrollTop(preview, target - paddingTop)
    }

    const syncFromPreview = () => {
      const previewMax = maxScroll(preview)
      const edge = scrollEdge(preview.scrollTop, previewMax)
      if (edge === 'top') {
        setScrollTop(editor, 0)
        return
      }
      if (edge === 'bottom') {
        setScrollTop(editor, maxScroll(editor))
        return
      }

      const paddingTop = previewPaddingTop(preview)
      const line = sourceLineForPreviewTop(
        getCurve(paddingTop, previewMax),
        preview.scrollTop + paddingTop,
      )
      setScrollTop(editor, editorScrollForLine(view, line))
    }

    const releaseLater = (side: ScrollSide) => {
      window.clearTimeout(releaseRef.current)
      releaseRef.current = window.setTimeout(() => {
        if (driverRef.current === side) driverRef.current = null
      }, DRIVER_IDLE_MS)
    }

    const claim = (side: ScrollSide) => {
      if (driverRef.current !== side) cancelAnimationFrame(frameRef.current)
      driverRef.current = side
      releaseLater(side)
    }

    const schedule = (side: ScrollSide) => {
      if (driverRef.current !== side) return
      window.clearTimeout(releaseRef.current)
      cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        if (driverRef.current !== side) return
        if (side === 'editor') syncFromEditor()
        else syncFromPreview()
        releaseLater(side)
      })
    }

    const bindings = ([
      [editor, 'editor'],
      [preview, 'preview'],
    ] as const).map(([element, side]) => {
      const claimSide = () => claim(side)
      const onScroll = () => schedule(side)
      element.addEventListener('wheel', claimSide, { passive: true })
      element.addEventListener('pointerdown', claimSide, { passive: true })
      element.addEventListener('keydown', claimSide, true)
      element.addEventListener('scroll', onScroll, { passive: true })
      return { element, claimSide, onScroll }
    })

    const resizeObserver = new ResizeObserver(invalidate)
    resizeObserver.observe(preview)
    const content = preview.querySelector<HTMLElement>('[data-preview-content]')
    if (content) resizeObserver.observe(content)

    return () => {
      cancelAnimationFrame(frameRef.current)
      window.clearTimeout(releaseRef.current)
      driverRef.current = null
      bindings.forEach(({ element, claimSide, onScroll }) => {
        element.removeEventListener('wheel', claimSide)
        element.removeEventListener('pointerdown', claimSide)
        element.removeEventListener('keydown', claimSide, true)
        element.removeEventListener('scroll', onScroll)
      })
      resizeObserver.disconnect()
    }
  }, [enabled, invalidate, previewRef, view])

  return invalidate
}

export function measurePreviewAnchors(preview: HTMLElement): PreviewAnchor[] {
  const previewRect = preview.getBoundingClientRect()
  const anchors: PreviewAnchor[] = []
  let previousLine = -1
  let previousTop = Number.NEGATIVE_INFINITY

  for (const element of previewSourceAnchors(preview)) {
    const line = Number(element.dataset.line)
    const measuredTop = element.getBoundingClientRect().top - previewRect.top + preview.scrollTop
    if (!Number.isInteger(line) || line < 0 || !Number.isFinite(measuredTop)) continue
    if (line <= previousLine || measuredTop + 0.5 < previousTop) continue

    const top = Math.max(previousTop, measuredTop)
    anchors.push({ line, top })
    previousLine = line
    previousTop = top
  }

  return anchors
}

export function buildScrollCurve(
  measured: PreviewAnchor[],
  lineCount: number,
  paddingTop: number,
  previewMaxScroll: number,
): PreviewAnchor[] {
  const endLine = Math.max(1, Math.floor(Number.isFinite(lineCount) ? lineCount : 1))
  const startTop = Math.max(0, Number.isFinite(paddingTop) ? paddingTop : 0)
  const endTop = startTop + Math.max(0, Number.isFinite(previewMaxScroll) ? previewMaxScroll : 0)
  const curve: PreviewAnchor[] = [{ line: 0, top: startTop }]
  let previousLine = 0
  let previousTop = startTop

  for (const anchor of measured) {
    if (!Number.isFinite(anchor.line) || !Number.isFinite(anchor.top)) continue
    const line = Math.floor(anchor.line)
    const top = clamp(anchor.top, startTop, endTop)
    if (line <= previousLine || line >= endLine || top < previousTop) continue
    curve.push({ line, top })
    previousLine = line
    previousTop = top
  }

  curve.push({ line: endLine, top: endTop })
  return curve
}

export function previewTopForLine(curve: PreviewAnchor[], line: number): number {
  return interpolateAnchors(curve, line, 'line', 'top')
}

export function sourceLineForPreviewTop(curve: PreviewAnchor[], top: number): number {
  return interpolateAnchors(curve, top, 'top', 'line')
}

export function scrollEdge(scrollTop: number, maximum: number): ScrollEdge {
  if (scrollTop <= EDGE_EPSILON) return 'top'
  if (maximum > EDGE_EPSILON && scrollTop >= maximum - EDGE_EPSILON) return 'bottom'
  return null
}

function editorLineAtScroll(view: EditorView, top: number): number {
  const block = view.lineBlockAtHeight(Math.max(0, top))
  const line = view.state.doc.lineAt(block.from).number - 1
  const fraction = block.height > 0 ? clamp((top - block.top) / block.height, 0, 1) : 0
  return clamp(line + fraction, 0, view.state.doc.lines)
}

function editorScrollForLine(view: EditorView, exactLine: number): number {
  const doc = view.state.doc
  if (exactLine <= 0) return 0
  if (exactLine >= doc.lines) return maxScroll(view.scrollDOM)

  const lineIndex = Math.floor(exactLine)
  const lineNumber = Math.min(doc.lines, lineIndex + 1)
  const block = view.lineBlockAt(doc.line(lineNumber).from)
  return block.top + clamp(exactLine - lineIndex, 0, 1) * block.height
}

function interpolateAnchors(
  anchors: PreviewAnchor[],
  value: number,
  input: keyof PreviewAnchor,
  output: keyof PreviewAnchor,
): number {
  const first = anchors[0]
  const last = anchors[anchors.length - 1]
  if (!first || !last) return 0
  if (value <= first[input]) return first[output]
  if (value >= last[input]) return last[output]

  const index = upperBoundAnchor(anchors, value, (anchor) => anchor[input])
  const before = anchors[index - 1]!
  const after = anchors[index]!
  const span = after[input] - before[input]
  if (span <= 0) return after[output]
  const progress = (value - before[input]) / span
  return before[output] + progress * (after[output] - before[output])
}

function upperBoundAnchor(
  anchors: PreviewAnchor[],
  value: number,
  select: (anchor: PreviewAnchor) => number,
): number {
  let low = 0
  let high = anchors.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (select(anchors[middle]!) <= value) low = middle + 1
    else high = middle
  }
  return low
}

function maxScroll(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

function setScrollTop(element: HTMLElement, value: number): void {
  const target = clamp(value, 0, maxScroll(element))
  if (Math.abs(element.scrollTop - target) > 0.5) element.scrollTop = target
}

function previewPaddingTop(preview: HTMLElement): number {
  const value = Number.parseFloat(getComputedStyle(preview).paddingTop)
  return Number.isFinite(value) ? value : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

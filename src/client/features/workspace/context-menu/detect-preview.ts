import { decodeDataValue } from '../../../lib/markdown/data-attr'
import { kanbanBody, kanbanFenceRef } from '../../../lib/markdown/kanban/view'
import { mindmapBody, mindmapFenceRef } from '../../../lib/markdown/mindmap/view'
import { fenceContextKind, type PreviewContext } from './types'

/**
 * What the pointer landed on, read out of the rendered document.
 *
 * Every block carries the line of the note it came from, which is what lets a menu item hand its edit
 * to the fence surgery rather than trying to write the DOM it is looking at. `data-line` is the
 * renderer's own stamp; a block that has none is reported without one, and the items that need a line
 * to act are then simply not offered.
 */

function sourceLine(el: Element | null): number | undefined {
  const nearest = el?.closest<HTMLElement>('[data-line]')
  const raw = nearest?.dataset.line
  if (raw === undefined || raw === '') return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function detectSelection(target: Element): PreviewContext | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  // `Selection.containsNode` is a Gecko-only API, and where it exists it answers for partial
  // containment in a way that cannot be trusted; the standard range test is what actually asks
  // whether the highlighted span reaches this element.
  if (!target.isConnected || !selection.getRangeAt(0).intersectsNode(target)) return null
  const text = selection.toString()
  if (!text.trim()) return null
  return { kind: 'selection', target, selectedText: text, line: sourceLine(target) }
}

function detectFrontmatter(target: Element): PreviewContext | null {
  if (!target.closest('[data-note-properties], .frontmatter-properties, .frontmatter-error')) return null
  return { kind: 'frontmatter', target, line: 0 }
}

function detectExample(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('.markdown-example[data-example-family]')
  if (!el) return null
  const language = el.dataset.exampleFamily === 'js' ? 'javascript-example' : 'md-example'
  const encoded = el.dataset.markdownExample
  const body = encoded === undefined ? (el.querySelector('pre code')?.textContent ?? '') : decodeDataValue(encoded)
  return {
    kind: 'example',
    target,
    line: sourceLine(el),
    fence: { language, info: language, body, title: el.querySelector('.markdown-example-title')?.textContent ?? '' },
  }
}

function detectMermaid(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('[data-mermaid]')
  if (!el) return null
  return {
    kind: 'mermaid',
    target,
    line: sourceLine(el),
    fence: { language: 'mermaid', info: 'mermaid', body: decodeDataValue(el.dataset.mermaid) },
  }
}

function detectChart(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('[data-chart]')
  if (!el) return null
  return {
    kind: 'chart',
    target,
    line: sourceLine(el),
    fence: { language: 'chart', info: 'chart', body: decodeDataValue(el.dataset.chart) },
  }
}

function detectMindmap(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('[data-mindmap]')
  if (!el) return null
  const ref = mindmapFenceRef(el)
  return {
    kind: 'mindmap',
    target,
    line: ref?.line ?? sourceLine(el),
    fence: { language: 'mindmap', info: 'mindmap', body: ref?.body ?? mindmapBody(el) },
  }
}

function detectKanban(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('[data-kanban]')
  if (!el) return null
  const ref = kanbanFenceRef(el)
  return {
    kind: 'kanban',
    target,
    line: ref?.line ?? sourceLine(el),
    fence: { language: 'kanban', info: 'kanban', body: ref?.body ?? kanbanBody(el) },
  }
}

function detectMath(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('.math-block, .math-inline, .katex-display, .katex')
  if (!el) return null
  const holder = el.closest<HTMLElement>('[data-math]') ?? el
  const encoded = holder.dataset.math
  const annotation = holder.querySelector('annotation[encoding="application/x-tex"]')
  return {
    kind: 'math',
    target,
    line: sourceLine(holder),
    math: {
      formula: encoded === undefined ? (annotation?.textContent ?? holder.textContent ?? '') : decodeDataValue(encoded),
      block: Boolean(el.closest('.math-block')) || el.classList.contains('katex-display'),
    },
  }
}

function detectTable(target: Element): PreviewContext | null {
  const cell = target.closest('td, th') as HTMLTableCellElement | null
  if (!cell) return null
  const table = cell.closest('table')
  const row = cell.closest('tr')
  if (!table || !row) return null
  const body = table.querySelector('tbody')
  const rows = body ? [...body.querySelectorAll('tr')] : []
  const header = cell.tagName.toLowerCase() === 'th'
  return {
    kind: 'table',
    target,
    line: sourceLine(table),
    table: { rowIndex: header ? -1 : rows.indexOf(row) + 1, colIndex: cell.cellIndex },
  }
}

function detectTag(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('[data-tag]')
  if (!el) return null
  return { kind: 'tag', target, line: sourceLine(el), tag: { name: decodeDataValue(el.dataset.tag) } }
}

function detectEmbed(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('[data-embed-target]')
  if (!el) return null
  return { kind: 'embed', target, line: sourceLine(el), embed: { target: decodeDataValue(el.dataset.embedTarget) } }
}

function detectWikiLink(target: Element): PreviewContext | null {
  const el = target.closest<HTMLElement>('[data-wikilink]')
  if (!el) return null
  const title = decodeDataValue(el.dataset.wikilink).split('|')[0]!.trim()
  const label = (el.textContent ?? '').trim()
  return { kind: 'wikilink', target, line: sourceLine(el), wikiLink: { target: title, alias: label === title ? '' : label } }
}

function detectImage(target: Element): PreviewContext | null {
  const img = target.closest('img')
  if (!img?.src) return null
  return { kind: 'image', target, line: sourceLine(img), image: { src: img.src, alt: img.alt } }
}

function detectCodeBlock(target: Element): PreviewContext | null {
  const block = target.closest<HTMLElement>('.code-block')
  if (!block) return null
  const language = (block.dataset.lang ?? '').toLowerCase()
  return {
    kind: fenceContextKind(language),
    target,
    line: sourceLine(block),
    fence: { language, info: language, body: block.querySelector('pre')?.textContent ?? '' },
  }
}

function detectTask(target: Element): PreviewContext | null {
  const item = target.closest<HTMLElement>('li[data-task-line]')
    ?? (target.closest('input[type="checkbox"]') ? target.closest('li') : null)
  if (!item) return null
  const raw = item.dataset.taskLine
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  const checkbox = item.querySelector<HTMLInputElement>('input[type="checkbox"]')
  return {
    kind: 'task',
    target,
    line: Number.isInteger(parsed) && parsed >= 0 ? parsed : sourceLine(item),
    task: { checked: checkbox?.checked ?? false },
  }
}

function detectLink(target: Element): PreviewContext | null {
  const link = target.closest('a[href]') as HTMLAnchorElement | null
  if (!link || link.hasAttribute('data-wikilink') || link.hasAttribute('data-tag')) return null
  const href = link.getAttribute('href') ?? ''
  if (!href || href.startsWith('#')) return null
  return { kind: 'link', target, line: sourceLine(link), link: { text: link.textContent ?? '', url: link.href } }
}

const CONTAINERS: Array<{ selector: string; directive: (el: HTMLElement) => string }> = [
  { selector: '[data-tabs]', directive: () => 'tabs' },
  { selector: '[data-align]', directive: (el) => `align ${el.dataset.align ?? ''}`.trim() },
  { selector: '.markdown-cols', directive: () => 'cols' },
  { selector: '.markdown-media', directive: () => 'media' },
  { selector: '.markdown-timeline, [data-timeline]', directive: () => 'timeline' },
  {
    selector: '.markdown-details',
    directive: (el) => `details ${el.querySelector('summary')?.textContent ?? ''}`.trim(),
  },
  {
    selector: '.callout',
    directive: (el) => `callout ${el.dataset.calloutType ?? ''}`.trim(),
  },
]

function detectContainer(target: Element): PreviewContext | null {
  for (const { selector, directive } of CONTAINERS) {
    const el = target.closest<HTMLElement>(selector)
    if (!el) continue
    return { kind: 'container', target, line: sourceLine(el), container: { directive: directive(el) } }
  }
  return null
}

function detectHeading(target: Element): PreviewContext | null {
  const el = target.closest('h1, h2, h3, h4, h5, h6')
  if (!el) return null
  return {
    kind: 'heading',
    target,
    line: sourceLine(el),
    heading: { level: Number(el.tagName.slice(1)), text: (el.textContent ?? '').trim() },
  }
}

/**
 * Ordered by how specific the match is, not by how common. A diagram block is looked for before the
 * `.code-block` it is drawn inside, because a menu that read a board's markup as plain text would
 * offer the code block's actions on the block the note actually owns.
 */
const DETECTORS: Array<(target: Element) => PreviewContext | null> = [
  detectSelection,
  detectFrontmatter,
  detectExample,
  detectMermaid,
  detectChart,
  detectMindmap,
  detectKanban,
  detectMath,
  detectTable,
  detectTag,
  detectEmbed,
  detectWikiLink,
  detectImage,
  detectCodeBlock,
  detectTask,
  detectLink,
  detectContainer,
  detectHeading,
]

export function detectPreviewContext(target: Element): PreviewContext {
  for (const detect of DETECTORS) {
    const found = detect(target)
    if (found) return found
  }
  return { kind: 'empty', target, line: sourceLine(target) }
}

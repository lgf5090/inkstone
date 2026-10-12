/**
 * Article HTML as a note a reader can keep editing.
 *
 * A saved article is written into the vault as Markdown, not as a blob of HTML, because that is the
 * form everything else in this app can read: a note that carries a publication's `<div class="entry">`
 * scaffolding cannot be searched, restyled or quoted by its author later. So this is a deliberate
 * downgrade — headings, lists, quotes, code, links and pictures survive; a two-column layout does
 * not.
 *
 * It walks a detached tree rather than rewriting strings because the markup arrives from a feed, and
 * a regex would have to guess where a list ends. Anything it cannot name contributes its text, which
 * is the failure mode that keeps a saved note readable.
 */

/**
 * A `<br>` is kept as a marker until the whitespace pass is over, because that pass is exactly what
 * would eat the two spaces Markdown reads as a line break.
 */
const HARD_BREAK = '\u2028'

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'ul',
])

interface Writer {
  /** A note has to outlive the session that saved it, so a relayed address goes back to its origin. */
  rewriteUrl: (url: string) => string
}

export function htmlToMarkdown(html: string, rewriteUrl: (url: string) => string = url => url): string {
  const writer: Writer = { rewriteUrl }
  const host = document.createElement('div')
  host.innerHTML = html || ''
  const blocks: string[] = []
  let paragraph = ''

  const flush = (): void => {
    const text = collapseParagraph(paragraph)
    if (text) blocks.push(text)
    paragraph = ''
  }

  for (const node of Array.from(host.childNodes)) {
    const kind = nodeKind(node)
    if (kind === 'text') {
      paragraph += node.textContent || ''
      continue
    }
    if (kind !== 'element') continue
    const element = node as HTMLElement
    const tag = element.tagName.toLowerCase()
    if (!BLOCK_TAGS.has(tag)) {
      paragraph += inlineElement(element, tag, writer)
      continue
    }
    flush()
    const rendered = blockElement(element, tag, writer)
    if (rendered) blocks.push(rendered)
  }
  flush()
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

function nodeKind(node: Node): 'text' | 'element' | 'other' {
  if (node.nodeType === Node.TEXT_NODE) return 'text'
  if (node.nodeType === Node.ELEMENT_NODE) return 'element'
  return 'other'
}

/** A run of inline content, with the line breaks a feed wrote inside it kept. */
function collapseParagraph(value: string): string {
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(HARD_BREAK_GLOBAL, '  \n')
    .trim()
}

const HARD_BREAK_GLOBAL = new RegExp(HARD_BREAK, 'g')

/** Inline content of a node, with nested blocks rendered as their own paragraphs inside it. */
function inlineOf(element: HTMLElement, writer: Writer): string {
  let out = ''
  for (const node of Array.from(element.childNodes)) {
    const kind = nodeKind(node)
    if (kind === 'text') {
      out += node.textContent || ''
      continue
    }
    if (kind !== 'element') continue
    const child = node as HTMLElement
    const tag = child.tagName.toLowerCase()
    if (!BLOCK_TAGS.has(tag)) {
      out += inlineElement(child, tag, writer)
      continue
    }
    const rendered = blockElement(child, tag, writer)
    out += rendered ? `\n${rendered}\n` : ''
  }
  return out
}

function inlineElement(element: HTMLElement, tag: string, writer: Writer): string {
  const inner = () => inlineOf(element, writer)
  switch (tag) {
    case 'br':
      return HARD_BREAK
    case 'a': {
      const href = element.getAttribute('href') || ''
      const label = inner().trim()
      return href ? `[${label || href}](${writer.rewriteUrl(href)})` : label
    }
    case 'img': {
      const src = element.getAttribute('src') || ''
      if (!src) return ''
      const alt = (element.getAttribute('alt') || '').replace(/[[\]\\]/g, ' ')
      return `![${alt}](${writer.rewriteUrl(src)})`
    }
    case 'code':
      return '`' + (element.textContent || '').replace(/`/g, "'").replace(/\s+/g, ' ') + '`'
    case 'strong':
    case 'b':
      return `**${inner().trim()}**`
    case 'em':
    case 'i':
    case 'cite':
    case 'var':
      return `*${inner().trim()}*`
    case 'del':
    case 's':
      return `~~${inner().trim()}~~`
    default:
      return inner()
  }
}

function blockElement(element: HTMLElement, tag: string, writer: Writer): string {
  const inner = collapseMultiline(inlineOf(element, writer))
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `${'#'.repeat(Number(tag[1]))} ${inner.replace(/\s+/g, ' ')}`
    case 'hr':
      return '---'
    case 'pre': {
      const code = element.querySelector('code') || element
      const language = /language-([\w-]+)/.exec(code.className)?.[1] ?? ''
      return `\`\`\`${language}\n${(code.textContent ?? '').replace(/\s+$/, '')}\n\`\`\``
    }
    case 'blockquote':
      return inner.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n')
    case 'ul':
    case 'ol':
      return list(element, tag === 'ol', writer)
    case 'table':
      return table(element, writer)
    case 'dl':
      return definitionList(element, writer)
    default:
      return inner
  }
}

/**
 * A block that holds several paragraphs keeps them.
 *
 * Collapsing every run of whitespace would turn a saved article into one unbroken wall of text, so
 * only runs of spaces go; a blank line inside a container survives as a paragraph break, and a
 * `<br>` marker becomes the two spaces that spell one in Markdown.
 */
function collapseMultiline(value: string): string {
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(HARD_BREAK_GLOBAL, '  \n')
    .trim()
}

function list(element: HTMLElement, ordered: boolean, writer: Writer): string {
  const lines: string[] = []
  let index = Number(element.getAttribute('start') || '1')
  for (const item of Array.from(element.children)) {
    if (item.tagName.toLowerCase() !== 'li') continue
    const nested: string[] = []
    let text = ''
    for (const node of Array.from(item.childNodes)) {
      const kind = nodeKind(node)
      if (kind === 'text') {
        text += node.textContent || ''
        continue
      }
      if (kind !== 'element') continue
      const child = node as HTMLElement
      const tag = child.tagName.toLowerCase()
      if (tag === 'ul' || tag === 'ol') {
        nested.push(indent(list(child, tag === 'ol', writer)))
        continue
      }
      if (!BLOCK_TAGS.has(tag)) {
        text += inlineElement(child, tag, writer)
        continue
      }
      text += `\n${blockElement(child, tag, writer)}\n`
    }
    const body = [collapseMultiline(text), ...nested].filter(Boolean).join('\n')
    const bullet = ordered ? `${index++}. ` : '- '
    const task = /^\s*\[([ xX])\]\s*/.exec(body)
    lines.push(task ? `${bullet}[${task[1] === ' ' ? ' ' : 'x'}] ${body.slice(task[0].length)}` : `${bullet}${body}`)
  }
  return lines.join('\n')
}

function indent(value: string): string {
  return value.split('\n').map(line => (line ? `  ${line}` : line)).join('\n')
}

function definitionList(element: HTMLElement, writer: Writer): string {
  const lines: string[] = []
  for (const child of Array.from(element.children)) {
    const tag = child.tagName.toLowerCase()
    if (tag !== 'dt' && tag !== 'dd') continue
    const text = collapseParagraph(inlineOf(child as HTMLElement, writer))
    if (!text) continue
    lines.push(tag === 'dt' ? `**${text}**` : `  ${text}`)
  }
  return lines.join('\n')
}

/**
 * A table as GitHub-flavoured Markdown, or as its text when the shape will not fit.
 *
 * Merged cells have no Markdown spelling, so a table that uses `colspan`/`rowspan` is flattened
 * rather than misrepresented: a reader would rather see the numbers in a list than a grid with the
 * wrong totals under the wrong headings.
 */
function table(element: HTMLElement, writer: Writer): string {
  const rows = Array.from(element.querySelectorAll('tr'))
  if (!rows.length) return collapseParagraph(inlineOf(element, writer))
  const cells = (row: Element): Element[] => Array.from(row.children)
    .filter(cell => /^(td|th)$/.test(cell.tagName.toLowerCase()))
  const merged = Array.from(element.querySelectorAll('td,th'))
    .some(cell => cell.hasAttribute('colspan') || cell.hasAttribute('rowspan'))
  if (merged || rows.some(row => !cells(row).length)) {
    return rows
      .map(row => cells(row).map(cell => collapseParagraph(inlineOf(cell as HTMLElement, writer))).filter(Boolean).join(' · '))
      .filter(Boolean)
      .join('\n')
  }
  const grid = rows.map(row => cells(row).map(cell => collapseParagraph(inlineOf(cell as HTMLElement, writer)).replace(/\|/g, '\\|')))
  const width = Math.max(...grid.map(row => row.length))
  const padded = grid.map(row => [...row, ...Array.from({ length: width - row.length }, () => '')])
  const line = (row: string[]): string => `| ${row.join(' | ')} |`
  return [line(padded[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...padded.slice(1).map(line)].join('\n')
}

import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import DOMPurify from 'dompurify'
import { normalizeGithubImageUrl } from '@shared/development/github/image'
import { t } from '../../../../lib/i18n'
import { encodeDataValue } from '../../../../lib/markdown/data-attr'

export interface ReadmeRenderOptions {
  fullName: string
  defaultBranch: string
}

type UrlKind = 'link' | 'image'

const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'hr', 'br',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup',
  'a', 'span', 'strong', 'em', 'b', 'i', 'u', 'del', 'ins', 's', 'sub', 'sup',
  'mark', 'kbd', 'abbr', 'cite', 'q', 'small', 'details', 'summary', 'figure',
  'figcaption', 'dl', 'dt', 'dd', 'ruby', 'rt', 'rp', 'img', 'center',
  'picture', 'source', 'video',
]

const ALLOWED_ATTR = [
  'class', 'id', 'title', 'alt', 'href', 'target', 'rel', 'src', 'width',
  'height', 'loading', 'referrerpolicy', 'align', 'valign', 'colspan', 'rowspan', 'start',
  'open', 'dir', 'lang', 'role', 'srcset', 'sizes', 'media', 'type', 'controls', 'poster', 'playsinline',
  'data-math',
]

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base']
const FORBID_ATTR = ['style', 'formaction']
const EXTERNAL_URL = /^(?:https?:|mailto:|tel:)/i
const SAFE_CLASS = /^(?:language-[A-Za-z0-9+#._-]+|github-md-table|gh-task-item|gh-task|gh-task-done|gh-alert|gh-alert-note|gh-alert-tip|gh-alert-important|gh-alert-warning|gh-alert-caution|footnote-ref|footnotes|footnotes-list|footnote-item|footnote-backref|footnotes-sep|math-inline|math-block)$/
const TASK_MARKER = /^\[([ xX])\]\s+/
const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i
const ALERT_LABELS = {
  note: 'development.github.repos.alert_note',
  tip: 'development.github.repos.alert_tip',
  important: 'development.github.repos.alert_important',
  warning: 'development.github.repos.alert_warning',
  caution: 'development.github.repos.alert_caution',
} as const
const README_ID_PREFIX = 'readme-'

function isExternalUrl(value: string): boolean {
  return EXTERNAL_URL.test(value.trim())
}

function normalizeRelativePath(path: string): string {
  const output: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      output.pop()
      continue
    }
    output.push(part)
  }
  return output.join('/')
}

function finishImageUrl(value: string): string {
  const upgraded = value.startsWith('http://') ? `https://${value.slice('http://'.length)}` : value
  return normalizeGithubImageUrl(upgraded)
}

function resolveUrl(rawUrl: string, options: ReadmeRenderOptions, kind: UrlKind): string | null {
  const url = rawUrl.trim()
  if (!url) return ''
  if (url.startsWith('/api/development/github/image?')) return url
  if (url.startsWith('#')) return url
  if (url.startsWith('//')) return kind === 'image' ? finishImageUrl(`https:${url}`) : `https:${url}`
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase()
    if (protocol === 'http' || protocol === 'https') {
      return kind === 'image' ? finishImageUrl(url) : url
    }
    if (protocol === 'mailto' || protocol === 'tel') return url
    if (kind === 'image' && protocol === 'data' && /^data:image\//i.test(url)) return url
    return null
  }
  const boundary = url.search(/[?#]/)
  const path = boundary === -1 ? url : url.slice(0, boundary)
  const suffix = boundary === -1 ? '' : url.slice(boundary)
  const relative = normalizeRelativePath(path.replace(/^\.\//, '').replace(/^\//, ''))
  if (kind === 'image') {
    return `https://raw.githubusercontent.com/${options.fullName}/${options.defaultBranch}/${relative}${suffix}`
  }
  return `https://github.com/${options.fullName}/blob/${options.defaultBranch}/${relative}${suffix}`
}

function slugifyHeading(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

function assignHeadingIds(template: HTMLTemplateElement): void {
  const used = new Set<string>()
  for (const heading of Array.from(template.content.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    const existing = heading.getAttribute('id')
    if (existing) {
      used.add(existing)
      continue
    }
    const base = slugifyHeading(heading.textContent ?? '')
    let slug = base
    let suffix = 1
    while (used.has(slug)) {
      slug = `${base}-${suffix}`
      suffix += 1
    }
    used.add(slug)
    heading.setAttribute('id', slug)
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderMarkdown(md: string, options: ReadmeRenderOptions): string {
  const instance = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false,
  })

  instance.use(footnote)

  instance.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const start = state.pos
    if (state.src[start] !== '$' || state.src[start + 1] === '$') return false
    if (start > 0 && state.src[start - 1] === '\\') return false
    let end = start + 1
    while (end < state.posMax) {
      if (state.src[end] === '$') break
      end += 1
    }
    if (end >= state.posMax) return false
    const content = state.src.slice(start + 1, end)
    if (!content.trim() || content.startsWith(' ') || content.endsWith(' ')) return false
    if (!silent) state.push('math_inline', 'span', 0).content = content
    state.pos = end + 1
    return true
  })

  instance.renderer.rules.math_inline = (tokens, index) => {
    const content = tokens[index]!.content
    return `<span class="math-inline" data-math="${encodeDataValue(content)}">${escapeHtml(content)}</span>`
  }

  instance.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const firstLine = state.src.slice(start, state.eMarks[startLine])
    if (!firstLine.startsWith('$$')) return false
    const single = /^\$\$(.+?)\$\$\s*$/.exec(firstLine)
    if (single) {
      if (!silent) state.push('math_block', 'span', 0).content = single[1]!.trim()
      state.line = startLine + 1
      return true
    }
    if (firstLine.trim() !== '$$') return false
    const lines: string[] = []
    for (let next = startLine + 1; next < endLine; next += 1) {
      const text = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next])
      if (text.trim() === '$$') {
        if (!silent) state.push('math_block', 'span', 0).content = lines.join('\n').trim()
        state.line = next + 1
        return true
      }
      lines.push(text)
    }
    return false
  })

  instance.renderer.rules.math_block = (tokens, index) => {
    const content = tokens[index]!.content
    return `<span class="math-block" data-math="${encodeDataValue(content)}">${escapeHtml(content)}</span>`
  }

  instance.renderer.rules.link_open = (tokens, index, renderOptions, _env, self) => {
    const token = tokens[index]!
    const resolved = resolveUrl(token.attrGet('href') ?? '', options, 'link')
    if (resolved === null) token.attrSet('href', '')
    else token.attrSet('href', resolved)
    if (resolved && isExternalUrl(resolved)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
    return self.renderToken(tokens, index, renderOptions)
  }

  instance.renderer.rules.table_open = (tokens, index, renderOptions, _env, self) => {
    tokens[index]!.attrJoin('class', 'github-md-table')
    return self.renderToken(tokens, index, renderOptions)
  }

  instance.renderer.rules.th_open = (tokens, index, renderOptions, _env, self) => {
    const token = tokens[index]!
    const match = /text-align:\s*(left|center|right)/i.exec(token.attrGet('style') ?? '')
    if (match) {
      token.attrSet('align', match[1]!.toLowerCase())
      token.attrSet('style', '')
    }
    return self.renderToken(tokens, index, renderOptions)
  }
  instance.renderer.rules.td_open = instance.renderer.rules.th_open

  instance.renderer.rules.image = (tokens, index, renderOptions, _env, self) => {
    const token = tokens[index]!
    const resolved = resolveUrl(token.attrGet('src') ?? '', options, 'image')
    if (resolved === null) token.attrSet('src', '')
    else token.attrSet('src', resolved)
    token.attrSet('loading', 'lazy')
    token.attrSet('referrerpolicy', 'no-referrer')
    return self.renderToken(tokens, index, renderOptions)
  }

  return instance.render(md)
}

function resolveHtmlUrls(html: string, options: ReadmeRenderOptions): string {
  if (typeof document === 'undefined') return html
  const template = document.createElement('template')
  template.innerHTML = html
  for (const element of Array.from(template.content.querySelectorAll('a[href], img[src]'))) {
    const tag = element.tagName.toLowerCase()
    const attribute = tag === 'a' ? 'href' : 'src'
    const value = element.getAttribute(attribute)
    if (value === null) continue
    const resolved = resolveUrl(value, options, tag === 'a' ? 'link' : 'image')
    if (resolved === null || (tag === 'a' && /^data:/i.test(resolved))) {
      element.removeAttribute(attribute)
      continue
    }
    element.setAttribute(attribute, resolved)
    if (tag === 'a' && isExternalUrl(resolved)) {
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    }
    if (tag === 'img') {
      element.setAttribute('loading', 'lazy')
      element.setAttribute('referrerpolicy', 'no-referrer')
    }
  }

  for (const node of Array.from(template.content.querySelectorAll('source[srcset], img[srcset]'))) {
    const value = node.getAttribute('srcset') ?? ''
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [url, ...descriptor] = entry.split(/\s+/)
        if (!url) return ''
        const resolved = resolveUrl(url, options, 'image')
        if (resolved === null || resolved === '') return ''
        return [resolved, ...descriptor].join(' ')
      })
      .filter(Boolean)
    if (entries.length > 0) node.setAttribute('srcset', entries.join(', '))
    else node.removeAttribute('srcset')
  }

  for (const item of Array.from(template.content.querySelectorAll('li'))) {
    const holder = item.querySelector(':scope > p') ?? item
    const first = holder.firstChild
    if (!first || first.nodeType !== Node.TEXT_NODE) continue
    const text = first.textContent ?? ''
    const match = TASK_MARKER.exec(text)
    if (!match) continue
    first.textContent = text.slice(match[0].length)
    const done = match[1]!.toLowerCase() === 'x'
    const mark = document.createElement('span')
    mark.className = done ? 'gh-task gh-task-done' : 'gh-task'
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', t(done
      ? 'development.github.repos.task_done'
      : 'development.github.repos.task_todo'))
    holder.insertBefore(mark, first)
    item.classList.add('gh-task-item')
  }

  for (const quote of Array.from(template.content.querySelectorAll('blockquote'))) {
    const first = quote.querySelector(':scope > p')
    if (!first) continue
    const match = ALERT_MARKER.exec(first.textContent ?? '')
    if (!match) continue
    const kind = match[1]!.toLowerCase() as keyof typeof ALERT_LABELS
    quote.classList.add('gh-alert', `gh-alert-${kind}`)
    quote.setAttribute('data-label', t(ALERT_LABELS[kind]))
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()
    if (text?.nodeValue) text.nodeValue = text.nodeValue.slice(match[0].length).replace(/^\s+/, '')
  }
  return template.innerHTML
}

function sanitizeHtml(html: string, options: ReadmeRenderOptions): string {
  const resolved = resolveHtmlUrls(html, options)
  const clean = DOMPurify.sanitize(resolved, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    FORBID_ATTR,
    KEEP_CONTENT: true,
  })
  if (typeof document === 'undefined') return clean
  const template = document.createElement('template')
  template.innerHTML = clean

  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    const tag = element.tagName.toLowerCase()
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'style' || attribute.name.startsWith('on')) element.removeAttribute(attribute.name)
    }
    const className = element.getAttribute('class')
    if (className !== null) {
      const safe = className.split(/\s+/).filter((name) => SAFE_CLASS.test(name))
      if (safe.length > 0) element.setAttribute('class', safe.join(' '))
      else element.removeAttribute('class')
    }
    if (tag === 'a') {
      const href = element.getAttribute('href')
      if (href === null) continue
      const resolved = resolveUrl(href, options, 'link')
      if (resolved === null || /^data:/i.test(resolved)) {
        element.removeAttribute('href')
        continue
      }
      element.setAttribute('href', resolved)
      if (isExternalUrl(resolved)) {
        element.setAttribute('target', '_blank')
        element.setAttribute('rel', 'noopener noreferrer')
      }
    }
    if (tag === 'img') {
      const src = element.getAttribute('src')
      if (src === null) continue
      const resolved = resolveUrl(src, options, 'image')
      if (resolved === null) element.removeAttribute('src')
      else element.setAttribute('src', resolved)
      element.setAttribute('loading', 'lazy')
      element.setAttribute('referrerpolicy', 'no-referrer')
    }
  }

  assignHeadingIds(template)
  for (const element of Array.from(template.content.querySelectorAll('[id]'))) {
    const id = element.getAttribute('id')
    if (id) element.setAttribute('id', `${README_ID_PREFIX}${id}`)
  }
  for (const link of Array.from(template.content.querySelectorAll('a[href^="#"]'))) {
    const href = link.getAttribute('href') ?? ''
    if (href.length <= 1) continue
    link.setAttribute('href', `#${README_ID_PREFIX}${href.slice(1)}`)
  }
  return template.innerHTML
}

export function renderGithubReadme(md: string, options: ReadmeRenderOptions, emptyHtml = ''): string {
  if (!md || !md.trim()) return emptyHtml
  let html: string
  try {
    html = renderMarkdown(md, options)
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`
  }
  return sanitizeHtml(html, options)
}

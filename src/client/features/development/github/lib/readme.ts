import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

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
]

const ALLOWED_ATTR = [
  'class', 'id', 'title', 'alt', 'href', 'target', 'rel', 'src', 'width',
  'height', 'loading', 'referrerpolicy', 'align', 'valign', 'colspan', 'rowspan', 'start',
  'type', 'value', 'open', 'dir', 'lang',
]

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base']
const FORBID_ATTR = ['style', 'srcset', 'sizes', 'formaction']
const EXTERNAL_URL = /^(?:https?:|mailto:|tel:)/i
const SAFE_CLASS = /^(?:language-[A-Za-z0-9+#._-]+|github-md-table)$/

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

function resolveUrl(rawUrl: string, options: ReadmeRenderOptions, kind: UrlKind): string | null {
  const url = rawUrl.trim()
  if (!url) return ''
  if (url.startsWith('#')) return url
  if (url.startsWith('//')) return `https:${url}`
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase()
    if (protocol === 'http' || protocol === 'https' || protocol === 'mailto' || protocol === 'tel') return url
    if (kind === 'image' && protocol === 'data' && /^data:image\//i.test(url)) return url
    return null
  }
  const boundary = url.search(/[?#]/)
  const path = boundary === -1 ? url : url.slice(0, boundary)
  const suffix = boundary === -1 ? '' : url.slice(boundary)
  const relative = normalizeRelativePath(path.replace(/^\.\//, '').replace(/^\//, ''))
  const segment = kind === 'image' ? 'raw' : 'blob'
  return `https://github.com/${options.fullName}/${segment}/${options.defaultBranch}/${relative}${suffix}`
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

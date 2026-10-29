import { NAV_LIMITS, isSafeIconValue, newNavId, normalizeLinkUrl, type NavCategory, type NavImportCategory, type NavImportLink, type NavLink } from './model'

declare const DOMParser: new () => { parseFromString(text: string, type: string): BookmarkDocument }

interface BookmarkNode {
  tagName: string
  textContent: string | null
  children: ArrayLike<BookmarkNode>
  querySelector(selector: string): BookmarkNode | null
  getAttribute(name: string): string | null
}

interface BookmarkDocument {
  querySelector(selector: string): BookmarkNode | null
}

const ROOT_LABELS = new Set([
  'Bookmarks Bar',
  'Bookmarks bar',
  'Bookmarks Toolbar',
  'Other Bookmarks',
  'Other bookmarks',
  'Favorites Bar',
  'Favorites bar',
  '\u4e66\u7b7e\u680f',
  '\u5176\u4ed6\u4e66\u7b7e',
  '\u6536\u85cf\u5939',
])

export interface BookmarkParseResult {
  categories: NavImportCategory[]
  links: NavImportLink[]
  skipped: number
}

interface ParseOptions {
  now?: number
  newId?: () => string
  uncategorizedName?: string
}

/** Read a Netscape bookmark file without executing or trusting any of its content. */
export function parseBookmarkHtml(text: string, options: ParseOptions = {}): BookmarkParseResult {
  const now = options.now ?? Date.now()
  const nextId = options.newId ?? newNavId
  const uncategorizedName = options.uncategorizedName ?? 'Uncategorized'
  const doc = new DOMParser().parseFromString(text, 'text/html') as BookmarkDocument
  const categories: NavImportCategory[] = []
  const links: NavImportLink[] = []
  const byName = new Map<string, string>()
  let skipped = 0
  let sortOrder = 0

  const categoryFor = (name: string, parentId: string | null): string | null => {
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!clean) return null
    const key = `${parentId ?? ''}:${clean.toLowerCase()}`
    const exists = byName.get(key)
    if (exists) return exists
    if (categories.length >= 1000) return null
    const category: NavImportCategory = {
      id: nextId(),
      name: clean.slice(0, NAV_LIMITS.categoryName),
      icon: 'folder',
      parentId,
      sortOrder: categories.filter((item) => item.parentId === parentId).length,
      createdAt: now,
    }
    categories.push(category)
    byName.set(key, category.id)
    return category.id
  }

  const visitList = (dl: BookmarkNode, parentId: string | null, depth: number): void => {
    for (const dt of Array.from(dl.children)) {
      if (dt.tagName.toUpperCase() !== 'DT') continue
      const heading = dt.querySelector(':scope > h3')
      const anchor = dt.querySelector(':scope > a')
      const childDl = dt.querySelector(':scope > dl')
      if (heading && childDl) {
        const label = (heading.textContent ?? '').trim()
        if (ROOT_LABELS.has(label) && depth === 0) {
          visitList(childDl, null, 0)
          continue
        }
        if (depth >= 2) {
          visitList(childDl, parentId, depth)
          continue
        }
        const id = categoryFor(label, parentId)
        if (id) visitList(childDl, id, depth + 1)
        continue
      }
      if (!anchor) continue
      const url = normalizeLinkUrl(anchor.getAttribute('href') ?? '')
      if (!url) {
        skipped += 1
        continue
      }
      const title = (anchor.textContent ?? '').trim() || url
      const rawIcon = anchor.getAttribute('icon')
      const icon = rawIcon && isSafeIconValue(rawIcon) ? rawIcon : null
      const categoryId = parentId ?? categoryFor(uncategorizedName, null)
      if (!categoryId) {
        skipped += 1
        continue
      }
      if (links.length >= NAV_LIMITS.importMaxLinks) {
        skipped += 1
        continue
      }
      links.push({
        id: nextId(),
        title: title.slice(0, NAV_LIMITS.title),
        url,
        icon,
        description: null,
        categoryId,
        pinned: false,
        pinnedOrder: 0,
        sortOrder: sortOrder++,
        createdAt: now,
      })
    }
  }

  const root = doc.querySelector('dl')
  if (root) visitList(root, null, 0)
  return { categories, links, skipped }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function absoluteIcon(icon: string | null, origin: string): string | null {
  if (!icon) return null
  if (/^https?:\/\//i.test(icon)) return icon
  if (icon.startsWith('/') && origin) return `${origin.replace(/\/$/, '')}${icon}`
  return null
}

export interface BookmarkExportOptions {
  origin?: string
  uncategorizedName?: string
}

/** Chrome, Edge and Firefox all import this shape; nesting is preserved. */
export function exportBookmarkHtml(
  links: readonly NavLink[],
  categories: readonly NavCategory[],
  options: BookmarkExportOptions = {},
): string {
  const now = Math.floor(Date.now() / 1000)
  const origin = options.origin ?? ''
  const uncategorizedName = options.uncategorizedName ?? 'Uncategorized'
  const roots = categories.filter((category) => !category.parentId)
  const childrenOf = (id: string): NavCategory[] => categories.filter((category) => category.parentId === id)
  const byCategory = new Map<string, NavLink[]>()
  for (const link of links) {
    const list = byCategory.get(link.categoryId) ?? []
    list.push(link)
    byCategory.set(link.categoryId, list)
  }
  const anchor = (link: NavLink): string => {
    const icon = absoluteIcon(link.icon, origin)
    const iconAttribute = icon ? ` ICON="${escapeHtml(icon)}"` : ''
    return `        <DT><A HREF="${escapeHtml(link.url)}" ADD_DATE="${Math.floor(link.createdAt / 1000)}"${iconAttribute}>${escapeHtml(link.title)}</A>\n`
  }
  const writeCategory = (category: NavCategory, depth: number): string => {
    const pad = '    '.repeat(depth)
    let out = `${pad}<DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${escapeHtml(category.name)}</H3>\n${pad}<DL><p>\n`
    for (const link of byCategory.get(category.id) ?? []) out += anchor(link)
    for (const child of childrenOf(category.id)) out += writeCategory(child, depth + 1)
    return `${out}${pad}</DL><p>\n`
  }
  let body = ''
  for (const category of roots) body += writeCategory(category, 0)
  const known = new Set(categories.map((category) => category.id))
  const loose = links.filter((link) => !known.has(link.categoryId))
  if (loose.length) {
    body += `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${escapeHtml(uncategorizedName)}</H3>\n    <DL><p>\n`
    for (const link of loose) body += anchor(link)
    body += '    </DL><p>\n'
  }
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${body}</DL><p>`
}

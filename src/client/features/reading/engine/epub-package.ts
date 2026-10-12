/**
 * Reading an EPUB's package document.
 *
 * An EPUB is a ZIP holding one XML table of contents — `META-INF/container.xml` points at an OPF,
 * and the OPF names every file in the book (the manifest), the order they are read (the spine) and
 * the reader's own contents list (a nav document, or an NCX in older books). All three are parsed
 * here into plain data, because everything downstream — pagination, the contents panel, in-book
 * search, the cover — asks the same questions of the same shape.
 *
 * Paths are the fiddly part. An OPF's `href` values are relative to the OPF, URI-encoded, and may
 * carry a `#fragment` naming an element inside the chapter; the ZIP member names are whatever the
 * archiver wrote. `resolvePackagePath` is the one place that reconciles them.
 */
import type { ZipArchive } from './zip'

export interface EpubMetadata {
  title: string
  creator: string
  language: string
  identifier: string
  publisher: string
  modified: string
}

export interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string[]
}

export interface SpineItem {
  idref: string
  item: ManifestItem
  /** A spine item marked `linear="no"` is part of the book but not of the reading order. */
  linear: boolean
}

export interface EpubTocEntry {
  label: string
  /** Package path of the document, with any `#fragment` kept. */
  href: string
  level: number
}

export interface EpubPackage {
  metadata: EpubMetadata
  manifest: Map<string, ManifestItem>
  /** Every readable document, keyed by its package path, for hrefs that name a file rather than an id. */
  byPath: Map<string, ManifestItem>
  spine: SpineItem[]
  toc: EpubTocEntry[]
  direction: 'ltr' | 'rtl'
  coverHref: string | null
}

/** A document the reader knows how to lay out. Anything else in the spine is skipped, not fatal. */
export const READING_MEDIA_TYPES = ['application/xhtml+xml', 'text/html'] as const

function text(parent: Element, tag: string): string {
  for (const child of Array.from(parent.children)) {
    if (localName(child) === tag) return child.textContent?.trim() ?? ''
  }
  return ''
}

/** XML in the wild is namespace-prefixed (`dc:title`) or not; only the local name is stable. */
export function localName(element: Element): string {
  return element.localName ?? element.nodeName.replace(/^[^:]+:/, '')
}

function parseManifest(opf: Element): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>()
  const container = firstChildByLocalName(opf, 'manifest')
  if (!container) return manifest
  for (const node of Array.from(container.children)) {
    if (localName(node) !== 'item') continue
    const id = node.getAttribute('id') ?? ''
    const href = node.getAttribute('href') ?? ''
    if (!id || !href) continue
    manifest.set(id, {
      id,
      href,
      mediaType: node.getAttribute('media-type') ?? '',
      properties: (node.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
    })
  }
  return manifest
}

function firstChildByLocalName(parent: Element, tag: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (localName(child) === tag) return child
  }
  return null
}

function parseSpine(opf: Element, manifest: Map<string, ManifestItem>, opfDir: string): SpineItem[] {
  const container = firstChildByLocalName(opf, 'spine')
  if (!container) return []
  const spine: SpineItem[] = []
  for (const node of Array.from(container.children)) {
    if (localName(node) !== 'itemref') continue
    const item = manifest.get(node.getAttribute('idref') ?? '')
    if (!item) continue
    if (!READING_MEDIA_TYPES.includes(item.mediaType as (typeof READING_MEDIA_TYPES)[number])) continue
    const resolved = resolvePackagePath(opfDir, stripFragment(item.href))
    spine.push({
      idref: item.id,
      item: { ...item, href: resolved },
      linear: (node.getAttribute('linear') ?? 'yes') !== 'no',
    })
  }
  return spine
}

export function stripFragment(href: string): string {
  const at = href.indexOf('#')
  return at < 0 ? href : href.slice(0, at)
}

export function fragmentOf(href: string): string {
  const at = href.indexOf('#')
  return at < 0 ? '' : href.slice(at + 1)
}

/**
 * Join a directory inside the package with a relative reference, collapsing `.` and `..` the way a
 * URL would without ever letting a book climb out of itself.
 */
export function resolvePackagePath(baseDir: string, href: string): string {
  const path = stripFragment(href).replace(/^file:/i, '')
  if (path.startsWith('/')) return decode(path.slice(1))
  const segments = `${baseDir}/${path}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return decode(out.join('/'))
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function dirOf(packagePath: string): string {
  const at = packagePath.lastIndexOf('/')
  return at < 0 ? '' : packagePath.slice(0, at)
}

/**
 * A contents entry's target is a place in the book, not just a file: the fragment is what makes
 * `chapter.xhtml#scene` land on the scene rather than at the top of the chapter.
 */
function tocHref(baseDir: string, ref: string): string {
  const path = resolvePackagePath(baseDir, ref)
  const fragment = fragmentOf(ref)
  return fragment ? `${path}#${fragment}` : path
}

function parseNcx(xml: Document, ncxPath: string): EpubTocEntry[] {
  const navMap = firstChildByLocalName(xml.documentElement, 'navMap')
  if (!navMap) return []
  const out: EpubTocEntry[] = []
  const walk = (nodes: Element[], level: number) => {
    const points = nodes
      .filter((node) => localName(node) === 'navPoint')
      .sort((a, b) => Number(a.getAttribute('playOrder') ?? 0) - Number(b.getAttribute('playOrder') ?? 0))
    for (const point of points) {
      const label = firstChildByLocalName(point, 'navLabel')?.textContent?.trim() ?? ''
      const src = firstChildByLocalName(point, 'content')?.getAttribute('src') ?? ''
      if (label && src) {
        out.push({ label, href: tocHref(dirOf(ncxPath), src), level })
      }
      walk(Array.from(point.children), level + 1)
    }
  }
  walk(Array.from(navMap.children), 0)
  return out
}

/**
 * The EPUB 3 nav document. `epub:type` is namespace-prefixed in the source and the prefix is not
 * fixed by the spec, so the attribute is matched by local name rather than by a CSS selector.
 */
function parseNavDocument(xml: Document, navPath: string): EpubTocEntry[] {
  const navs = Array.from(xml.getElementsByTagName('nav'))
  const tocNav = navs.find((nav) => hasType(nav, 'toc'))
    ?? navs.find((nav) => nav.id === 'toc')
    ?? navs[0]
  const list = tocNav ? firstChildByLocalName(tocNav, 'ol') : null
  if (!list) return []
  const out: EpubTocEntry[] = []
  const walk = (items: Element[], level: number) => {
    for (const item of items) {
      if (localName(item) !== 'li') continue
      let anchor: Element | null = null
      for (const child of Array.from(item.children)) {
        if (localName(child) === 'a' || localName(child) === 'span') {
          anchor = child
          break
        }
      }
      const label = anchor?.textContent?.trim() ?? ''
      const href = anchor?.getAttribute('href') ?? ''
      if (label && href) out.push({ label, href: tocHref(dirOf(navPath), href), level })
      for (const child of Array.from(item.children)) {
        if (localName(child) === 'ol') walk(Array.from(child.children), level + 1)
      }
    }
  }
  walk(Array.from(list.children), 0)
  return out
}

function hasType(element: Element, wanted: string): boolean {
  for (const name of Array.from(element.getAttributeNames())) {
    if (localNameOfAttribute(name) !== 'type') continue
    if ((element.getAttribute(name) ?? '').split(/\s+/).includes(wanted)) return true
  }
  return false
}

function localNameOfAttribute(name: string): string {
  const at = name.indexOf(':')
  return at < 0 ? name : name.slice(at + 1)
}

function findCover(opf: Element, manifest: Map<string, ManifestItem>, spine: SpineItem[], opfDir: string): string | null {
  for (const node of Array.from(opf.children)) {
    if (localName(node) !== 'meta') continue
    if ((node.getAttribute('name') ?? '').toLowerCase() !== 'cover') continue
    const item = manifest.get(node.getAttribute('content') ?? '')
    if (item) return resolvePackagePath(opfDir, item.href)
  }
  for (const item of manifest.values()) {
    if (item.properties.includes('cover-image')) return resolvePackagePath(opfDir, item.href)
  }
  const guide = firstChildByLocalName(opf, 'guide')
  const coverReference = guide
    ? Array.from(guide.children).find((node) => (node.getAttribute('type') ?? '') === 'cover')
    : null
  if (coverReference?.getAttribute('href')) {
    return resolvePackagePath(opfDir, coverReference.getAttribute('href') ?? '')
  }
  const image = Array.from(manifest.values()).find((item) => (
    item.mediaType.startsWith('image/') && /cover/i.test(item.href)
  ))
  if (image) return resolvePackagePath(opfDir, image.href)
  return spine[0] ? spine[0].item.href : null
}

export class EpubFormatError extends Error {}

async function rootDocumentPath(archive: ZipArchive): Promise<string> {
  if (!archive.has('META-INF/container.xml')) {
    throw new EpubFormatError('This EPUB has no container.xml')
  }
  const xml = new DOMParser().parseFromString(await archive.readText('META-INF/container.xml'), 'application/xml')
  const rootfile = Array.from(xml.getElementsByTagName('*')).find((node) => localName(node) === 'rootfile')
  const full = rootfile?.getAttribute('full-path')
  if (!full) throw new EpubFormatError('This EPUB’s container.xml names no root document')
  return resolvePackagePath('', full)
}

/** Parse an opened archive's package documents. The archive itself is the caller's to keep or free. */
export async function parseEpubPackage(archive: ZipArchive): Promise<EpubPackage> {
  const opfPath = await rootDocumentPath(archive)
  const opfDir = dirOf(opfPath)
  const raw = await archive.readText(opfPath)
  const doc = new DOMParser().parseFromString(raw, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new EpubFormatError('This EPUB’s package document cannot be parsed')
  }
  const opf = doc.documentElement
  const metadataNode = firstChildByLocalName(opf, 'metadata')
  const metadata: EpubMetadata = {
    title: metadataNode ? text(metadataNode, 'title') : '',
    creator: metadataNode ? text(metadataNode, 'creator') : '',
    language: metadataNode ? text(metadataNode, 'language') : '',
    identifier: metadataNode ? text(metadataNode, 'identifier') : '',
    publisher: metadataNode ? text(metadataNode, 'publisher') : '',
    modified: metadataNode ? text(metadataNode, 'modified') : '',
  }
  const manifest = parseManifest(opf)
  const spine = parseSpine(opf, manifest, opfDir)
  const byPath = new Map<string, ManifestItem>()
  for (const item of manifest.values()) {
    byPath.set(resolvePackagePath(opfDir, item.href), item)
  }

  const navItem = Array.from(manifest.values()).find((item) => item.properties.includes('nav'))
  let toc: EpubTocEntry[] = []
  if (navItem) {
    const navPath = resolvePackagePath(opfDir, navItem.href)
    try {
      toc = parseNavDocument(new DOMParser().parseFromString(await archive.readText(navPath), 'text/html'), navPath)
    } catch {
      toc = []
    }
  }
  if (!toc.length) {
    const ncxItem = Array.from(manifest.values()).find((item) => item.mediaType === 'application/x-dtbncx+xml')
    if (ncxItem) {
      const ncxPath = resolvePackagePath(opfDir, ncxItem.href)
      try {
        toc = parseNcx(new DOMParser().parseFromString(await archive.readText(ncxPath), 'application/xml'), ncxPath)
      } catch {
        toc = []
      }
    }
  }

  const spineNode = firstChildByLocalName(opf, 'spine')
  const declared = (spineNode?.getAttribute('page-progression-direction') ?? '').toLowerCase()

  return {
    metadata,
    manifest,
    byPath,
    spine,
    toc,
    direction: declared === 'rtl' ? 'rtl' : 'ltr',
    coverHref: findCover(opf, manifest, spine, opfDir),
  }
}

/** The spine slot a package-path href belongs to, or -1 when the book references something unreadable. */
export function spineIndexFor(pkg: EpubPackage, href: string): number {
  const path = stripFragment(href)
  const direct = pkg.spine.findIndex((item) => item.item.href === path)
  if (direct >= 0) return direct
  const id = fragmentOf(href)
  if (!id) return -1
  // Some books put the target in the TOC as `chapter.xhtml#id` while the spine lists `c01.xhtml#id`;
  // matching the fragment against spine idrefs is the last thing that can still answer.
  return pkg.spine.findIndex((item) => item.idref === id)
}

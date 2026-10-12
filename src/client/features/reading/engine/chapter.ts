/**
 * Turning one spine item into something safe to put on the page.
 *
 * A book's XHTML is untrusted input: it can carry script, event handlers, `javascript:` targets and
 * references to files that are not in the archive. So every chapter goes through DOMPurify before it
 * reaches the DOM, and only then does this module rewrite its references — sanitising first means the
 * rewriter never has to reason about hostile markup, and the rewriting it does is the boring kind
 * (a path inside the archive becomes a blob URL the browser is allowed to load).
 *
 * Blob URLs are the only way a file inside the archive can reach an `<img>` under this app's CSP, and
 * each one leaks until it is revoked, so everything minted here is registered with a pool the caller
 * owns and tears down when the chapter goes away.
 */
import DOMPurify from 'dompurify'
import type { ZipArchive } from './zip'
import type { EpubPackage } from './epub-package'
import { scopeCss } from './css-scope'

export interface ResourcePool {
  /** A loadable URL for a package member, minted once per path. */
  urlFor(path: string): Promise<string>
  /** The URL already minted for a path, for a caller that cannot await. */
  cached(path: string): string | undefined
  revokeAll(): void
}

export interface PreparedChapter {
  /** Sanitized, reference-rewritten HTML for the chapter's body. */
  html: string
  /** The chapter's own styles, confined to the reader container and with its files resolved. */
  css: string
  /** The first heading, which is what the contents panel and the reading note both want. */
  heading: string
  /** Characters of prose the chapter holds — the weight progress is divided by. */
  textLength: number
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  css: 'text/css', otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
}

export function mediaTypeFor(pkg: EpubPackage, path: string): string {
  const declared = pkg.byPath.get(path)?.mediaType
  if (declared) return declared
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

export function createResourcePool(archive: ZipArchive, pkg: EpubPackage): ResourcePool {
  const urls = new Map<string, string>()
  return {
    async urlFor(path) {
      const existing = urls.get(path)
      if (existing) return existing
      const bytes = await archive.read(path)
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mediaTypeFor(pkg, path) }))
      urls.set(path, url)
      return url
    },
    cached: (path) => urls.get(path),
    revokeAll() {
      urls.forEach((url) => URL.revokeObjectURL(url))
      urls.clear()
    },
  }
}

/** Directory of a package path — what a relative reference inside that file resolves against. */
export function parentDir(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/** Resolve a reference written inside a package file into the archive's own path vocabulary. */
export function joinPackagePath(baseDir: string, target: string): string {
  const clean = target.split('#')[0].split('?')[0]
  const segments = `${baseDir}/${clean}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  try {
    return decodeURIComponent(out.join('/'))
  } catch {
    return out.join('/')
  }
}

const EXTERNAL = /^(https?|mailto|tel):/i
const UNSAFE = /^(javascript|data|blob|filesystem|vbscript):/i

function isExternalOrUnsafe(value: string): boolean {
  return EXTERNAL.test(value) || UNSAFE.test(value.trim())
}

/**
 * Point every in-archive reference at a blob URL.
 *
 * The rewrite is deliberately second-best-effort: an element whose file the archive does not hold
 * keeps its original relative href, which the browser then resolves against the app's own origin —
 * so a missing member has to be *cleared* rather than left alone.
 */
async function rewriteReferences(
  root: HTMLElement,
  baseDir: string,
  pool: ResourcePool,
  available: (path: string) => boolean,
): Promise<void> {
  const pending: Promise<void>[] = []
  for (const element of Array.from(root.querySelectorAll<Element>('*'))) {
    const tag = element.tagName.toLowerCase()
    for (const name of ['src', 'href', 'xlink:href', 'poster'] as const) {
      const value = element.getAttribute(name)
      if (!value || value.startsWith('#')) continue
      if (UNSAFE.test(value.trim())) {
        element.removeAttribute(name)
        continue
      }
      if (EXTERNAL.test(value)) {
        if (tag === 'a' || tag === 'area') {
          element.setAttribute('target', '_blank')
          element.setAttribute('rel', 'noopener noreferrer')
        }
        continue
      }
      const target = joinPackagePath(baseDir, value)
      if (!available(target)) {
        element.removeAttribute(name)
        continue
      }
      if (tag === 'a' || tag === 'area') {
        // Cross-chapter navigation is the reader's job: the target rides along as data so the click
        // handler can resolve it to a position without the browser ever touching the address bar.
        element.setAttribute('data-reader-href', target)
        const fragment = value.slice(value.indexOf('#') + 1)
        if (fragment) element.setAttribute('data-reader-fragment', fragment)
        element.setAttribute('href', '#')
        continue
      }
      if (tag === 'img' || tag === 'image' || tag === 'source' || tag === 'track') {
        // Media is laid out before its bytes arrive, so a placeholder keeps the box from collapsing
        // and the real URL replaces it as soon as the archive hands the member over.
        element.setAttribute(name, 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==')
        pending.push(pool.urlFor(target).then((url) => {
          element.setAttribute(name, url)
        }).catch(() => {
          element.remove()
        }))
      } else {
        element.removeAttribute(name)
      }
    }
    const srcset = element.getAttribute('srcset')
    if (srcset) {
      const candidates = srcset.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)
      const usable = candidates.map((one) => joinPackagePath(baseDir, one)).filter(available)
      if (usable.length) {
        element.setAttribute('srcset', '')
        pending.push(Promise.all(usable.map((one) => pool.urlFor(one))).then((urls) => {
          element.setAttribute('srcset', urls.join(', '))
        }).catch(() => {}))
      } else {
        element.removeAttribute('srcset')
      }
    }
  }
  await Promise.all(pending)
}

/**
 * Confine a stylesheet to the reader and hand back its files as loadable URLs.
 *
 * The scoper runs first with paths left intact (it is synchronous work over text), then every
 * reference it preserved is swapped for a blob URL — which is the part that has to wait for the
 * archive.
 */
const MAX_IMPORT_DEPTH = 3

async function prepareSheet(
  path: string,
  text: string,
  pool: ResourcePool,
  scope: string,
  load: (path: string) => Promise<string>,
  depth = 0,
): Promise<string> {
  const baseDir = parentDir(path)
  const scoped = await scopeCss(text, {
    scope,
    resolveUrl: (url) => (isExternalOrUnsafe(url) ? url : joinPackagePath(baseDir, url)),
    // A book whose sheets import each other in a ring would otherwise recurse until the stack gives
    // out, and the reader would see a spinner rather than a page.
    resolveImport: depth >= MAX_IMPORT_DEPTH ? undefined : async (target) => {
      if (isExternalOrUnsafe(target)) return null
      const imported = await load(target).catch(() => '')
      if (!imported) return null
      return prepareSheet(target, imported, pool, scope, load, depth + 1)
    },
  }, path)
  return resolveSheetUrls(scoped, pool)
}

async function resolveSheetUrls(css: string, pool: ResourcePool): Promise<string> {
  const targets = [...new Set([...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)]
    .map((match) => match[1] ?? '')
    .filter((url) => url && !isExternalOrUnsafe(url)))]
  if (!targets.length) return css
  const urls = await Promise.all(targets.map(async (target) => {
    try {
      return [target, await pool.urlFor(target)] as const
    } catch {
      return [target, ''] as const
    }
  }))
  let out = css
  for (const [target, url] of urls) {
    out = out.split(`url("${target}")`).join(`url("${url}")`)
    out = out.split(`url(${target})`).join(`url("${url}")`)
    out = out.split(`url('${target}')`).join(`url("${url}")`)
  }
  return out
}

export interface ChapterSource {
  pkg: EpubPackage
  archive: ZipArchive
  pool: ResourcePool
}

/** Read, sanitize and prepare one spine item. Null when the archive does not actually hold it. */
export async function prepareChapter(
  source: ChapterSource,
  slot: number,
  scope: string,
): Promise<PreparedChapter | null> {
  const { pkg, archive, pool } = source
  const item = pkg.spine[slot]
  if (!item) return null
  const path = item.item.href
  let raw: string
  try {
    raw = await archive.readText(path)
  } catch {
    return null
  }
  const baseDir = parentDir(path)
  const parsed = new DOMParser().parseFromString(raw, 'text/html')
  const load = (target: string) => archive.readText(target)

  const sheets: string[] = []
  const seen = new Set<string>()
  for (const link of Array.from(parsed.head?.querySelectorAll('link') ?? [])) {
    if ((link.getAttribute('rel') ?? '').toLowerCase() !== 'stylesheet') continue
    const href = link.getAttribute('href')
    if (!href || isExternalOrUnsafe(href)) continue
    const sheetPath = joinPackagePath(baseDir, href)
    if (seen.has(sheetPath)) continue
    seen.add(sheetPath)
    const text = await load(sheetPath).catch(() => '')
    sheets.push(await prepareSheet(sheetPath, text, pool, scope, load))
  }
  for (const style of Array.from(parsed.head?.querySelectorAll('style') ?? [])) {
    sheets.push(await prepareSheet(`${path}#style${sheets.length}`, style.textContent ?? '', pool, scope, load))
  }

  const html = DOMPurify.sanitize(parsed.body?.innerHTML ?? '', {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['form', 'input', 'textarea', 'button', 'select', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'style', 'script'],
    FORBID_ATTR: ['onerror', 'onload', 'formaction', 'ping'],
  })

  const host = document.createElement('div')
  host.innerHTML = html
  await rewriteReferences(host, baseDir, pool, (target) => pkg.byPath.has(target) || archive.has(target))

  const heading = host.querySelector('h1, h2, h3, h4, h5, h6')?.textContent?.trim()
    || parsed.querySelector('title')?.textContent?.trim()
    || ''
  return {
    html: host.innerHTML,
    css: sheets.join('\n'),
    heading,
    textLength: host.textContent?.length ?? 0,
  }
}

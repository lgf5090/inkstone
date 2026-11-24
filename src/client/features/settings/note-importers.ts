import { downloadZip } from 'client-zip'
import DOMPurify from 'dompurify'
import { md5 } from '@noble/hashes/legacy.js'
import { isSafeBackupPath } from '@shared/backup-format'
import { LIMITS } from '@shared/constants'
import { readZip, type UnzippedEntry } from '@shared/zip'
import type { MessageKey } from '../../lib/i18n'
import { htmlToMarkdown } from '../rss/markdown'

export type NoteImportFormat = 'original' | 'html' | 'notion' | 'enex' | 'joplin' | 'mixed'

export interface PreparedNoteImport {
  files: File[]
  format: NoteImportFormat
  warnings: MessageKey[]
}

interface ImportEntry {
  path: string
  data: Uint8Array
}

interface EnexResource {
  hash: string
  path: string
  data: Uint8Array
  mime: string
}

export async function prepareNoteImport(files: readonly File[]): Promise<PreparedNoteImport> {
  const output: File[] = []
  const formats = new Set<NoteImportFormat>()
  const warnings = new Set<MessageKey>()
  for (const file of files) {
    if (file.size > LIMITS.importUploadMaxBytes) throw new Error('The import is too large')
    const name = file.name.toLowerCase()
    if (name.endsWith('.enex')) {
      formats.add('enex')
      output.push(await importEnex(file, warnings))
    }
    else if (name.endsWith('.html') || name.endsWith('.htm')) {
      formats.add('html')
      const html = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
      const markdown = convertHtml(html, file.name)
      output.push(new File([markdown], markdownFilename(file.name), { type: 'text/markdown' }))
    }
    else if (name.endsWith('.zip')) {
      const entries = await readZip(new Uint8Array(await file.arrayBuffer()), zipLimits())
      if (entries.some((entry) => /\.html?$/i.test(entry.path)) && !entries.some((entry) => entry.path === 'manifest.json')) {
        formats.add('notion')
        output.push(await importNotion(file.name, entries, warnings))
      }
      else if (entries.some((entry) => /\.md$/i.test(entry.path))) {
        formats.add('joplin')
        output.push(file)
      }
      else {
        formats.add('original')
        output.push(file)
      }
    }
    else if (name.endsWith('.jex')) {
      formats.add('joplin')
      output.push(await importJex(file))
    }
    else {
      formats.add('original')
      output.push(file)
    }
  }
  return {
    files: output,
    format: formats.size === 1 ? [...formats][0]! : 'mixed',
    warnings: [...warnings],
  }
}

async function importNotion(name: string, entries: UnzippedEntry[], warnings: Set<MessageKey>): Promise<File> {
  const output: ImportEntry[] = []
  const used = new Set(entries.filter((entry) => !/\.html?$/i.test(entry.path)).map((entry) => entry.path.toLowerCase()))
  const assetPaths = new Set(used)
  let missingAssets = false
  for (const entry of entries) {
    if (/\.html?$/i.test(entry.path)) {
      const html = new TextDecoder().decode(entry.data)
      const markdown = convertHtml(html, entry.path, (path) => {
        if (/\.(?:avif|gif|jpe?g|png|svg|webp|pdf)$/i.test(path) && !assetPaths.has(path.toLowerCase())) missingAssets = true
      })
      const path = uniquePath(entry.path.replace(/\.html?$/i, '.md'), used)
      output.push({ path, data: new TextEncoder().encode(markdown) })
    }
    else {
      output.push({ path: entry.path, data: entry.data })
    }
  }
  if (missingAssets) warnings.add('settings.import_notion_missing_assets')
  return zipFile(name.replace(/\.zip$/i, '-imported.zip'), output)
}

async function importEnex(file: File, warnings: Set<MessageKey>): Promise<File> {
  const xml = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('The ENEX file is invalid')
  const notes = [...doc.querySelectorAll('note')]
  if (!notes.length) throw new Error('The ENEX file contains no notes')
  const resources = new Map<string, EnexResource>()
  const output: ImportEntry[] = []
  const used = new Set<string>()
  for (const resource of doc.querySelectorAll('resource')) {
    const encoded = resource.querySelector('data')?.textContent?.replace(/\s+/g, '') ?? ''
    if (!encoded) continue
    const data = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0))
    const hash = bytesToHex(md5(data))
    const mime = resource.querySelector('mime-type')?.textContent?.trim() || 'application/octet-stream'
    const filename = safeSegment(resource.querySelector('file-name')?.textContent || `resource-${hash}`)
    const path = `attachments/${hash}--${filename}`
    resources.set(hash, { hash, path, data, mime })
    output.push({ path, data })
  }

  for (const [index, note] of notes.entries()) {
    const title = note.querySelector('title')?.textContent?.trim() || `Imported note ${index + 1}`
    const notePath = uniquePath(`notes/${String(index + 1).padStart(4, '0')}-${safeSegment(title)}.md`, used)
    const content = note.querySelector('en-xhtml')?.textContent ?? ''
    const markdown = convertEnexHtml(content, notePath, resources, () => {
      warnings.add('settings.import_enex_missing_resources')
    })
    const tags = [...note.querySelectorAll('tag')].map((tag) => tag.textContent?.trim()).filter((tag): tag is string => Boolean(tag))
    const createdAt = parseEnexDate(note.querySelector('created')?.textContent)
    const updatedAt = parseEnexDate(note.querySelector('updated')?.textContent)
    const frontMatter = [
      '---',
      `title: ${JSON.stringify(title)}`,
      ...(createdAt === null ? [] : [`createdAt: ${JSON.stringify(new Date(createdAt).toISOString())}`]),
      ...(updatedAt === null ? [] : [`updatedAt: ${JSON.stringify(new Date(updatedAt).toISOString())}`]),
      ...(tags.length ? [`tags: ${JSON.stringify(tags)}`] : []),
      '---',
      '',
    ].join('\n')
    output.push({ path: notePath, data: new TextEncoder().encode(`${frontMatter}${markdown}`) })
  }
  return zipFile(file.name.replace(/\.enex$/i, '-imported.zip'), output)
}

async function importJex(file: File): Promise<File> {
  const entries = readTar(new Uint8Array(await file.arrayBuffer()))
  if (!entries.some((entry) => /\.md$/i.test(entry.path))) throw new Error('The JEX file contains no Markdown notes')
  return zipFile(file.name.replace(/\.jex$/i, '-imported.zip'), entries)
}

function convertHtml(html: string, sourcePath: string, onMissingAsset?: (path: string) => void): string {
  const base = `https://notion.invalid/${sourcePath.replace(/^\/+/, '')}`
  return htmlToMarkdown(sanitizeHtml(html), (value) => {
    try {
      const resolved = new URL(value, base)
      if (resolved.origin === 'https://notion.invalid' && !/^(?:https?:|data:|mailto:|tel:)/i.test(value)) {
        const relative = resolved.pathname.slice(1)
        if (onMissingAsset && relative) onMissingAsset(relative)
        if (value.startsWith('/')) return `${relativePath(sourcePath, relative)}${resolved.search}${resolved.hash}`
        return value.replace(/\.html?(?=($|[?#]))/i, '.md')
      }
      return resolved.toString()
    }
    catch {
      return value
    }
  })
}

function convertEnexHtml(
  html: string,
  notePath: string,
  resources: ReadonlyMap<string, EnexResource>,
  onMissing: () => void,
): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const media of [...doc.querySelectorAll('en-media')]) {
    const hash = media.getAttribute('hash') ?? ''
    const type = media.getAttribute('type') ?? 'application/octet-stream'
    const resource = resources.get(hash)
    if (!resource) {
      onMissing()
      media.remove()
      continue
    }
    const replacement = doc.createElement(type.startsWith('image/') ? 'img' : 'a')
    replacement.setAttribute(type.startsWith('image/') ? 'src' : 'href', relativePath(notePath, resource.path))
    if (type.startsWith('image/')) replacement.setAttribute('alt', resource.hash)
    media.replaceWith(replacement)
  }
  return htmlToMarkdown(sanitizeHtml(doc.body.innerHTML))
}

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

async function zipFile(name: string, entries: readonly ImportEntry[]): Promise<File> {
  if (entries.length > LIMITS.importArchiveEntriesMax) throw new Error('The import contains too many files')
  if (new Set(entries.map((entry) => entry.path.toLowerCase())).size !== entries.length) throw new Error('The import contains duplicate paths')
  const bytes = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0)
  if (bytes > LIMITS.importArchiveExpandedMaxBytes) throw new Error('The import is too large')
  const blob = await downloadZip(entries.map((entry) => ({ name: entry.path, input: entry.data }))).blob()
  if (blob.size > LIMITS.importUploadMaxBytes) throw new Error('The import is too large')
  return new File([blob], name, { type: 'application/zip' })
}

function readTar(bytes: Uint8Array): ImportEntry[] {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries: ImportEntry[] = []
  let offset = 0
  let total = 0
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) break
    const size = parseTarNumber(header, 124, 136)
    const checksum = parseTarNumber(header, 148, 156)
    let actualChecksum = 0
    for (let index = 0; index < 512; index++) actualChecksum += index >= 148 && index < 156 ? 32 : header[index]!
    if (actualChecksum !== checksum) throw new Error('The JEX archive checksum is invalid')
    const type = String.fromCharCode(header[156] ?? 0)
    const nameBytes = header.subarray(0, 100)
    const prefixBytes = header.subarray(345, 500)
    const nameEnd = nameBytes.indexOf(0)
    const prefixEnd = prefixBytes.indexOf(0)
    const name = decoder.decode(nameBytes.subarray(0, nameEnd < 0 ? nameBytes.length : nameEnd))
    const prefix = decoder.decode(prefixBytes.subarray(0, prefixEnd < 0 ? prefixBytes.length : prefixEnd))
    const path = prefix ? `${prefix}/${name}` : name
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > bytes.byteLength) throw new Error('The JEX archive is truncated')
    if ((type === '0' || type === '\0') && path) {
      if (!isSafeBackupPath(path)) throw new Error('The JEX archive contains an unsafe path')
      total += size
      if (entries.length >= LIMITS.importArchiveEntriesMax || total > LIMITS.importArchiveExpandedMaxBytes) {
        throw new Error('The JEX archive is too large')
      }
      entries.push({ path, data: bytes.slice(dataStart, dataEnd) })
    }
    else if (type !== '5') {
      throw new Error('The JEX archive contains an unsupported entry')
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function parseTarNumber(header: Uint8Array, start: number, end: number): number {
  const raw = header.subarray(start, end)
  const text = new TextDecoder().decode(raw).replace(/[\0 ]+$/, '').trim()
  if (!/^[0-7]+$/.test(text)) throw new Error(`The JEX archive header is invalid: ${JSON.stringify(text)}`)
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new Error('The JEX archive header is invalid')
  return value
}

function parseEnexDate(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim())
  if (!match) return null
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]))
  return Number.isFinite(timestamp) ? timestamp : null
}

function relativePath(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1)
  const toParts = to.split('/')
  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift()
    toParts.shift()
  }
  return [...fromParts.map(() => '..'), ...toParts].join('/')
}

function uniquePath(path: string, used: Set<string>): string {
  const safe = path.replace(/^\/+/, '')
  if (!isSafeBackupPath(safe)) throw new Error('The import contains an unsafe path')
  let candidate = safe
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    const dot = safe.lastIndexOf('.')
    candidate = dot > safe.lastIndexOf('/') ? `${safe.slice(0, dot)}-${suffix++}${safe.slice(dot)}` : `${safe}-${suffix++}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function markdownFilename(name: string): string {
  return `${safeSegment(name.replace(/\.html?$/i, ''))}.md`
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^\.+/, '').replace(/[. ]+$/, '')
  return cleaned.slice(0, 120) || 'Imported note'
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function zipLimits() {
  return {
    maxEntries: LIMITS.importArchiveEntriesMax,
    maxEntryBytes: LIMITS.importArchiveExpandedMaxBytes,
    maxTotalBytes: LIMITS.importArchiveExpandedMaxBytes,
  }
}

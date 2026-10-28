import { formatBytes, relativeTime } from '../../../../lib/time'
import { localeTag } from '../../../../lib/i18n'
import { normalizeMirrorUrl } from './mirror'
export { getLanguageColor } from './languages'

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  swift: 'Swift',
  kt: 'Kotlin',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  md: 'Markdown',
  txt: 'Text',
  dockerfile: 'Dockerfile',
  toml: 'TOML',
  ini: 'INI',
  env: 'Environment',
}

const compactFormatters = new Map<string, Intl.NumberFormat>()

function compactFormatter(): Intl.NumberFormat {
  const locale = localeTag()
  const existing = compactFormatters.get(locale)
  if (existing) return existing
  const formatter = new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
  compactFormatters.set(locale, formatter)
  return formatter
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return compactFormatter().format(value)
}

export function formatFileSize(bytes: number): string {
  return formatBytes(bytes)
}

export function formatRelativeDate(iso: string, now = Date.now()): string {
  if (!iso) return ''
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  return relativeTime(time, now)
}

export function formatDate(iso: string, now = Date.now()): string {
  return formatRelativeDate(iso, now)
}

export function inferLanguage(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_LANGUAGES[extension] ?? 'Text'
}

export function extractGistId(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^[a-f0-9]{8,64}$/i.test(trimmed)) return trimmed.toLowerCase()
  const match = /(?:^|\/)gist\.github\.com\/(?:[^/?#]+\/)?([a-f0-9]{8,64})(?=[/?#]|$)/i.exec(trimmed)
  return match?.[1]?.toLowerCase() ?? null
}

export function buildMirrorDownloadUrl(mirrorUrl: string, originalUrl: string): string {
  const mirror = normalizeMirrorUrl(mirrorUrl)
  if (!mirror) return ''
  let original: URL
  try {
    original = new URL(originalUrl.trim())
  } catch {
    return ''
  }
  if (original.protocol !== 'http:' && original.protocol !== 'https:') return ''
  if (original.username || original.password) return ''
  return `${mirror}/${original.href}`
}

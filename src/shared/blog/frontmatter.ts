import { parseFrontMatter, setFrontMatterValue, type FrontMatterValue } from '@shared/markdown-utils'

export interface BlogFrontMatter {
  isPublished: boolean
  type: 'post' | 'page' | ''
  publishedAt: string
  description: string
  slug: string
  excerpt: string
  cover: string
  category: string
  series: string
  seriesOrder: number | null
  pinned: boolean
  comments: boolean
  language: string
  license: string
  alias: string
  permalink: string
  hideHomeContent: boolean
  protected: boolean
  passwordHint: string
}

function text(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function flag(data: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true
    if (normalized === 'false' || normalized === 'no' || normalized === '0') return false
  }
  return fallback
}

function integer(data: Record<string, unknown>, key: string): number | null {
  const value = data[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}

export function readBlogFrontMatter(content: string): BlogFrontMatter {
  const parsed = parseFrontMatter(content)
  const data = parsed.data
  const license = data.blogLicense
  const rawType = text(data, 'blogType').toLowerCase()
  return {
    isPublished: flag(data, 'isPublished', false),
    type: rawType === 'page' ? 'page' : rawType === 'post' ? 'post' : '',
    publishedAt: text(data, 'blogPublishedAt'),
    description: text(data, 'blogDescription'),
    slug: text(data, 'blogSlug'),
    excerpt: text(data, 'blogExcerpt'),
    cover: text(data, 'blogCover'),
    category: text(data, 'blogCategory'),
    series: text(data, 'blogSeries'),
    seriesOrder: integer(data, 'blogSeriesOrder'),
    pinned: flag(data, 'blogPinned', false),
    comments: flag(data, 'blogComments', true),
    language: text(data, 'blogLanguage'),
    license: typeof license === 'string' ? license : license === undefined ? '' : JSON.stringify(license),
    alias: text(data, 'blogAlias'),
    permalink: text(data, 'blogPermalink'),
    hideHomeContent: flag(data, 'blogHideHomeContent', true),
    protected: flag(data, 'blogProtected', false),
    passwordHint: text(data, 'blogPasswordHint'),
  }
}

export function slugifyBlogTitle(title: string): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug || `post-${Date.now()}`
}

export function setBlogPublished(content: string, published: boolean): string {
  const next = setFrontMatterValue(content, 'isPublished', published)
  if (next !== content) return next
  if (content.startsWith('---')) return content
  return `---\nisPublished: ${published}\n---\n\n${content}`
}

export function setBlogFrontMatterValue(
  content: string,
  key: string,
  value: FrontMatterValue,
): string {
  return setFrontMatterValue(content, key, value)
}

export function blogMetaFromNote(title: string, content: string): BlogFrontMatter & {
  title: string
  slug: string
} {
  const meta = readBlogFrontMatter(content)
  return {
    ...meta,
    title,
    slug: meta.slug || slugifyBlogTitle(title || 'Untitled'),
  }
}

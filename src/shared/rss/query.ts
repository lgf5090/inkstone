import type { RssEntry } from './model'

export type RssSearchField = 'any' | 'title' | 'summary' | 'content' | 'author'
export type RssSearchMark = 'unread' | 'starred' | 'later'

export interface RssSearchQuery {
  text: string
  field: RssSearchField
  author: string
  after: string
  before: string
  mark: RssSearchMark | null
  error: 'syntax' | 'date' | null
}

export interface RssSearchMarks {
  read: ReadonlySet<string>
  starred: ReadonlySet<string>
  later: ReadonlySet<string>
}

const TOKEN = /\b(title|summary|body|author|after|before|is):("(?:[^"\\]|\\.)*"|\S+)/gi
const DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

function unquote(value: string): string {
  if (!value.startsWith('"')) return value
  return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

export function parseRssSearchQuery(source: string): RssSearchQuery {
  const query: RssSearchQuery = { text: '', field: 'any', author: '', after: '', before: '', mark: null, error: null }
  let rest = source
  for (const match of [...source.matchAll(TOKEN)]) {
    const key = match[1]!.toLowerCase()
    const value = unquote(match[2]!)
    if (!value) {
      query.error = 'syntax'
      continue
    }
    if (key === 'after' || key === 'before') {
      if (!validDate(value)) query.error = 'date'
      else query[key] = value
    }
    else if (key === 'is') {
      if (value === 'unread' || value === 'starred' || value === 'later') query.mark = value
      else query.error = 'syntax'
    }
    else if (key === 'author') query.author = value.slice(0, 120)
    else query.field = key === 'body' ? 'content' : key as RssSearchField
    rest = rest.replace(match[0], ' ')
  }
  query.text = rest.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (/\b(?:title|summary|body|author|after|before|is):\s*$/i.test(rest)) query.error = 'syntax'
  if (query.after && query.before && query.after > query.before) query.error = 'date'
  return query
}

export function rssEntryMatchesAdvancedQuery(entry: RssEntry, query: RssSearchQuery, marks?: RssSearchMarks): boolean {
  if (query.error) return false
  if (query.author && !entry.author.toLowerCase().includes(query.author.toLowerCase())) return false
  if (query.after || query.before) {
    if (entry.publishedTs === null) return false
    const day = new Date(entry.publishedTs).toISOString().slice(0, 10)
    if (query.after && day < query.after) return false
    if (query.before && day > query.before) return false
  }
  if (query.mark && marks) {
    if (query.mark === 'unread' && marks.read.has(entry.id)) return false
    if (query.mark === 'starred' && !marks.starred.has(entry.id)) return false
    if (query.mark === 'later' && !marks.later.has(entry.id)) return false
  }
  if (query.field !== 'any') {
    const subject = query.field === 'title' ? entry.title
      : query.field === 'summary' ? entry.summary
        : query.field === 'author' ? entry.author
          : entry.content
    if (!subject) return false
    if (query.text && !subject.toLowerCase().includes(query.text.toLowerCase())) return false
  }
  return true
}

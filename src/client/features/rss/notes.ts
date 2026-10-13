/**
 * The reader's two ways of keeping an article: a note of its own, or a line in today's note.
 *
 * Both go through the notebook's own store rather than an API call of their own, because a note the
 * RSS app wrote has to behave like one the reader typed — it appears in the list at once, it joins
 * the sync queue, and it survives a reload. That is also why appending re-reads the note through
 * `editRemoteContent`: today's note is the one file two surfaces are likely to be editing at the
 * same time, and a blind write would drop whichever change came second.
 *
 * A saved article carries its address in front matter, so the note can be traced back to the feed
 * it came from, and so saving the same article twice updates the note it already made rather than
 * starting a second copy.
 */
import { LIMITS } from '@shared/constants'
import type { RssEntry, RssFeed, RssLibrary } from '@shared/rss/model'
import { findNoteByTitle, useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { navigateToPath } from '../../lib/app-history'
import { appTab } from '../shell/app-tabs'
import { dateKey } from '../../lib/time'
import { t } from '../../lib/i18n'
import { htmlToMarkdown } from './markdown'
import { useRss } from './store'

export type AppendOutcome = 'added' | 'already' | 'missing' | 'off'

/** `YYYY`, `MM` and `DD` are the only tokens: enough to spell a date the reader's way. */
export function dailyNoteTitle(pattern: string, now = new Date()): string {
  const key = dateKey(now)
  const [year, month, day] = key.split('-')
  return pattern
    .replace(/YYYY/g, year ?? '')
    .replace(/MM/g, month ?? '')
    .replace(/DD/g, day ?? '')
    .trim()
    .slice(0, LIMITS.titleMaxLength)
}

/** A top-level folder by name, made if it is not there. Empty name means "wherever I am". */
export function articleFolderId(name: string): string | null {
  const wanted = name.trim()
  if (!wanted) return null
  const notes = useNotes.getState()
  const existing = notes.folders.find(folder => !folder.parentId && folder.name === wanted)
  if (existing) return existing.id
  return notes.createFolder({ name: wanted })
}

export function articleFrontMatter(entry: RssEntry, feed: RssFeed | undefined): string {
  const published = entry.publishedTs ? dateKey(new Date(entry.publishedTs)) : ''
  const lines = [
    '---',
    `type: article`,
    `url: ${yaml(entry.link)}`,
    `feed: ${yaml(feed?.title ?? '')}`,
    published ? `published: ${published}` : '',
    `saved: ${dateKey(new Date())}`,
    entry.author ? `author: ${yaml(entry.author)}` : '',
    'tags:',
    '  - reading',
    '---',
  ]
  return lines.filter(Boolean).join('\n')
}

function yaml(value: string): string {
  const clean = (value || '').replace(/[\r\n]+/g, ' ').trim()
  return /[:#"'\[\]{},&*!|>%@`]|^\s|\s$/.test(clean) ? JSON.stringify(clean) : clean || '""'
}

/** The note body: who wrote it and when, the link back, then the article as Markdown. */
export function articleNoteBody(entry: RssEntry, feed: RssFeed | undefined, excerpt?: string): string {
  const published = entry.publishedTs ? dateKey(new Date(entry.publishedTs)) : ''
  const parts = [
    articleFrontMatter(entry, feed),
    '',
    [feed?.title, published, entry.author].filter(Boolean).join(' · '),
    '',
    entry.link ? `[${t('rss.open_original')}](${entry.link})` : '',
    '',
    htmlToMarkdown(entry.content, rewriteForNote),
  ]
  if (excerpt?.trim()) {
    parts.push('', '---', '', ...excerpt.trim().split('\n').map(line => `> ${line}`))
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * A note keeps the address the author wrote.
 *
 * A relayed one would only work while this deployment is standing and while the reader's session
 * lasts, and a note is supposed to outlive both.
 */
function rewriteForNote(url: string): string {
  const marker = '/api/rss/relay?url='
  const at = url.indexOf(marker)
  if (!url.startsWith('/') || at < 0) return url
  try {
    return decodeURIComponent(url.slice(at + marker.length))
  }
  catch {
    return url
  }
}

export interface SaveResult {
  ok: boolean
  noteId?: string
  title?: string
  error?: string
}

/**
 * Save (or re-save) an article as its own note.
 *
 * The second save of the same article goes back to the note the first one made — found through the
 * account library's own record — and rewrites it, because "Save as note" pressed twice is a reader
 * refreshing an article, not a reader asking for a duplicate.
 *
 * `folderId` says where the note should live instead of the setting, and moves a note that already
 * exists when it is in the wrong place; `fresh` deliberately starts a second note for the same
 * article, remembered under its own key so the article's first note is still the one a plain save
 * returns to.
 */
export async function saveArticleAsNote(
  entry: RssEntry,
  feed: RssFeed | undefined,
  excerpt?: string,
  options?: { folderId?: string | null, fresh?: boolean },
): Promise<SaveResult> {
  const title = (entry.title || t('rss.untitled')).slice(0, LIMITS.titleMaxLength)
  const content = articleNoteBody(entry, feed, excerpt)
  const notes = useNotes.getState()
  const key = `${entry.id}|${options?.fresh ? 'copy' : 'note'}`
  const remembered = entry.id ? useRss.getState().library.savedNotes[key] : ''
  const existing = remembered ? notes.notes[remembered] : undefined
  const wanted = options?.folderId
  if (existing && !existing.deletedAt) {
    const outcome = await notes.editRemoteContent(existing.id, current => (current === content ? current : content))
    if (outcome !== 'written') return { ok: false, error: t('rss.save_failed') }
    if (wanted !== undefined && wanted !== existing.folderId) await notes.patchNote(existing.id, { folderId: wanted })
    return { ok: true, noteId: existing.id, title: existing.title }
  }
  const folderId = wanted !== undefined ? wanted : articleFolderId(useSession.getState().settings.rss.articleFolder)
  const noteId = await notes.createNote({ title, content, folderId, open: true })
  if (!noteId) return { ok: false, error: t('rss.save_failed') }
  useRss.getState().rememberSavedNote(entry.id, options?.fresh ? 'copy' : 'note', noteId)
  return { ok: true, noteId, title }
}

/** The note this article was saved into, or '' when it never was. */
export function savedNoteId(library: RssLibrary, entryId: string): string {
  return entryId ? library.savedNotes[`${entryId}|note`] ?? '' : ''
}

/**
 * Take the reader to the note an article became.
 *
 * The notebook is a different container, so this is an address change plus the store's own open —
 * the same call the sidebar makes, which is what keeps the note's pane, revision and scroll handled
 * in one place. A note the reader deleted from the trash since then is said out loud rather than
 * opening a blank page.
 */
export function openSavedNote(noteId: string): void {
  const notes = useNotes.getState()
  const summary = notes.notes[noteId]
  if (!summary || summary.deletedAt) {
    useUi.getState().toast({ title: t('rss.saved_note_gone'), tone: 'warning' })
    return
  }
  navigateToPath(appTab('notes').path)
  void notes.openNote(noteId)
}

/** One line of today's note: the article's title as a link, then who wrote it and when. */
export function dailyLine(entry: RssEntry, feed: RssFeed | undefined): string {
  const title = (entry.title || t('rss.untitled')).replace(/[[\]]/g, '')
  const meta = [feed?.title, entry.publishedTs ? dateKey(new Date(entry.publishedTs)) : ''].filter(Boolean).join(' · ')
  return `- [${title}](${entry.link})${meta ? ` — ${meta}` : ''}`
}

/**
 * Add an article, and optionally an excerpt of it, to today's note.
 *
 * The link is the identity: a reader who taps the button twice, or who adds the same article from
 * two channels, gets one line. An excerpt added afterwards is put *under* the line that is already
 * there — dropping it because the article was already listed would lose the one thing the reader
 * just chose, and today's note is exactly where a marked passage belongs.
 */
export async function appendToDailyNote(entry: RssEntry, feed: RssFeed | undefined, excerpt?: string): Promise<AppendOutcome> {
  const pattern = useSession.getState().settings.rss.dailyNoteTitle
  if (!pattern.trim()) return 'off'
  const title = dailyNoteTitle(pattern)
  const line = dailyLine(entry, feed)
  const quoted = excerpt?.trim()
    ? excerpt.trim().split('\n').map(text => `  > ${text}`).join('\n')
    : ''
  const block = quoted ? `${line}\n${quoted}` : line
  const existing = findNoteByTitle(title)
  if (!existing) {
    const noteId = await useNotes.getState().createNote({ title, content: `# ${title}\n\n${block}\n`, open: false })
    return noteId ? 'added' : 'missing'
  }
  const outcome = await useNotes.getState().editRemoteContent(existing.id, (current) => {
    const at = current.split('\n').findIndex(row => entry.link && row.includes(entry.link))
    if (at < 0) return `${current.replace(/\s+$/, '')}\n${block}\n`
    if (!quoted) return null
    const lines = current.split('\n')
    let cursor = at + 1
    while (cursor < lines.length && /^\s+>/.test(lines[cursor])) cursor++
    if (lines.slice(at + 1, cursor).join('\n') === quoted) return null
    lines.splice(cursor, 0, quoted)
    return lines.join('\n')
  })
  return outcome === 'written' ? 'added' : outcome === 'conflict' ? 'already' : 'missing'
}

/** Free text a reader selected in the article, appended under a heading of its own. */
export async function excerptToNote(text: string): Promise<AppendOutcome> {
  const pattern = useSession.getState().settings.rss.dailyNoteTitle
  if (!pattern.trim()) return 'off'
  const title = dailyNoteTitle(pattern)
  const body = text.trim()
  if (!body) return 'off'
  const existing = findNoteByTitle(title)
  if (!existing) {
    const noteId = await useNotes.getState().createNote({ title, content: `# ${title}\n\n${body}\n`, open: false })
    return noteId ? 'added' : 'missing'
  }
  const outcome = await useNotes.getState().editRemoteContent(existing.id, current => `${current.replace(/\s+$/, '')}\n\n${body}\n`)
  return outcome === 'written' ? 'added' : outcome === 'conflict' ? 'already' : 'missing'
}

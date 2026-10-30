import { blogMetaFromNote, slugifyBlogTitle } from '@shared/blog/frontmatter'
import { parseFrontMatter } from '@shared/markdown-utils'
import type { BlogPageItem } from '@shared/blog/model'
import { newId } from '../lib/id'

interface PageRow {
  id: string
  slug: string
  title: string
  kind: string
  body: string
  note_id: string | null
  published_at: number | null
  updated_at: number
}

function rowToPage(row: PageRow): BlogPageItem {
  return {
    id: row.id, slug: row.slug, title: row.title, kind: row.kind, body: row.body,
    noteId: row.note_id, publishedAt: row.published_at, updatedAt: row.updated_at,
  }
}

async function uniqueSlug(db: D1Database, userId: string, requested: string, exceptId: string | null): Promise<string> {
  const base = slugifyBlogTitle(requested || 'page')
  for (let index = 1; index <= 100; index++) {
    const slug = index === 1 ? base : `${base}-${index}`
    const row = await db.prepare(`SELECT id FROM blog_pages WHERE user_id = ?1 AND slug = ?2`).bind(userId, slug).first<{ id: string }>()
    if (!row || row.id === exceptId) return slug
  }
  return `${base}-${Date.now()}`
}

const PAGE_COLUMNS = 'id, slug, title, kind, body, note_id, published_at, updated_at'

export async function listPages(db: D1Database, userId: string): Promise<BlogPageItem[]> {
  const { results } = await db.prepare(
    `SELECT ${PAGE_COLUMNS} FROM blog_pages WHERE user_id = ?1 ORDER BY updated_at DESC, id DESC`,
  ).bind(userId).all<PageRow>()
  return results.map(rowToPage)
}

export async function getPage(db: D1Database, userId: string, id: string): Promise<BlogPageItem | null> {
  const row = await db.prepare(
    `SELECT ${PAGE_COLUMNS} FROM blog_pages WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<PageRow>()
  return row ? rowToPage(row) : null
}

export async function getPageByNote(db: D1Database, userId: string, noteId: string): Promise<BlogPageItem | null> {
  const row = await db.prepare(
    `SELECT ${PAGE_COLUMNS} FROM blog_pages WHERE user_id = ?1 AND note_id = ?2`,
  ).bind(userId, noteId).first<PageRow>()
  return row ? rowToPage(row) : null
}

export async function getPublishedPage(db: D1Database, userId: string, slug: string): Promise<BlogPageItem | null> {
  const row = await db.prepare(
    `SELECT ${PAGE_COLUMNS} FROM blog_pages
     WHERE user_id = ?1 AND slug = ?2 AND published_at IS NOT NULL AND published_at <= ?3`,
  ).bind(userId, slug, Date.now()).first<PageRow>()
  return row ? rowToPage(row) : null
}

export interface PageInput {
  title: string
  slug?: string
  kind?: string
  body: string
  publish: boolean
}

export async function savePage(
  db: D1Database,
  userId: string,
  id: string | null,
  input: PageInput,
  now = Date.now(),
): Promise<BlogPageItem> {
  const title = input.title.trim().slice(0, 200)
  if (!title) throw new Error('page_title_required')
  const body = input.body.slice(0, 500_000)
  const kind = input.kind === 'about' ? 'about' : 'custom'
  if (id) {
    const existing = await getPage(db, userId, id)
    if (!existing) throw new Error('page_missing')
    const slug = await uniqueSlug(db, userId, input.slug?.trim() || title, id)
    await db.prepare(
      `UPDATE blog_pages SET slug=?3,title=?4,kind=?5,body=?6,published_at=?7,updated_at=?8
       WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id, slug, title, kind, body, input.publish ? (existing.publishedAt ?? now) : null, now).run()
    return { ...existing, slug, title, kind, body, publishedAt: input.publish ? (existing.publishedAt ?? now) : null, updatedAt: now }
  }
  const pageId = newId()
  const slug = await uniqueSlug(db, userId, input.slug?.trim() || title, null)
  await db.prepare(
    `INSERT INTO blog_pages (id,user_id,slug,title,kind,body,note_id,published_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8)`,
  ).bind(pageId, userId, slug, title, kind, body, input.publish ? now : null, now).run()
  return { id: pageId, slug, title, kind, body, noteId: null, publishedAt: input.publish ? now : null, updatedAt: now }
}

export async function savePageNote(
  db: D1Database,
  userId: string,
  pageId: string,
  noteId: string | null,
  now = Date.now(),
): Promise<BlogPageItem> {
  const page = await getPage(db, userId, pageId)
  if (!page) throw new Error('page_missing')
  if (noteId) {
    const note = await db.prepare(`SELECT id FROM notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`)
      .bind(userId, noteId).first<{ id: string }>()
    if (!note) throw new Error('blog_note_missing')
  }
  await db.prepare(`UPDATE blog_pages SET note_id = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, pageId, noteId, now).run()
  const updated = await getPage(db, userId, pageId)
  if (!updated) throw new Error('page_missing')
  return updated
}

export async function setPagePublished(
  db: D1Database,
  userId: string,
  pageId: string,
  published: boolean,
  now = Date.now(),
): Promise<BlogPageItem> {
  const page = await getPage(db, userId, pageId)
  if (!page) throw new Error('page_missing')
  await db.prepare(`UPDATE blog_pages SET published_at = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, pageId, published ? (page.publishedAt ?? now) : null, now).run()
  const updated = await getPage(db, userId, pageId)
  if (!updated) throw new Error('page_missing')
  return updated
}

export async function deletePage(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare(`DELETE FROM blog_pages WHERE user_id = ?1 AND id = ?2`).bind(userId, id).run()
}

export async function syncBlogPageFromNote(
  db: D1Database,
  userId: string,
  note: { id: string; title: string; content: string; deleted_at: number | null },
  now = Date.now(),
): Promise<BlogPageItem | null> {
  const meta = blogMetaFromNote(note.title, note.content)
  const existing = await getPageByNote(db, userId, note.id)
  if (meta.type !== 'page') {
    if (existing && existing.publishedAt !== null) {
      await db.prepare(`UPDATE blog_pages SET published_at = NULL, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
        .bind(userId, existing.id, now).run()
    }
    return null
  }
  if (note.deleted_at !== null) {
    if (!existing) return null
    if (existing.publishedAt !== null) {
      await db.prepare(`UPDATE blog_pages SET published_at = NULL, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
        .bind(userId, existing.id, now).run()
    }
    return existing
  }
  const parsed = parseFrontMatter(note.content)
  const body = parsed.lineOffset ? note.content.slice(parsed.lineOffset) : note.content
  const title = note.title.trim().slice(0, 200) || meta.slug || 'Page'
  const slug = existing?.slug ?? await uniqueSlug(db, userId, meta.slug || title, null)
  const kind = meta.slug === 'about' ? 'about' : 'custom'
  const scheduledAt = meta.publishedAt ? Date.parse(meta.publishedAt) : NaN
  const publishedAt = meta.isPublished
    ? (Number.isFinite(scheduledAt) ? scheduledAt : existing?.publishedAt ?? now)
    : null
  if (existing) {
    await db.prepare(
      `UPDATE blog_pages SET slug=?3,title=?4,kind=?5,body=?6,published_at=?7,updated_at=?8
       WHERE user_id=?1 AND id=?2`,
    ).bind(userId, existing.id, slug, title, kind, body, publishedAt, now).run()
  } else {
    await db.prepare(
      `INSERT INTO blog_pages (id,user_id,slug,title,kind,body,note_id,published_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(newId(), userId, slug, title, kind, body, note.id, publishedAt, now).run()
  }
  return getPageByNote(db, userId, note.id)
}

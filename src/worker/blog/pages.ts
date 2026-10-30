import { slugifyBlogTitle } from '@shared/blog/frontmatter'
import type { BlogPageItem } from '@shared/blog/model'
import { newId } from '../lib/id'

function rowToPage(row: {
  id: string
  slug: string
  title: string
  kind: string
  body: string
  published_at: number | null
  updated_at: number
}): BlogPageItem {
  return {
    id: row.id, slug: row.slug, title: row.title, kind: row.kind, body: row.body,
    publishedAt: row.published_at, updatedAt: row.updated_at,
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

export async function listPages(db: D1Database, userId: string): Promise<BlogPageItem[]> {
  const { results } = await db.prepare(
    `SELECT id, slug, title, kind, body, published_at, updated_at FROM blog_pages
     WHERE user_id = ?1 ORDER BY updated_at DESC, id DESC`,
  ).bind(userId).all<{
    id: string; slug: string; title: string; kind: string; body: string;
    published_at: number | null; updated_at: number;
  }>()
  return results.map(rowToPage)
}

export async function getPage(db: D1Database, userId: string, id: string): Promise<BlogPageItem | null> {
  const row = await db.prepare(
    `SELECT id, slug, title, kind, body, published_at, updated_at FROM blog_pages WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<{
    id: string; slug: string; title: string; kind: string; body: string;
    published_at: number | null; updated_at: number;
  }>()
  return row ? rowToPage(row) : null
}

export async function getPublishedPage(db: D1Database, userId: string, slug: string): Promise<BlogPageItem | null> {
  const row = await db.prepare(
    `SELECT id, slug, title, kind, body, published_at, updated_at FROM blog_pages
     WHERE user_id = ?1 AND slug = ?2 AND published_at IS NOT NULL`,
  ).bind(userId, slug).first<{
    id: string; slug: string; title: string; kind: string; body: string;
    published_at: number | null; updated_at: number;
  }>()
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
  return { id: pageId, slug, title, kind, body, publishedAt: input.publish ? now : null, updatedAt: now }
}

export async function deletePage(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare(`DELETE FROM blog_pages WHERE user_id = ?1 AND id = ?2`).bind(userId, id).run()
}

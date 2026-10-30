import { slugifyBlogTitle } from '@shared/blog/frontmatter'
import { TAXONOMY_KINDS, type TaxonomyItem, type TaxonomyKind } from '@shared/blog/model'
import { newId } from '../lib/id'

function kindOf(value: unknown): TaxonomyKind {
  if (typeof value === 'string' && (TAXONOMY_KINDS as readonly string[]).includes(value)) {
    return value as TaxonomyKind
  }
  throw new Error('taxonomy_kind_invalid')
}

function slugFor(value: string): string {
  return slugifyBlogTitle(value).replace(/^post-\d+$/, '') || `item-${Date.now()}`
}

async function uniqueSlug(
  db: D1Database,
  userId: string,
  kind: TaxonomyKind,
  requested: string,
  exceptId: string | null,
): Promise<string> {
  const table = `blog_${kind}`
  const base = slugFor(requested)
  for (let index = 1; index <= 100; index++) {
    const slug = index === 1 ? base : `${base}-${index}`
    const row = await db
      .prepare(`SELECT id FROM ${table} WHERE user_id = ?1 AND slug = ?2`)
      .bind(userId, slug)
      .first<{ id: string }>()
    if (!row || row.id === exceptId) return slug
  }
  return `${base}-${Date.now()}`
}

export async function listTaxonomy(db: D1Database, userId: string): Promise<{
  categories: TaxonomyItem[]
  tags: TaxonomyItem[]
  series: TaxonomyItem[]
}> {
  const [categories, tags, series] = await Promise.all([
    db.prepare(
      `SELECT c.id, c.name, c.slug, c.description, c.position,
              (SELECT COUNT(*) FROM blog_posts p WHERE p.user_id = c.user_id AND p.category_id = c.id AND p.status = 'published' AND p.deleted_at IS NULL) AS count
       FROM blog_categories c WHERE c.user_id = ?1 ORDER BY c.position, c.name`,
    ).bind(userId).all<{ id: string; name: string; slug: string; description: string; position: number; count: number }>(),
    db.prepare(
      `SELECT t.id, t.name, t.slug, t.color, t.position,
              (SELECT COUNT(*) FROM blog_post_tags pt JOIN blog_posts p ON p.id = pt.post_id AND p.user_id = pt.user_id
               WHERE pt.user_id = t.user_id AND pt.tag_id = t.id AND p.status = 'published' AND p.deleted_at IS NULL) AS count
       FROM blog_tags t WHERE t.user_id = ?1 ORDER BY t.position, t.name`,
    ).bind(userId).all<{ id: string; name: string; slug: string; color: string | null; position: number; count: number }>(),
    db.prepare(
      `SELECT s.id, s.title AS name, s.slug, s.description, s.status, s.position,
              (SELECT COUNT(*) FROM blog_posts p WHERE p.user_id = s.user_id AND p.series_id = s.id AND p.status = 'published' AND p.deleted_at IS NULL) AS count
       FROM blog_series s WHERE s.user_id = ?1 ORDER BY s.position, s.title`,
    ).bind(userId).all<{ id: string; name: string; slug: string; description: string; status: string; position: number; count: number }>(),
  ])
  return {
    categories: categories.results.map((row) => ({
      id: row.id, kind: 'categories' as const, name: row.name, slug: row.slug,
      description: row.description, color: null, status: 'active', count: row.count,
    })),
    tags: tags.results.map((row) => ({
      id: row.id, kind: 'tags' as const, name: row.name, slug: row.slug,
      description: '', color: row.color, status: 'active', count: row.count,
    })),
    series: series.results.map((row) => ({
      id: row.id, kind: 'series' as const, name: row.name, slug: row.slug,
      description: row.description, color: null, status: row.status, count: row.count,
    })),
  }
}

export interface TaxonomyInput {
  name: string
  slug?: string
  description?: string
  color?: string | null
  status?: string
}

export async function createTaxonomy(
  db: D1Database,
  userId: string,
  rawKind: unknown,
  input: TaxonomyInput,
  now = Date.now(),
): Promise<TaxonomyItem> {
  const kind = kindOf(rawKind)
  const name = input.name.trim()
  if (!name) throw new Error('taxonomy_name_required')
  if (name.length > 120) throw new Error('taxonomy_name_required')
  const slug = await uniqueSlug(db, userId, kind, input.slug?.trim() || name, null)
  const id = newId()
  if (kind === 'categories') {
    await db.prepare(
      `INSERT INTO blog_categories (id,user_id,name,slug,description,position,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,0,?6,?6)`,
    ).bind(id, userId, name, slug, (input.description ?? '').trim().slice(0, 500), now).run()
  } else if (kind === 'tags') {
    await db.prepare(
      `INSERT INTO blog_tags (id,user_id,name,slug,color,position,created_at)
       VALUES (?1,?2,?3,?4,?5,0,?6)`,
    ).bind(id, userId, name, slug, input.color ?? null, now).run()
  } else {
    await db.prepare(
      `INSERT INTO blog_series (id,user_id,slug,title,description,overview,status,position,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,'',?6,0,?7,?7)`,
    ).bind(id, userId, slug, name, (input.description ?? '').trim().slice(0, 500), input.status === 'completed' ? 'completed' : 'ongoing', now).run()
  }
  return { id, kind, name, slug, description: input.description ?? '', color: kind === 'tags' ? input.color ?? null : null, status: kind === 'series' ? (input.status === 'completed' ? 'completed' : 'ongoing') : 'active', count: 0 }
}

export async function updateTaxonomy(
  db: D1Database,
  userId: string,
  rawKind: unknown,
  id: string,
  input: TaxonomyInput,
  now = Date.now(),
): Promise<void> {
  const kind = kindOf(rawKind)
  const name = input.name.trim()
  if (!name) throw new Error('taxonomy_name_required')
  const slug = await uniqueSlug(db, userId, kind, input.slug?.trim() || name, id)
  if (kind === 'categories') {
    await db.prepare(
      `UPDATE blog_categories SET name=?3,slug=?4,description=?5,updated_at=?6 WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id, name, slug, (input.description ?? '').trim().slice(0, 500), now).run()
  } else if (kind === 'tags') {
    await db.prepare(
      `UPDATE blog_tags SET name=?3,slug=?4,color=?5 WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id, name, slug, input.color ?? null).run()
  } else {
    await db.prepare(
      `UPDATE blog_series SET title=?3,slug=?4,description=?5,status=?6,updated_at=?7 WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id, name, slug, (input.description ?? '').trim().slice(0, 500), input.status === 'completed' ? 'completed' : 'ongoing', now).run()
  }
}

export async function deleteTaxonomy(
  db: D1Database,
  userId: string,
  rawKind: unknown,
  id: string,
): Promise<void> {
  const kind = kindOf(rawKind)
  if (kind === 'categories') {
    const used = await db.prepare(`SELECT COUNT(*) AS total FROM blog_posts WHERE user_id=?1 AND category_id=?2 AND deleted_at IS NULL`).bind(userId, id).first<{ total: number }>()
    if ((used?.total ?? 0) > 0) throw new Error('taxonomy_in_use')
    await db.prepare(`DELETE FROM blog_categories WHERE user_id=?1 AND id=?2`).bind(userId, id).run()
  } else if (kind === 'tags') {
    await db.batch([
      db.prepare(`DELETE FROM blog_post_tags WHERE user_id=?1 AND tag_id=?2`).bind(userId, id),
      db.prepare(`DELETE FROM blog_tags WHERE user_id=?1 AND id=?2`).bind(userId, id),
    ])
  } else {
    const used = await db.prepare(`SELECT COUNT(*) AS total FROM blog_posts WHERE user_id=?1 AND series_id=?2 AND deleted_at IS NULL`).bind(userId, id).first<{ total: number }>()
    if ((used?.total ?? 0) > 0) throw new Error('taxonomy_in_use')
    await db.prepare(`DELETE FROM blog_series WHERE user_id=?1 AND id=?2`).bind(userId, id).run()
  }
}

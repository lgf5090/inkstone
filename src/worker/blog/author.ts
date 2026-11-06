import type { BlogAuthorPublic, BlogAuthorPage, BlogSitePublic } from '@shared/blog/model'
import { publicBlogSite } from '@shared/blog/settings'
import { listPostTags, listPublishedPostsFiltered, loadBlogSettings, toBlogSummary } from './store'

const EMPTY_COUNTS: BlogSitePublic['counts'] = { posts: 0, categories: 0, tags: 0, series: 0, views: 0 }

/**
 * The public author projection.
 *
 * A blog is owned by one account, so the author is that account's profile in the blog settings and
 * the article count is the same published, unencrypted set the author page lists.
 */
async function authorProfile(db: D1Database, userId: string): Promise<Omit<BlogAuthorPublic, 'articleCount'>> {
  const profile = publicBlogSite(await loadBlogSettings(db, userId), EMPTY_COUNTS).profile
  return {
    slug: profile.slug,
    name: profile.name,
    avatar: profile.avatar,
    bio: profile.bio,
    email: profile.email,
    location: profile.location,
    links: profile.links,
  }
}

export async function blogAuthorPage(
  db: D1Database,
  userId: string,
  slug: string,
  options: { page?: number; limit?: number; sort?: 'latest' | 'oldest' | 'title' } = {},
): Promise<BlogAuthorPage | null> {
  const author = await authorProfile(db, userId)
  if (author.slug !== slug) return null
  const page = Math.max(options.page ?? 1, 1)
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50)
  const { rows, total } = await listPublishedPostsFiltered(db, userId, {
    page,
    limit,
    sort: options.sort ?? 'latest',
    excludeEncrypted: true,
  })
  const tags = await listPostTags(db, userId, rows.map((row) => row.id))
  return {
    author: { ...author, articleCount: total },
    items: rows.map((row) => toBlogSummary(row, tags.get(row.id) ?? [])),
    page,
    limit,
    total,
  }
}

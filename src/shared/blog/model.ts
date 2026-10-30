/** Blog records, public projections and the render snapshot contract shared by every surface. */

export const BLOG_POST_STATUSES = ['draft', 'pending_snapshot', 'scheduled', 'published', 'withdrawn'] as const
export type BlogPostStatus = (typeof BLOG_POST_STATUSES)[number]

export const BLOG_RENDER_STATUSES = ['missing', 'ready', 'stale', 'failed'] as const
export type BlogRenderStatus = (typeof BLOG_RENDER_STATUSES)[number]

export interface BlogHeading {
  depth: number
  slug: string
  text: string
  html?: string
}

export interface BlogAssetRef {
  attachmentId?: string
  blogAssetId?: string
  url: string
}

export interface BlogWikiLink {
  target: string
  slug: string | null
}

/**
 * A published note an article embeds.
 *
 * Only published targets are captured: the runtime resolves `![[…]]` from this map exactly as the
 * note app resolves it from its store, so an article can never pull a private note into a public page
 * by embedding it. The body is the raw markdown the shared renderer turns into the same HTML.
 */
export interface BlogEmbeddedNote {
  id: string
  title: string
  content: string
}

export interface BlogReadingSettings {
  locale: string
  emojiShortcodes: boolean
  math?: boolean
  mermaid?: boolean
  chart?: boolean
  codeBlockCollapse?: boolean
  codeBlockCollapseLines?: number
  jsonView?: 'source' | 'tree' | 'map'
  jsonFold?: number
  jsonTolerant?: boolean
}

export interface BlogRenderSnapshot {
  version: 1
  rendererVersion: string
  noteId: string
  contentHash: string
  html: string
  headings: BlogHeading[]
  fences: Record<string, string[]>
  features: string[]
  assets: BlogAssetRef[]
  wikiLinks: BlogWikiLink[]
  settings: BlogReadingSettings
  embeds?: BlogEmbeddedNote[]
  generatedAt: number
  warnings: string[]
}

export const BLOG_COMMENT_STATUSES = ['pending', 'approved', 'spam', 'trash'] as const
export type BlogCommentStatus = (typeof BLOG_COMMENT_STATUSES)[number]

export interface PublicBlogComment {
  id: string
  parentId: string | null
  authorName: string
  authorUrl: string
  content: string
  createdAt: number
  replies: PublicBlogComment[]
}

export interface AdminBlogComment {
  id: string
  postId: string
  postTitle: string | null
  postSlug: string | null
  parentId: string | null
  authorName: string
  authorEmailHash: string
  authorUrl: string
  content: string
  status: BlogCommentStatus
  createdAt: number
  updatedAt: number
}

export interface BlogMediaItem {
  id: string
  kind: string
  url: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  createdAt: number
  variants: { width: number; height: number; url: string }[]
}

export const TAXONOMY_KINDS = ['categories', 'tags', 'series'] as const
export type TaxonomyKind = (typeof TAXONOMY_KINDS)[number]

export interface TaxonomyItem {
  id: string
  kind: TaxonomyKind
  name: string
  slug: string
  description: string
  color: string | null
  status: string
  count: number
}

export interface BlogPageItem {
  id: string
  slug: string
  title: string
  kind: string
  body: string
  noteId: string | null
  publishedAt: number | null
  updatedAt: number
}

export interface BlogPostRow {
  id: string
  user_id: string
  note_id: string
  slug: string
  title: string
  excerpt: string
  description: string
  cover_asset_id: string | null
  category_id: string | null
  series_id: string | null
  series_order: number | null
  status: BlogPostStatus
  pinned: number
  comments_enabled: number
  language: string
  license: string
  encrypted: number
  password_hash: string | null
  password_hint: string
  hide_home_content: number
  alias: string
  permalink: string
  word_count: number
  reading_minutes: number
  view_count: number
  content_hash: string
  render_key: string | null
  render_hash: string
  renderer_version: string
  render_status: BlogRenderStatus
  render_generated_at: number | null
  published_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface BlogPostSummary {
  id: string
  slug: string
  title: string
  excerpt: string
  description: string
  coverUrl: string | null
  category: string | null
  series: string | null
  seriesOrder: number | null
  tags: string[]
  pinned: boolean
  language: string
  publishedAt: number | null
  updatedAt: number
  wordCount: number
  readingMinutes: number
  encrypted: boolean
  hideHomeContent: boolean
}

export interface BlogPostDetail extends BlogPostSummary {
  content: string | null
  headings: BlogHeading[]
  render: BlogRenderSnapshot | null
  renderStatus: BlogRenderStatus
  commentsEnabled: boolean
  license: string
  alias: string
  permalink: string
}

export interface BlogPostAdminItem extends BlogPostSummary {
  noteId: string
  status: BlogPostStatus
  renderStatus: BlogRenderStatus
  renderHash: string
  createdAt: number
  updatedAt: number
  viewCount: number
  commentCount: number
}

export interface BlogPostAdminDetail extends BlogPostAdminItem {
  noteTitle: string
  noteUpdatedAt: number | null
  contentHash: string
  renderGeneratedAt: number | null
  rendererVersion: string
  description: string
  coverAssetId: string | null
  categoryId: string | null
  seriesId: string | null
  seriesOrder: number | null
  commentsEnabled: boolean
  language: string
  license: string
  alias: string
  permalink: string
  encrypted: boolean
  passwordHint: string
  hideHomeContent: boolean
}

export interface BlogCalendarItem {
  id: string
  noteId: string
  title: string
  slug: string
  status: BlogPostStatus
  publishedAt: number | null
  updatedAt: number
  category: string | null
}

export interface BlogRedirectItem {
  from: string
  to: string
  status: number
  createdAt: number
}

export const BLOG_COLLECTION_KINDS = [
  'moments',
  'albums',
  'friends',
  'projects',
  'skills',
  'devices',
  'games',
  'anime',
  'timeline',
  'compass',
] as const
export type BlogCollectionKind = (typeof BLOG_COLLECTION_KINDS)[number]

export interface BlogCollectionItem {
  id: string
  kind: BlogCollectionKind
  title: string
  slug: string
  status: string
  publishedAt: number | null
  updatedAt: number
  data: Record<string, unknown>
}

export interface BlogAlbumPhoto {
  id: string
  albumId: string
  assetId: string
  url: string
  caption: string
  alt: string
  takenAt: string
  position: number
}

export interface BlogWidget {
  id: string
  type: string
  title: string
  enabled: boolean
  config: Record<string, unknown>
}

export interface BlogAuditEntry {
  id: string
  action: string
  entity: string
  entityId: string
  detail: Record<string, unknown>
  createdAt: number
}

export interface BlogDashboardRecentPost {
  id: string
  noteId: string
  title: string
  status: BlogPostStatus
  updatedAt: number
}

export interface BlogDashboardRecentComment {
  id: string
  postTitle: string | null
  authorName: string
  content: string
  status: BlogCommentStatus
  createdAt: number
}

export interface BlogDashboard {
  overview: BlogAdminOverview
  recentPosts: BlogDashboardRecentPost[]
  recentComments: BlogDashboardRecentComment[]
  viewsByDay: { day: string; views: number; visitors: number }[]
  storageBytes: number
  scheduled: number
  draftCount: number
}

export interface BlogHealth {
  database: boolean
  storage: boolean
  published: number
  scheduled: number
  stale: number
  missing: number
  failed: number
  storageBytes: number
  lastPublishedAt: number | null
  checkedAt: number
}

export interface Paginated<T> {
  items: T[]
  nextCursor: string | null
  total: number | null
}

export interface BlogSitePublic {
  site: {
    title: string
    subtitle: string
    description: string
    url: string
    locale: string
    timeZone: string
    themeColor: { hue: number; style: string; spec: string }
  }
  profile: { name: string; bio: string; avatar: string; links: { label: string; url: string }[] }
  nav: { label: string; href: string; children?: { label: string; href: string }[] }[]
  sidebar: { enable: boolean; arrangement: 'single' | 'dual'; side: 'left' | 'right'; widgets: string[] }
  widgets: BlogWidget[]
  discussion: {
    enabled: boolean
    requireNameEmail: boolean
    requireApproval: boolean
    allowReplies: boolean
    maxLength: number
    autoCloseDays: number
  }
  display: Record<string, unknown>
  integrations: { comments: string; music: string; umami: string }
  counts: { posts: number; categories: number; tags: number; series: number }
}

export interface BlogAdminOverview {
  posts: number
  published: number
  drafts: number
  pending: number
  scheduled: number
  trash: number
  stale: number
  views: number
  moments: number
  albums: number
  tasks: number
  commentsPending: number
  commentsApproved: number
  commentsSpam: number
}

/** Blog records, public projections and the render snapshot contract shared by every surface. */

export const BLOG_POST_STATUSES = ['draft', 'pending_snapshot', 'published', 'withdrawn'] as const
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
  settings: { locale: string; emojiShortcodes: boolean }
  generatedAt: number
  warnings: string[]
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
  display: Record<string, unknown>
  integrations: { comments: string; music: string; umami: string }
  counts: { posts: number; categories: number; tags: number; series: number }
}

export interface BlogAdminOverview {
  posts: number
  published: number
  drafts: number
  pending: number
  stale: number
  views: number
  moments: number
  albums: number
  tasks: number
}

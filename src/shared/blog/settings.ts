import type { BlogSitePublic } from './model'

export const BLOG_SETTING_KEYS = [
  'site',
  'profile',
  'nav',
  'sidebar',
  'display',
  'article',
  'comment',
  'music',
  'umami',
  'llms',
  'permalink',
  'license',
  'footer',
  'announcement',
  'fab',
  'contextMenu',
] as const

export type BlogSettingKey = (typeof BLOG_SETTING_KEYS)[number]
export type BlogSettings = Record<BlogSettingKey, Record<string, unknown>>

export const DEFAULT_BLOG_SETTINGS: BlogSettings = {
  site: {
    url: '',
    title: 'Inkstone Blog',
    subtitle: '',
    description: '',
    locale: 'en',
    timeZone: 'UTC',
    themeColor: { hue: 315, style: 'tonalSpot', spec: '2025' },
  },
  profile: { name: '', bio: '', avatar: '', links: [] },
  nav: { links: [] },
  sidebar: {
    enable: true,
    arrangement: 'single',
    side: 'left',
    widgets: ['profile', 'categories', 'tags', 'series'],
  },
  display: {
    tocDepth: 2,
    progressStyle: 'dual',
    postListMode: 'list',
    postListPageSize: 10,
  },
  article: { showLastUpdated: true, relatedCount: 3, randomCount: 2, share: true },
  comment: { provider: 'none' },
  music: { provider: 'none' },
  umami: { enable: false, websiteId: '' },
  llms: { enable: true, excludeTags: [] },
  permalink: { enable: false },
  license: { enable: false, name: '', url: '' },
  footer: { enable: false, html: '' },
  announcement: { enable: false, text: '' },
  fab: { enable: false, items: [] },
  contextMenu: { enable: true, actions: ['copySelection', 'backToTop', 'sharePageLink'] },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function mergeBlogValue(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? mergeBlogValue(base[key], value) : value
  }
  return merged
}

export function parseBlogSettingValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function mergeBlogSettings(rows: readonly { key: string; value: string }[]): BlogSettings {
  const merged: BlogSettings = { ...DEFAULT_BLOG_SETTINGS }
  for (const row of rows) {
    if (!(BLOG_SETTING_KEYS as readonly string[]).includes(row.key)) continue
    const parsed = parseBlogSettingValue(row.value)
    if (parsed === undefined) continue
    const key = row.key as BlogSettingKey
    merged[key] = mergeBlogValue(DEFAULT_BLOG_SETTINGS[key], parsed) as Record<string, unknown>
  }
  return merged
}

export function publicBlogSite(
  settings: BlogSettings,
  counts: BlogSitePublic['counts'],
): BlogSitePublic {
  const site = settings.site as Partial<BlogSitePublic['site']> & {
    themeColor?: BlogSitePublic['site']['themeColor']
  }
  const profile = settings.profile as Partial<BlogSitePublic['profile']>
  const nav = settings.nav as { links?: BlogSitePublic['nav'] }
  const sidebar = settings.sidebar as Partial<BlogSitePublic['sidebar']>
  const comment = settings.comment as { provider?: string }
  const music = settings.music as { provider?: string }
  const umami = settings.umami as { enable?: boolean }
  return {
    site: {
      title: typeof site.title === 'string' ? site.title : 'Inkstone Blog',
      subtitle: typeof site.subtitle === 'string' ? site.subtitle : '',
      description: typeof site.description === 'string' ? site.description : '',
      url: typeof site.url === 'string' ? site.url : '',
      locale: typeof site.locale === 'string' ? site.locale : 'en',
      timeZone: typeof site.timeZone === 'string' ? site.timeZone : 'UTC',
      themeColor: site.themeColor ?? { hue: 315, style: 'tonalSpot', spec: '2025' },
    },
    profile: {
      name: typeof profile.name === 'string' ? profile.name : '',
      bio: typeof profile.bio === 'string' ? profile.bio : '',
      avatar: typeof profile.avatar === 'string' ? profile.avatar : '',
      links: Array.isArray(profile.links) ? profile.links : [],
    },
    nav: Array.isArray(nav.links) ? nav.links : [],
    sidebar: {
      enable: sidebar.enable !== false,
      arrangement: sidebar.arrangement === 'dual' ? 'dual' : 'single',
      side: sidebar.side === 'right' ? 'right' : 'left',
      widgets: Array.isArray(sidebar.widgets) ? sidebar.widgets : [],
    },
    display: settings.display,
    integrations: {
      comments: typeof comment.provider === 'string' ? comment.provider : 'none',
      music: typeof music.provider === 'string' ? music.provider : 'none',
      umami: umami.enable ? 'enabled' : 'none',
    },
    counts,
  }
}

import type { BlogMusicConfig, BlogMusicMeting, BlogMusicTrack, BlogSitePublic } from './model'
import { BLOG_RENDERER_VERSION } from './renderer'

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
  'discussion',
  'widgets',
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
  nav: {
    links: [
      { label: 'Home', href: '/' },
      { label: 'Archive', href: '/archive' },
      { label: 'Friends', href: '/friends' },
      { label: 'Moments', href: '/moments' },
      { label: 'Anime', href: '/anime' },
      { label: 'Compass', href: '/compass' },
      { label: 'Albums', href: '/albums' },
      {
        label: 'More',
        href: '/more',
        children: [
          { label: 'Timeline', href: '/timeline' },
          { label: 'Projects', href: '/projects' },
          { label: 'Devices', href: '/devices' },
          { label: 'Games', href: '/games' },
          { label: 'Skills', href: '/skills' },
          { label: 'About', href: '/about' },
        ],
      },
    ],
  },
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
  article: { showLastUpdated: true, lastUpdatedDays: 90, relatedCount: 3, randomCount: 2, share: true },
  comment: { provider: 'local' },
  music: {
    provider: 'none',
    tracks: [],
    meting: { server: 'netease', type: 'playlist', id: '', api: '' },
    defaultVolume: 0.7,
    defaultMode: 'sequence',
  },
  umami: { enable: false, websiteId: '' },
  llms: { enable: true, excludeTags: [] },
  permalink: { enable: false },
  license: { enable: false, name: '', url: '' },
  footer: { enable: true, html: '' },
  announcement: { enable: false, text: '' },
  fab: { enable: true, items: ['home', 'toc', 'comment', 'top'] },
  contextMenu: { enable: true, actions: ['copySelection', 'backToTop', 'sharePageLink'] },
  discussion: {
    enabled: true,
    requireNameEmail: true,
    requireApproval: true,
    allowReplies: true,
    maxLength: 4000,
    rateLimitPerHour: 5,
    autoCloseDays: 0,
  },
  widgets: {
    items: [
      { id: 'profile', type: 'profile', title: '', enabled: true, config: {} },
      { id: 'search', type: 'search', title: '', enabled: true, config: {} },
      { id: 'categories', type: 'categories', title: '', enabled: true, config: {} },
      { id: 'tags', type: 'tags', title: '', enabled: true, config: {} },
      { id: 'series', type: 'series', title: '', enabled: true, config: {} },
      { id: 'recent', type: 'recent', title: '', enabled: true, config: {} },
      { id: 'announcement', type: 'announcement', title: '', enabled: false, config: {} },
    ],
  },
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

function safeHref(value: unknown): string {
  if (typeof value !== 'string') return ''
  const href = value.trim()
  return href.startsWith('/') && !href.startsWith('//') ? href : /^https?:\/\//i.test(href) ? href : ''
}

function publicNavLinks(value: unknown): BlogSitePublic['nav'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const link = entry as { label?: unknown; href?: unknown; children?: unknown }
    const href = safeHref(link.href)
    if (!href) return []
    const children = Array.isArray(link.children)
      ? link.children.flatMap((child) => {
          if (!child || typeof child !== 'object') return []
          const nested = child as { label?: unknown; href?: unknown }
          const nestedHref = safeHref(nested.href)
          return nestedHref && typeof nested.label === 'string'
            ? [{ label: nested.label.slice(0, 80), href: nestedHref }]
            : []
        })
      : undefined
    return [{ label: typeof link.label === 'string' ? link.label.slice(0, 80) : '', href, ...(children && children.length ? { children } : {}) }]
  })
}

function publicProfileLinks(value: unknown): BlogSitePublic['profile']['links'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const link = entry as { label?: unknown; url?: unknown }
    const url = safeHref(link.url)
    return url ? [{ label: typeof link.label === 'string' ? link.label.slice(0, 80) : '', url }] : []
  })
}

const FAB_ITEMS = new Set(['home', 'toc', 'comment', 'top'])
const COMMENT_PROVIDERS = new Set(['none', 'local', 'twikoo', 'giscus', 'waline'])
const CONTEXT_ACTIONS = ['copySelection', 'copyLink', 'openImage', 'copyImage', 'backToTop']
const MUSIC_PROVIDERS = new Set(['none', 'local', 'meting', 'custom', 'mixed'])
const METING_SERVERS = new Set(['netease', 'tencent', 'kugou', 'xiami', 'baidu'])
const METING_TYPES = new Set(['playlist', 'song', 'album', 'artist'])
const PLAYBACK_MODES = new Set(['sequence', 'repeat-one', 'shuffle'])

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (value === undefined || value === null || !Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

function publicUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const url = value.trim()
  if (!url || url.length > 2000) return null
  if (url.startsWith('/') && !url.startsWith('//')) return url
  return /^https?:\/\//i.test(url) ? url : null
}

function publicMusic(value: unknown): BlogMusicConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const provider = typeof raw.provider === 'string' && MUSIC_PROVIDERS.has(raw.provider)
    ? raw.provider as BlogMusicConfig['provider']
    : 'none'
  const tracks: BlogMusicTrack[] = []
  if (Array.isArray(raw.tracks)) {
    for (const entry of raw.tracks.slice(0, 100)) {
      if (!entry || typeof entry !== 'object') continue
      const track = entry as Record<string, unknown>
      const id = typeof track.id === 'string' ? track.id.trim().slice(0, 120) : ''
      const title = typeof track.title === 'string' ? track.title.trim().slice(0, 200) : ''
      const source = publicUrl(track.source)
      if (!id || !title || !source) continue
      tracks.push({
        id,
        title,
        source,
        ...(typeof track.artist === 'string' && track.artist.trim() ? { artist: track.artist.trim().slice(0, 200) } : {}),
        ...(publicUrl(track.cover) ? { cover: publicUrl(track.cover)! } : {}),
        ...(typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0
          ? { duration: Math.floor(track.duration) }
          : {}),
      })
    }
  }
  const metingRaw = raw.meting && typeof raw.meting === 'object' ? raw.meting as Record<string, unknown> : {}
  const metingId = typeof metingRaw.id === 'string' ? metingRaw.id.trim().slice(0, 120) : ''
  const meting: BlogMusicMeting | undefined = metingId ? {
    server: typeof metingRaw.server === 'string' && METING_SERVERS.has(metingRaw.server)
      ? metingRaw.server as BlogMusicMeting['server']
      : 'netease',
    type: typeof metingRaw.type === 'string' && METING_TYPES.has(metingRaw.type)
      ? metingRaw.type as BlogMusicMeting['type']
      : 'playlist',
    id: metingId,
    ...(publicUrl(metingRaw.api) ? { api: publicUrl(metingRaw.api)! } : {}),
  } : undefined
  const volume = typeof raw.defaultVolume === 'number' && Number.isFinite(raw.defaultVolume)
    ? Math.min(1, Math.max(0, raw.defaultVolume))
    : 0.7
  const mode = typeof raw.defaultMode === 'string' && PLAYBACK_MODES.has(raw.defaultMode)
    ? raw.defaultMode as BlogMusicConfig['defaultMode']
    : 'sequence'
  const enabled = provider !== 'none' && (tracks.length > 0 || Boolean(meting))
  return { enabled, provider, tracks, ...(meting ? { meting } : {}), defaultVolume: volume, defaultMode: mode }
}

export function publicBlogSite(
  settings: BlogSettings,
  counts: BlogSitePublic['counts'],
): BlogSitePublic {
  const site = settings.site as Partial<BlogSitePublic['site']> & {
    themeColor?: BlogSitePublic['site']['themeColor']
    banner?: Partial<BlogSitePublic['site']['banner']>
  }
  const profile = settings.profile as Partial<BlogSitePublic['profile']>
  const nav = settings.nav as { links?: BlogSitePublic['nav'] }
  const sidebar = settings.sidebar as Partial<BlogSitePublic['sidebar']>
  const comment = settings.comment as {
    provider?: string
    envId?: unknown
    repo?: unknown
    repoId?: unknown
    category?: unknown
    categoryId?: unknown
    serverURL?: unknown
  }
  const umami = settings.umami as { enable?: boolean; websiteId?: unknown }
  const musicValue = publicMusic(settings.music)
  const discussion = settings.discussion as {
    enabled?: boolean
    requireNameEmail?: boolean
    requireApproval?: boolean
    allowReplies?: boolean
    maxLength?: number
    autoCloseDays?: number
  }
  const widgets = settings.widgets as { items?: BlogSitePublic['widgets'] }
  const article = settings.article as Partial<BlogSitePublic['article']>
  const license = settings.license as Partial<BlogSitePublic['license']>
  const footer = settings.footer as Partial<BlogSitePublic['footer']>
  const fab = settings.fab as Partial<BlogSitePublic['fab']>
  const announcement = settings.announcement as Partial<BlogSitePublic['announcement']>
  const llms = settings.llms as Partial<BlogSitePublic['llms']>
  const contextMenu = settings.contextMenu as Partial<BlogSitePublic['contextMenu']>
  const permalink = settings.permalink as Partial<BlogSitePublic['permalink']>
  const fabItems = Array.isArray(fab.items)
    ? [...new Set(fab.items.filter((item): item is string => FAB_ITEMS.has(item as string)))]
    : [...FAB_ITEMS]
  return {
    site: {
      title: typeof site.title === 'string' ? site.title : 'Inkstone Blog',
      subtitle: typeof site.subtitle === 'string' ? site.subtitle : '',
      description: typeof site.description === 'string' ? site.description : '',
      url: typeof site.url === 'string' ? site.url : '',
      locale: typeof site.locale === 'string' ? site.locale : 'en',
      timeZone: typeof site.timeZone === 'string' ? site.timeZone : 'UTC',
      themeColor: site.themeColor ?? { hue: 315, style: 'tonalSpot', spec: '2025' },
      banner: {
        desktopLight: publicUrl(site.banner?.desktopLight) ?? '',
        desktopDark: publicUrl(site.banner?.desktopDark) ?? '',
        mobileLight: publicUrl(site.banner?.mobileLight) ?? '',
        mobileDark: publicUrl(site.banner?.mobileDark) ?? '',
      },
    },
    profile: {
      name: typeof profile.name === 'string' ? profile.name : '',
      bio: typeof profile.bio === 'string' ? profile.bio : '',
      avatar: typeof profile.avatar === 'string' ? profile.avatar : '',
      links: publicProfileLinks(profile.links),
    },
    nav: publicNavLinks(nav.links),
    sidebar: {
      enable: sidebar.enable !== false,
      arrangement: sidebar.arrangement === 'dual' ? 'dual' : 'single',
      side: sidebar.side === 'right' ? 'right' : 'left',
      widgets: Array.isArray(sidebar.widgets) ? sidebar.widgets : [],
    },
    widgets: Array.isArray(widgets.items)
      ? widgets.items.filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
      : [],
    discussion: {
      enabled: discussion.enabled !== false,
      requireNameEmail: discussion.requireNameEmail !== false,
      requireApproval: discussion.requireApproval !== false,
      allowReplies: discussion.allowReplies !== false,
      maxLength: Math.min(Math.max(Number(discussion.maxLength) || 4000, 200), 10000),
      autoCloseDays: Math.max(Number(discussion.autoCloseDays) || 0, 0),
    },
    article: {
      share: article.share !== false,
      showLastUpdated: article.showLastUpdated !== false,
      lastUpdatedDays: clampInt(article.lastUpdatedDays, 90, 0, 3650),
      relatedCount: clampInt(article.relatedCount, 3, 0, 20),
      randomCount: clampInt(article.randomCount, 2, 0, 20),
    },
    license: {
      enable: license.enable === true,
      name: typeof license.name === 'string' ? license.name.trim().slice(0, 120) : '',
      url: publicUrl(license.url) ?? '',
    },
    footer: {
      enable: footer.enable !== false,
      html: typeof footer.html === 'string' ? footer.html.slice(0, 20000) : '',
    },
    fab: {
      enable: fab.enable !== false,
      items: fabItems,
    },
    announcement: {
      enable: announcement.enable === true,
      text: typeof announcement.text === 'string' ? announcement.text.trim().slice(0, 2000) : '',
      closable: announcement.closable !== false,
    },
    llms: {
      enable: llms.enable !== false,
      excludeTags: Array.isArray(llms.excludeTags)
        ? [...new Set(llms.excludeTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim().slice(0, 80)))].slice(0, 50)
        : [],
    },
    comment: {
      provider: typeof comment.provider === 'string' && COMMENT_PROVIDERS.has(comment.provider)
        ? comment.provider as BlogSitePublic['comment']['provider']
        : 'none',
      twikoo: { envId: typeof comment.envId === 'string' ? comment.envId.trim().slice(0, 160) : '' },
      giscus: {
        repo: typeof comment.repo === 'string' ? comment.repo.trim().slice(0, 160) : '',
        repoId: typeof comment.repoId === 'string' ? comment.repoId.trim().slice(0, 80) : '',
        category: typeof comment.category === 'string' ? comment.category.trim().slice(0, 80) : '',
        categoryId: typeof comment.categoryId === 'string' ? comment.categoryId.trim().slice(0, 80) : '',
      },
      waline: { serverURL: publicUrl(comment.serverURL) ?? '' },
    },
    permalink: { enable: permalink.enable === true },
    contextMenu: {
      enable: contextMenu.enable !== false,
      actions: Array.isArray(contextMenu.actions)
        ? [...new Set(contextMenu.actions.filter((action): action is string => typeof action === 'string' && CONTEXT_ACTIONS.includes(action)))]
        : CONTEXT_ACTIONS,
    },
    display: settings.display,
    integrations: {
      comments: typeof comment.provider === 'string' ? comment.provider : 'none',
      music: musicValue,
      umami: {
        enabled: umami.enable === true,
        websiteId: typeof umami.websiteId === 'string' ? umami.websiteId.slice(0, 80) : '',
      },
    },
    counts,
    runtimeVersion: BLOG_RENDERER_VERSION,
  }
}

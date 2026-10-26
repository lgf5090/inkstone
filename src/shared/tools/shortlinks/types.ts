/**
 * Shared types for Short Links manager under Tools (`tools/shortlinks`).
 */

export const MIN_SLUG_LENGTH = 3
export const MAX_SLUG_LENGTH = 128
export const DEFAULT_SLUG_LENGTH = 3

export const TIMELINE_RANGES = ['24h', '7d', '30d', '90d', '1y', 'all'] as const
export type TimelineRange = (typeof TIMELINE_RANGES)[number]
export const DEFAULT_TIMELINE_RANGE: TimelineRange = '30d'

export const PAGINATED_DIMENSIONS = ['countries', 'referrers', 'referrer_hosts'] as const
export type PaginatedDimension = (typeof PAGINATED_DIMENSIONS)[number]

export const BREAKDOWN_PAGE_SIZE = 10
export const MAX_BREAKDOWN_LIMIT = 100

export type BundleAccent = 'orange' | 'red' | 'green' | 'blue' | 'purple'

export interface ShortLinkSlug {
  id?: number
  slug: string
  link_id: number
  is_custom?: boolean
  is_primary: boolean | number
  is_active?: boolean | number
  click_count?: number
  created_at: number
  disabled_at?: number | null
}

export interface ShortLink {
  id: number
  user_id?: string | number
  url: string
  label: string | null
  password_protected?: boolean
  is_password_protected?: boolean | number
  is_active?: boolean | number
  created_at: number
  updated_at?: number
  expires_at: number | null
  created_via?: string | null
  created_by?: string
  slugs: ShortLinkSlug[]
  total_clicks: number
  clicks?: number
  delta_pct?: number
}

export interface ShortLinkBundle {
  id: number
  user_id?: string
  name: string
  description: string | null
  icon: string | null
  accent: BundleAccent
  link_count: number
  total_clicks: number
  delta_pct?: number
  sparkline: number[]
  top_links: { slug: string; click_count: number }[]
  clicked_links?: number
  archived_at: number | null
  created_at: number
  updated_at: number
}

export interface BundleStatsPerLink {
  link_id: number
  label: string | null
  primary_slug: string
  url: string
  click_count: number
  pct_of_bundle: number
  delta_pct?: number
}

export interface TimelineBucket {
  label: string
  count: number
}

export interface TimelineData {
  range: TimelineRange
  buckets: TimelineBucket[]
  labels?: string[]
  values?: number[]
  summary?: {
    last_24h: number
    last_7d: number
    last_30d: number
    last_90d: number
    last_1y: number
  }
}

export interface BundleStats {
  bundle: ShortLinkBundle
  link_count: number
  total_clicks: number
  delta_pct?: number
  clicked_links: number
  top_performer?: { slug: string; label: string | null; click_count: number; pct_of_bundle: number }
  countries_reached: number
  top_country?: { name: string; pct: number }
  timeline: TimelineData
  countries: { name: string; count: number }[]
  devices: { name: string; count: number }[]
  os: { name: string; count: number }[]
  browsers: { name: string; count: number }[]
  referrers: { name: string; count: number }[]
  referrer_hosts: { name: string; count: number }[]
  link_modes: { name: string; count: number }[]
  per_link: BundleStatsPerLink[]
  num_countries: number
  num_referrers: number
  num_referrer_hosts: number
  num_os: number
  num_browsers: number
}

export interface ClickData {
  referrer?: string | null
  referrerHost?: string | null
  country?: string | null
  region?: string | null
  city?: string | null
  deviceType?: string | null
  os?: string | null
  browser?: string | null
  language?: string | null
  linkMode?: string
  channel?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmTerm?: string | null
  utmContent?: string | null
  userAgent?: string | null
  isBot?: number
  isSelfReferrer?: number
  visitorFp?: string | null
}

export interface ClickStats {
  total_clicks: number
  clicks?: number
  avg_clicks_per_day?: number | string
  countries: { name: string; count: number }[]
  referrers: { name: string; count: number }[]
  referrer_hosts: { name: string; count: number }[]
  devices: { name: string; count: number }[]
  os: { name: string; count: number }[]
  operating_systems?: { name: string; count: number }[]
  browsers: { name: string; count: number }[]
  link_modes: { name: string; count: number }[]
  channels: { name: string; count: number }[]
  clicks_over_time: { date: string; count: number }[]
  slug_clicks: { slug: string; count: number }[]
  num_countries: number
  num_referrers: number
  num_referrer_hosts: number
  num_os: number
  num_browsers: number
}

export interface BreakdownPage {
  dimension: string
  items: { name: string; count: number }[]
  total: number
  offset?: number
  limit?: number
  has_more?: boolean
}

export interface DashboardStats {
  range?: TimelineRange
  total_links: number
  active_links?: number
  total_clicks: number
  total_clicks_previous?: number
  total_clicks_delta?: number
  delta_clicks?: number | null
  new_links_delta?: number
  clicks_per_day?: number
  avg_clicks_per_day?: number | string
  clicks_per_day_delta?: number
  num_domains?: number
  num_countries?: number
  clicked_links?: number
  clicked_links_delta?: number
  timeline: number[] | { labels: string[]; values: number[] }
  timeline_links?: number[]
  timeline_clicked_links?: number[]
  recent_links: ShortLink[]
  top_links?: ShortLink[]
  top_countries: { name: string; count: number; code?: string; percentage?: number }[]
  top_referrers: { name: string; count: number; percentage?: number }[]
  num_referrers?: number
}

export interface ShortlinksSettings {
  slug_default_length: number
  slug_length?: number
  default_range: TimelineRange
  timeline_default_range?: TimelineRange
  filter_bots: boolean
  analytics_ignore_bots?: number
  filter_self_referrers: boolean
  analytics_ignore_self_referrer?: number
  updated_at?: number
}

export interface ShortlinkApiKey {
  id: number
  user_id?: string | number
  title: string
  name?: string
  api_key?: string
  key_prefix: string
  scope: string
  created_at: number
  last_used_at: number | null
}

export interface ShortlinkBackup {
  id: string | number
  user_id?: string | number
  filename: string
  r2_key: string
  size: number
  size_bytes?: number
  type: 'auto' | 'manual'
  created_at: number
}

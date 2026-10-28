export type XgetCategory = 'code' | 'package' | 'linux' | 'misc' | 'ai' | 'registry'

export const XGET_CATEGORIES: readonly XgetCategory[] = [
  'code',
  'package',
  'linux',
  'misc',
  'ai',
  'registry',
]

export interface XgetSettingsConfig {
  timeout_seconds: number
  max_retries: number
  retry_delay_ms: number
  cache_duration: number
  allowed_methods: string[]
  allowed_origins: string[]
  max_path_length: number
}

export interface XgetSettings {
  proxy_base_url: string
  platform_count: number
  has_proxy_token: boolean
  can_manage: boolean
  config: XgetSettingsConfig
}

export interface XgetResolveResult {
  platform: string
  target_url: string
}

export interface XgetStatsPlatform {
  platform: string
  count: number
  ok: number
  pct: number
}

export interface XgetStatsTrendPoint {
  day: string
  count: number
  ok: number
}

export type XgetStatsCategoryTrend = Record<XgetCategory, number> & { day: string }

export interface XgetStatsSummary {
  total: number
  ok: number
  okRate: number
  today: number
  platformCount: number
  platforms: XgetStatsPlatform[]
  trend: XgetStatsTrendPoint[]
  trendByCategory: XgetStatsCategoryTrend[]
}

export type XgetStatsRange = 7 | 30 | 'all'

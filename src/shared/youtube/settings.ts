/** The instance-wide YouTube API configuration, as the settings screen may see it. */
export interface YouTubeApiSettingsView {
  configured: boolean
  source: 'stored' | 'env' | 'none'
  hasStoredKey: boolean
  hasEnvKey: boolean
  region: string | null
  dailyQuota: number
  vaultAvailable: boolean
  apiBase: string
  imageBase: string
  r2Available: boolean
  searchAttemptsPerTenMinutes: number
}

export interface YouTubeSettingsView {
  canEdit: boolean
  api: YouTubeApiSettingsView
}

export interface YouTubeSettingsPatch {
  /** A new key, or null/empty to remove the stored key and fall back to the Worker secret. */
  apiKey?: string | null
  regionCode?: string | null
  dailyQuota?: number | null
}

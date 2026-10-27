/** The module's own configuration: deployment facts and the demo-account list. */
import { cfRequest } from './client'

export interface CloudflareModuleSettings {
  platform: string
  demo_account_ids: string
  r2: boolean
  vault: boolean
  version: string
}

export const cloudflareSettingsApi = {
  get: () => cfRequest<CloudflareModuleSettings>('/settings'),
  clearCache: () => cfRequest<{ cleared: true }>('/settings/cache/clear', { method: 'POST' }),
  saveDemoAccounts: (ids: string[]) =>
    cfRequest<{ demo_account_ids: string }>('/settings/demo-accounts', { method: 'PUT', body: { ids } }),
}

/** The browser-rendering door. */
import type { CloudflareAccount, CloudflareQuotaResponse } from '@shared/cloudflare/model'
import { cfRequest } from './client'

export const RENDER_MODES = ['screenshot', 'content', 'markdown', 'pdf', 'links'] as const
export type RenderMode = typeof RENDER_MODES[number]

export const RENDER_BROWSERS = ['chrome', 'kitesurf'] as const
export type RenderBrowser = typeof RENDER_BROWSERS[number]

export interface RenderResult {
  mode: RenderMode
  duration: number
  browserMsUsed: number
  screenshot?: string
  pdf?: string
  html?: string
  markdown?: string
  links?: unknown
}

export const browserRenderApi = {
  render: (input: { url: string; mode: RenderMode; browser: RenderBrowser; accountId?: string }) =>
    cfRequest<RenderResult>('/browser-render', { method: 'POST', body: input, timeoutMs: 300_000 }),
  accounts: () => cfRequest<{ accounts: CloudflareAccount[]; total: number }>('/accounts?pageSize=100'),
  quota: () => cfRequest<CloudflareQuotaResponse>('/quota'),
}

export function renderModeLabelKey(mode: RenderMode) {
  switch (mode) {
    case 'screenshot': return 'cloudflare.browser_render.screenshot' as const
    case 'content': return 'cloudflare.browser_render.html' as const
    case 'markdown': return 'cloudflare.browser_render.markdown' as const
    case 'pdf': return 'cloudflare.browser_render.pdf' as const
    case 'links': return 'cloudflare.browser_render.link_extract' as const
  }
}

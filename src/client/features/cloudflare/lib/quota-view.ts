/**
 * How a quota row reads on screen.
 *
 * The arithmetic is `lib/format`; this file only decides which catalogue sentence goes around it.
 * Browser-render time is minute/second shaped because that is how the browser-rendering limit is
 * published (600 seconds a day); everything else is a plain count.
 */
import { cfT } from '../i18n'
import { formatNumber, splitSeconds } from './format'

export interface QuotaResourceRow {
  resource: string
  count: number
  limit: number
  exhausted?: boolean
}

export const QUOTA_RESOURCE_ORDER = ['workers_requests', 'ai_neurons', 'browser_render_seconds'] as const

export function quotaResourceLabel(resource: string): string {
  switch (resource) {
    case 'workers_requests':
      return cfT('cloudflare.compact_card.workers_requests')
    case 'ai_neurons':
      return cfT('cloudflare.compact_card.ai_neurons')
    case 'browser_render_seconds':
      return cfT('cloudflare.compact_card.browser_render')
    default:
      return resource
  }
}

export function quotaUsedPercent(row: QuotaResourceRow): number {
  if (!row.limit) return 0
  return Math.min(100, Math.round(((row.count || 0) / row.limit) * 100))
}

export function quotaValueText(row: QuotaResourceRow): string {
  if (row.resource === 'browser_render_seconds') {
    const used = splitSeconds(row.count)
    const limit = splitSeconds(row.limit)
    const usedText = `${used.m > 0 ? cfT('cloudflare.compact_card.min_fmt', { m: used.m }) : ''}${cfT('cloudflare.compact_card.sec_fmt', { s: used.s })}`
    const limitText = `${limit.m > 0 ? cfT('cloudflare.compact_card.min_fmt', { m: limit.m }) : ''}${limit.s > 0 ? cfT('cloudflare.compact_card.sec_fmt', { s: limit.s }) : ''}`
    return `${usedText} / ${limitText}`
  }
  return `${formatNumber(row.count)} / ${formatNumber(row.limit)}`
}

/** A ring colour that reddens as the allowance is spent: the number is the fact, the ring is the glance. */
export function quotaTone(percent: number): string {
  if (percent >= 90) return 'var(--danger)'
  if (percent >= 70) return 'var(--warning)'
  return 'var(--chart-1)'
}

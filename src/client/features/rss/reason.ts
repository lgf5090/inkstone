import { t } from '../../lib/i18n'

export function rssReasonMessage(reason: string, status = 0): string {
  switch (reason) {
    case 'timeout': return t('rss.error.timeout')
    case 'too-large': return t('rss.error.too_large')
    case 'not-a-feed': return t('rss.error.not_a_feed')
    case 'blocked': return t('rss.error.blocked')
    case 'http': return status > 0 ? `${t('rss.error.http_status')} (${status})` : t('rss.error.http_status')
    default: return t('rss.error.unreachable')
  }
}

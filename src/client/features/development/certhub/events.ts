import {
  Ban,
  BadgeCheck,
  CalendarX,
  CircleAlert,
  CircleDot,
  Clock3,
  Download,
  FileWarning,
  KeyRound,
  RefreshCw,
  Send,
  ServerCog,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { eventKindKey } from '../../../../shared/development/certhub/events'
import { t } from '../../../lib/i18n'

type Tone = 'success' | 'warning' | 'danger' | 'neutral'

interface EventStyle {
  icon: typeof BadgeCheck
  tone: Tone
}

const EVENT_STYLES: Record<string, EventStyle> = {
  'account.registered': { icon: ShieldCheck, tone: 'success' },
  'account.rotated': { icon: RefreshCw, tone: 'success' },
  'cert.expired': { icon: CalendarX, tone: 'warning' },
  'cert.issued': { icon: BadgeCheck, tone: 'success' },
  'cert.revoked': { icon: Ban, tone: 'danger' },
  'challenge.pending_dns': { icon: Clock3, tone: 'warning' },
  'challenge.prepared': { icon: Clock3, tone: 'warning' },
  'challenge.regenerated': { icon: RefreshCw, tone: 'warning' },
  'config.updated': { icon: ServerCog, tone: 'neutral' },
  'job.dead': { icon: CircleAlert, tone: 'danger' },
  'key.downloaded': { icon: Download, tone: 'neutral' },
  'key.purged': { icon: KeyRound, tone: 'warning' },
  'notify.sent': { icon: Send, tone: 'neutral' },
  'order.canceled': { icon: Ban, tone: 'neutral' },
  'order.created': { icon: FileWarning, tone: 'neutral' },
  'order.deleted': { icon: Trash2, tone: 'danger' },
  'order.dns_provider_missing': { icon: CircleAlert, tone: 'danger' },
  'order.failed': { icon: CircleAlert, tone: 'danger' },
  'order.finalized': { icon: Clock3, tone: 'neutral' },
  'order.provider_bound': { icon: ServerCog, tone: 'success' },
  'order.queued': { icon: Clock3, tone: 'neutral' },
  'order.renewed': { icon: RefreshCw, tone: 'neutral' },
  'provider.created': { icon: ServerCog, tone: 'success' },
  'provider.deleted': { icon: Trash2, tone: 'danger' },
  'provider.updated': { icon: ServerCog, tone: 'neutral' },
  'quota.updated': { icon: ServerCog, tone: 'neutral' },
  'renew.failed': { icon: CircleAlert, tone: 'danger' },
  'token.created': { icon: KeyRound, tone: 'success' },
  'token.revoked': { icon: Ban, tone: 'danger' },
  'token.rotated': { icon: RefreshCw, tone: 'success' },
}

const FALLBACK: EventStyle = { icon: CircleDot, tone: 'neutral' }

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  danger: 'text-[var(--danger)]',
  neutral: 'text-[var(--text-tertiary)]',
}

export function eventStyle(kind: string): EventStyle {
  return EVENT_STYLES[kind] ?? FALLBACK
}

export function eventToneText(tone: Tone): string {
  return TONE_TEXT[tone]
}

export function eventLabel(kind: string): string {
  const key = eventKindKey(kind)
  const label = t(key as never)
  // A kind the catalog does not know yet must not leak its dotted key onto the page: the event list is
  // rendered for any stored row, including ones written by a newer worker.
  return label === key ? t('development.certhub.event.other') : label
}

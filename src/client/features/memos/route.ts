import { MEMOS_APP_PATH } from '@shared/memos/constants'

export interface MemoCalendarDate {
  year: number
  month?: number
  day?: number
}

export type MemoRoute =
  | { kind: 'home' }
  | { kind: 'explore' }
  | { kind: 'archived' }
  | { kind: 'calendar'; spaceId: string | null; date: MemoCalendarDate | null }
  | { kind: 'attachments'; spaceId: string | null }
  | { kind: 'inbox' }
  | { kind: 'map'; spaceId: string | null }
  | { kind: 'views' }
  | { kind: 'setting' }
  | { kind: 'space'; spaceId: string }
  | { kind: 'memo'; id: string }
  | { kind: 'profile'; username: string }
  | { kind: 'profileMemo'; username: string; id: string }
  | { kind: 'share'; token: string }
  | { kind: 'notFound' }

const YEAR = /^\d{4}$/
const MONTH = /^(?:[1-9]|1[0-2])$/
const DAY = /^(?:[1-9]|[12]\d|3[01])$/

const NOT_FOUND: MemoRoute = { kind: 'notFound' }

function calendarRoute(segments: readonly string[], spaceId: string | null): MemoRoute {
  if (segments.length === 0) return { kind: 'calendar', spaceId, date: null }
  if (segments.length > 3) return NOT_FOUND
  const [year, month, day] = segments
  if (
    !YEAR.test(year)
    || (month !== undefined && !MONTH.test(month))
    || (day !== undefined && !DAY.test(day))
  ) return NOT_FOUND
  const date: MemoCalendarDate = { year: Number(year) }
  if (month !== undefined) date.month = Number(month)
  if (day !== undefined) date.day = Number(day)
  return { kind: 'calendar', spaceId, date }
}

function spaceRoute(segments: readonly string[]): MemoRoute {
  const [spaceId, section, ...extra] = segments
  if (spaceId === undefined) return NOT_FOUND
  if (section === undefined) return { kind: 'space', spaceId }
  if (section === 'calendar') return calendarRoute(extra, spaceId)
  if (extra.length > 0) return NOT_FOUND
  if (section === 'attachments') return { kind: 'attachments', spaceId }
  if (section === 'map') return { kind: 'map', spaceId }
  return NOT_FOUND
}

export function parseMemoPath(pathname: string): MemoRoute {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (path === MEMOS_APP_PATH) return { kind: 'home' }
  if (!path.startsWith(`${MEMOS_APP_PATH}/`)) return NOT_FOUND
  const segments = path.slice(MEMOS_APP_PATH.length + 1).split('/')
  if (segments.some((segment) => segment === '')) return NOT_FOUND
  const [head, ...rest] = segments
  switch (head) {
    case 'explore':
      return rest.length === 0 ? { kind: 'explore' } : NOT_FOUND
    case 'archived':
      return rest.length === 0 ? { kind: 'archived' } : NOT_FOUND
    case 'calendar':
      return calendarRoute(rest, null)
    case 'attachments':
      return rest.length === 0 ? { kind: 'attachments', spaceId: null } : NOT_FOUND
    case 'inbox':
      return rest.length === 0 ? { kind: 'inbox' } : NOT_FOUND
    case 'map':
      return rest.length === 0 ? { kind: 'map', spaceId: null } : NOT_FOUND
    case 'views':
      return rest.length === 0 ? { kind: 'views' } : NOT_FOUND
    case 'setting':
      return rest.length === 0 ? { kind: 'setting' } : NOT_FOUND
    case 'spaces':
      return spaceRoute(rest)
    case 'm':
      return rest.length === 1 ? { kind: 'memo', id: rest[0] } : NOT_FOUND
    case 'u':
      if (rest.length === 1) return { kind: 'profile', username: rest[0] }
      if (rest.length === 3 && rest[1] === 'm') return { kind: 'profileMemo', username: rest[0], id: rest[2] }
      return NOT_FOUND
    case 's':
      return rest.length === 1 ? { kind: 'share', token: rest[0] } : NOT_FOUND
    default:
      return NOT_FOUND
  }
}

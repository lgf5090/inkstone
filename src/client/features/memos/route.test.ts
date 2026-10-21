import { describe, expect, it } from 'vitest'
import { parseMemoPath, type MemoRoute } from './route'

const ROUTES: readonly (readonly [string, MemoRoute])[] = [
  ['/memos', { kind: 'home' }],
  ['/memos/explore', { kind: 'explore' }],
  ['/memos/archived', { kind: 'archived' }],
  ['/memos/calendar', { kind: 'calendar', spaceId: null, date: null }],
  ['/memos/calendar/2026', { kind: 'calendar', spaceId: null, date: { year: 2026 } }],
  ['/memos/calendar/2026/10', { kind: 'calendar', spaceId: null, date: { year: 2026, month: 10 } }],
  ['/memos/calendar/2026/10/21', { kind: 'calendar', spaceId: null, date: { year: 2026, month: 10, day: 21 } }],
  ['/memos/attachments', { kind: 'attachments', spaceId: null }],
  ['/memos/inbox', { kind: 'inbox' }],
  ['/memos/map', { kind: 'map', spaceId: null }],
  ['/memos/views', { kind: 'views' }],
  ['/memos/setting', { kind: 'setting' }],
  ['/memos/spaces/team', { kind: 'space', spaceId: 'team' }],
  ['/memos/spaces/team/calendar', { kind: 'calendar', spaceId: 'team', date: null }],
  ['/memos/spaces/team/attachments', { kind: 'attachments', spaceId: 'team' }],
  ['/memos/spaces/team/map', { kind: 'map', spaceId: 'team' }],
  ['/memos/m/abc123', { kind: 'memo', id: 'abc123' }],
  ['/memos/u/alice', { kind: 'profile', username: 'alice' }],
  ['/memos/u/alice/m/abc123', { kind: 'profileMemo', username: 'alice', id: 'abc123' }],
  ['/memos/s/token123', { kind: 'share', token: 'token123' }],
]

const UNKNOWN_PATHS = [
  '',
  '/',
  '/notes',
  '/memosx',
  '/memos-inbox',
  '/memos/404',
  '/memos/unknown',
  '/memos/explore/extra',
  '/memos/archived/extra',
  '/memos/attachments/extra',
  '/memos/inbox/extra',
  '/memos/map/extra',
  '/memos/views/extra',
  '/memos/setting/extra',
  '/memos/calendar/twenty',
  '/memos/calendar/26',
  '/memos/calendar/2026/0',
  '/memos/calendar/2026/13',
  '/memos/calendar/2026/10/0',
  '/memos/calendar/2026/10/32',
  '/memos/calendar/2026/10/21/1',
  '/memos/spaces',
  '/memos/spaces/team/calendar/2026',
  '/memos/spaces/team/unknown',
  '/memos/spaces/team/setting',
  '/memos/m',
  '/memos/m/abc123/extra',
  '/memos/u',
  '/memos/u/alice/extra',
  '/memos/u/alice/m',
  '/memos/u/alice/m/abc123/extra',
  '/memos/s',
  '/memos/s/token123/extra',
]

describe('parseMemoPath', () => {
  for (const [path, route] of ROUTES) {
    it(`parses ${path}`, () => {
      expect(parseMemoPath(path)).toEqual(route)
    })
  }

  it('parses every route with a trailing slash', () => {
    for (const [path, route] of ROUTES) {
      expect(parseMemoPath(`${path}/`)).toEqual(route)
    }
  })

  it('answers notFound for an address the route table does not name', () => {
    for (const path of UNKNOWN_PATHS) {
      expect(parseMemoPath(path)).toEqual({ kind: 'notFound' })
    }
  })

  it('answers notFound for empty segments between named ones', () => {
    expect(parseMemoPath('/memos//explore')).toEqual({ kind: 'notFound' })
    expect(parseMemoPath('/memos/spaces//map')).toEqual({ kind: 'notFound' })
    expect(parseMemoPath('/memos/u//m/abc123')).toEqual({ kind: 'notFound' })
  })
})

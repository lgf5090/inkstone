import { Hono } from 'hono'
import type { MemoPreferencesPatch } from '@shared/memos/types'
import type { AppBindings } from '../../env'
import { readJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import { getMemoPreferences, patchMemoPreferences } from '../../memos/preferences'

const PREFERENCES_BODY_LIMIT = 256 * 1024

export const memoPreferenceRoutes = new Hono<AppBindings>()

memoPreferenceRoutes.use('*', requireMemoUser)

memoPreferenceRoutes.get('/', async (c) => {
  return c.json(await getMemoPreferences(c.env.DB, c.get('userId')))
})

memoPreferenceRoutes.patch('/', async (c) => {
  const patch = await readJson<MemoPreferencesPatch>(c, PREFERENCES_BODY_LIMIT)
  return c.json(await patchMemoPreferences(c.env.DB, c.get('userId'), patch))
})

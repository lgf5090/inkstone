// @vitest-environment node
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppBindings } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { websshRoutes } from '../src/worker/webssh/routes'

const USER = '0123456789abcdefghjkmnpqrs'

function appWithSession(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('user', {
      id: USER,
      username: 'reader',
      login: 'reader',
      name: 'Reader',
      avatarUrl: '',
      role: 'owner',
      createdAt: 1,
      settingsRaw: '{}',
    })
    await next()
  })
  app.route('/api/webssh', websshRoutes)
  return app
}

function anonymousApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.route('/api/webssh', websshRoutes)
  return app
}

describe('the WebSSH route mount', () => {
  it('refuses an anonymous request before any module data is read', async () => {
    const response = await anonymousApp().request('/api/webssh/health')
    expect(response.status).toBe(401)
    const body = await response.json() as { error?: { code?: string } }
    expect(body.error?.code).toBe('unauthenticated')
  })

  it('answers its own health only for a signed-in account', async () => {
    const response = await appWithSession().request('/api/webssh/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, module: 'webssh' })
  })
})

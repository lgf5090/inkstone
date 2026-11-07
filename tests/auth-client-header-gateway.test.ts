// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AppBindings } from '../src/worker/env'
import { requireClientHeader } from '../src/worker/middleware/auth'
import { CLIENT_HEADER } from '../src/shared/constants'
import { errorResponse } from '../src/worker/lib/errors'

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('/api/*', requireClientHeader)
  instance.post('/api/gateway/v1/chat/completions', (c) => c.json({ reached: 'gateway' }))
  instance.post('/api/gateway-admin/reset', (c) => c.json({ reached: 'other' }))
  instance.post('/api/notes', (c) => c.json({ reached: 'notes' }))
  return instance
}

describe('the gateway data plane is exempt from the browser client header', () => {
  it('lets a gateway POST through without the client header', async () => {
    const response = await app().request('/api/gateway/v1/chat/completions', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ reached: 'gateway' })
  })

  it('still rejects the same POST outside the gateway prefix', async () => {
    const response = await app().request('/api/notes', { method: 'POST' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'forbidden',
        message: `Missing client identification header. Web clients must send ${CLIENT_HEADER}: 1`,
      },
    })
  })

  it('does not treat a lookalike prefix as the gateway', async () => {
    const response = await app().request('/api/gateway-admin/reset', { method: 'POST' })
    expect(response.status).toBe(403)
  })
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/client/lib/api'
import type { SessionInfo } from '../src/shared/types'

const sent: Array<{ url: string; body: string }> = []

beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string') sent.push({ url: String(input), body: init.body })
    return new Response(JSON.stringify({ user: null, site: null } satisfies Partial<SessionInfo>), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// The server has required this token since S-04, but the console never learned to send
// it, so an operator who followed SECURITY.md could not create the first account.
it('sends the setup token on the registration call', async () => {
  await api.auth.register('owner', 'longenough-pass-1', 'en-US', 'first-owner-bootstrap-token')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.url).toContain('/api/auth/register')
  expect(JSON.parse(sent[0]!.body)).toMatchObject({
    username: 'owner',
    setupToken: 'first-owner-bootstrap-token',
  })
})

it('leaves the field out of an ordinary registration', async () => {
  await api.auth.register('member', 'longenough-pass-1', 'en-US')
  expect(JSON.parse(sent[0]!.body)).not.toHaveProperty('setupToken')
})

it('carries the token from the session store through to the API', async () => {
  const text = (await import('node:fs')).readFileSync('src/client/store/session.ts', 'utf8')
  expect(text).toMatch(/passwordRegister\(username, password, setupToken\)/)
  expect(text).toMatch(/api\.auth\.register\(username, password, getLocale\(\), setupToken\)/)
  expect(text).toMatch(/passwordRegister: \(username: string, password: string, setupToken\?: string\)/)
})

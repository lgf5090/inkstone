import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveSettingsSchema } from '@shared/tools/password/schemas'
import { passwordApi } from './api'

type Captured = { url: string; body: Record<string, unknown> | undefined; headers: Record<string, string> }

// The UI tests mock `passwordApi` wholesale, so a wire-shape mistake ships green. These tests assert
// the bytes that actually leave the browser.
function captureRequests(): Captured[] {
  const captured: Captured[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      captured.push({
        url: String(url),
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
        headers: init?.headers ?? {},
      })
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) }
    }),
  )
  return captured
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('passwordApi wire contracts', () => {
  it('sends only the settings fields it was given', async () => {
    const captured = captureRequests()

    await passwordApi.saveSettings({ autoLockMinutes: 15 })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.body).toEqual({ autoLockMinutes: 15 })
    expect(SaveSettingsSchema.parse(captured[0]!.body)).toEqual({ autoLockMinutes: 15 })
  })

  it('omits absent settings instead of writing an empty value', async () => {
    const captured = captureRequests()

    await passwordApi.saveSettings({ autoLockMinutes: 30 })

    expect(captured[0]!.body).toEqual({ autoLockMinutes: 30 })
  })

  it('asks for a fresh confirmation token with the master password', async () => {
    const captured = captureRequests()

    await passwordApi.reauth('master-pass')

    expect(captured[0]!.url).toContain('/api/tools/password/vault/re-auth')
    expect(captured[0]!.body).toEqual({ password: 'master-pass' })
  })

  it('carries the confirmation token on every destructive call', async () => {
    const captured = captureRequests()

    await passwordApi.wipeVault('token-1')
    await passwordApi.restoreBackup('backup-1', 'token-2')
    await passwordApi.deleteBackup('backup-2', 'token-3')

    expect(captured.map((call) => call.headers['X-Inkstone-Confirm'])).toEqual([
      'token-1',
      'token-2',
      'token-3',
    ])
    expect(captured[1]!.url).toContain('/backups/backup-1/restore')
    expect(captured[2]!.url).toContain('/backups/backup-2')
  })

  it('unwraps the API error object into a message and a code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'reauth_required', message: 'Enter the master password again' },
        }),
      })),
    )

    await expect(passwordApi.wipeVault('stale')).rejects.toMatchObject({
      name: 'PasswordApiError',
      message: 'Enter the master password again',
      code: 'reauth_required',
      status: 401,
    })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveSettingsSchema } from '@shared/tools/password/schemas'
import { passwordApi } from './api'

type Captured = { url: string; body: Record<string, unknown> | undefined }

// The UI tests mock `passwordApi` wholesale, so a wire-shape mistake (nested settings, `format`
// instead of `type`) ships green. These tests assert the bytes that actually leave the browser.
function captureRequests(): Captured[] {
  const captured: Captured[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      captured.push({
        url: String(url),
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
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
  it('saves settings with the flat keys the route validates', async () => {
    const captured = captureRequests()

    await passwordApi.saveSettings({
      webdav: {
        url: 'https://dav.example.com/x',
        username: 'me',
        password: 's3cret',
        enabled: true,
      },
      autoBackupEnabled: false,
      autoLockMinutes: 15,
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.body).toEqual({
      webdavUrl: 'https://dav.example.com/x',
      webdavUsername: 'me',
      webdavEnabled: true,
      webdavPassword: 's3cret',
      autoBackupEnabled: false,
      autoLockMinutes: 15,
    })
    expect(captured[0]!.body).not.toHaveProperty('webdav')
  })

  it('sends a settings body the server schema keeps intact instead of defaulting to empty', async () => {
    const captured = captureRequests()

    await passwordApi.saveSettings({
      webdav: {
        url: 'https://dav.example.com/x',
        username: 'me',
        password: 's3cret',
        enabled: true,
      },
      autoLockMinutes: 15,
    })

    // Before the mapping fix this parse produced url:'' — a 200 that silently erased the settings.
    const parsed = SaveSettingsSchema.parse(captured[0]!.body)
    expect(parsed.webdavUrl).toBe('https://dav.example.com/x')
    expect(parsed.webdavUsername).toBe('me')
    expect(parsed.webdavPassword).toBe('s3cret')
    expect(parsed.webdavEnabled).toBe(true)
    expect(parsed.autoLockMinutes).toBe(15)
  })

  it('omits a blank webdav password so the stored credential survives', async () => {
    const captured = captureRequests()

    await passwordApi.saveSettings({
      webdav: { url: '', username: '', password: '', enabled: false },
    })

    expect(captured[0]!.body).not.toHaveProperty('webdavPassword')
    expect(captured[0]!.body).toMatchObject({ webdavUrl: '', webdavEnabled: false })
  })

  it('posts an export with the `type` field the route requires', async () => {    const captured = captureRequests()

    await passwordApi.exportPlaintext('csv', 'title,password\na,b\n')

    expect(captured[0]!.url).toContain('/api/tools/password/export')
    expect(captured[0]!.body).toEqual({ type: 'csv', content: 'title,password\na,b\n' })
  })

  it('unwraps the API error object into a message and a code', async () => {
    // Reading `data.error` straight off the body used to put "[object Object]" in the toast and
    // made every failure indistinguishable from every other one.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'wrong_password', message: 'Master password is incorrect' },
        }),
      })),
    )

    await expect(passwordApi.unlock('nope00')).rejects.toMatchObject({
      name: 'PasswordApiError',
      message: 'Master password is incorrect',
      code: 'wrong_password',
      status: 401,
    })
  })
})

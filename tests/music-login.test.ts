// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { NeteaseLogin, type NeteaseLoginTransport } from '../src/worker/music/providers/netease/login'
import type { MusicAccount } from '../src/shared/music/model'

const account: MusicAccount = {
  provider: 'netease',
  accountId: '42',
  nickname: 'Listener',
  avatarUrl: '',
  status: 'connected',
  updatedAt: 1,
}

function harness(answer: Record<string, unknown>, readAccountOverride?: () => Promise<MusicAccount | null>) {
  let cookie = 'os=pc'
  const absorbed: string[] = []
  let readCalls = 0
  const transport: NeteaseLoginTransport = {
    request: async () => answer,
    readAccount: async () => {
      readCalls += 1
      if (readAccountOverride) return readAccountOverride()
      return cookie.includes('MUSIC_U=') ? account : null
    },
    currentCookie: () => cookie,
    absorbCookie: (value) => {
      const lines = typeof value === 'string' ? [value] : value
      for (const line of lines) {
        absorbed.push(line)
        cookie = `${cookie}; ${line}`
      }
    },
    resetCookie: () => {
      cookie = ''
    },
  }
  return { login: new NeteaseLogin(transport), absorbed, readCalls: () => readCalls }
}

describe('Netease QR confirmation', () => {
  it('absorbs a session cookie returned in the body before reading the account', async () => {
    const { login, absorbed, readCalls } = harness({
      code: 803,
      message: '\u6388\u6743\u767b\u9646\u6210\u529f',
      cookie: 'MUSIC_U=body-token; __csrf=csrf-token',
    })
    const result = await login.pollQr('key-1')
    expect(absorbed).toEqual(['MUSIC_U=body-token; __csrf=csrf-token'])
    expect(readCalls()).toBe(1)
    expect(result).toMatchObject({ status: 'confirmed', account })
    expect(result.cookie).toContain('MUSIC_U=body-token')
  })

  it('reads the same cookie from a wrapped data object', async () => {
    const { login, absorbed } = harness({
      code: 803,
      message: 'ok',
      data: { cookie: 'MUSIC_U=wrapped-token' },
    })
    const result = await login.pollQr('key-2')
    expect(absorbed).toEqual(['MUSIC_U=wrapped-token'])
    expect(result.cookie).toContain('MUSIC_U=wrapped-token')
  })

  it('does not read an account while the scan is still waiting', async () => {
    const { login, absorbed, readCalls } = harness({ code: 801, message: 'waiting' })
    const result = await login.pollQr('key-3')
    expect(result).toEqual({ status: 'waiting', message: 'waiting', cookie: '', account: null })
    expect(absorbed).toEqual([])
    expect(readCalls()).toBe(0)
  })

  it('retries the account read once after a confirmed scan', async () => {
    let reads = 0
    const { login } = harness(
      { code: 803, message: 'ok', cookie: 'MUSIC_U=retry-token' },
      async () => {
        reads += 1
        return reads > 1 ? account : null
      },
    )
    const result = await login.pollQr('key-4')
    expect(reads).toBe(2)
    expect(result).toMatchObject({ status: 'confirmed', account })
  }, 5_000)

  it('names the cookies it holds when the account still cannot be read', async () => {
    const { login } = harness(
      { code: 803, message: 'ok', cookie: 'MUSIC_U=lost-token' },
      async () => null,
    )
    await expect(login.pollQr('key-5')).rejects.toThrow(/MUSIC_U/)
  }, 5_000)
})

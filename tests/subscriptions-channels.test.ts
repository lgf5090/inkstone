import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatch, testChannel } from '../src/worker/subscriptions/channels'
import { checkTarget, redact } from '../src/worker/subscriptions/channels/http'

const CONTEXT = { timezone: 'Asia/Shanghai', locale: 'zh-CN' as const, now: Date.parse('2026-05-24T00:00:00Z') }
const PAYLOAD = { title: 'Netflix', content: '**到期** 还有 3 天' }

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[]

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(url, init)
  })
}

beforeEach(() => {
  calls = []
  stubFetch(() => reply({ ok: true }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function bodyOf(index = 0): Record<string, unknown> {
  return JSON.parse(String(calls[index]!.init.body)) as Record<string, unknown>
}

describe('the outbound guard', () => {
  it('refuses a private address', () => {
    expect(checkTarget('http://127.0.0.1:8080/hook').url).toBeNull()
    expect(checkTarget('http://localhost/hook').url).toBeNull()
    expect(checkTarget('http://10.0.0.1/hook').url).toBeNull()
  })

  it('refuses a scheme that is not http', () => {
    expect(checkTarget('file:///etc/passwd').error).toMatch(/http/)
    expect(checkTarget('not a url').error).toMatch(/valid/)
  })

  it('refuses credentials in the address', () => {
    expect(checkTarget('https://user:pass@example.com/x').error).toMatch(/credentials/)
  })

  it('does not follow a redirect', async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: 'http://example.com/next' } }))
    const result = await dispatch(PAYLOAD, [{ kind: 'gotify', config: { serverUrl: 'https://gotify.example.com', appToken: 't' } }], CONTEXT)
    expect(result.failedCount).toBe(1)
    expect(result.results[0]!.error).toMatch(/redirect/)
  })

  it('strips anything credential-shaped from a logged detail', () => {
    expect(redact('bot123456789:AAH-secret failed')).not.toContain('AAH-secret')
    expect(redact('?token=abcdef123456')).not.toContain('abcdef123456')
    expect(redact('Authorization: Bearer abcdefghijkl')).not.toContain('abcdefghijkl')
  })
})

describe('telegram', () => {
  it('escapes the body and posts to the bot endpoint', async () => {
    await dispatch(PAYLOAD, [{ kind: 'telegram', config: { botToken: 'abc', chatId: '42' } }], CONTEXT)
    expect(calls[0]!.url).toBe('https://api.telegram.org/botabc/sendMessage')
    expect(bodyOf().parse_mode).toBe('MarkdownV2')
    expect(String(bodyOf().text)).toContain('\\*\\*')
  })

  it('retries without markdown when the parse is refused', async () => {
    let count = 0
    stubFetch(() => {
      count++
      return count === 1
        ? reply({ ok: false, description: "Bad Request: can't parse entities" }, 400)
        : reply({ ok: true })
    })
    const result = await dispatch(PAYLOAD, [{ kind: 'telegram', config: { botToken: 'abc', chatId: '42' } }], CONTEXT)
    expect(result.successCount).toBe(1)
    expect(count).toBe(2)
  })
})

describe('the channels that answer in their own vocabulary', () => {
  it('accepts NotifyX only when it queued the message', async () => {
    stubFetch(() => reply({ status: 'failed' }))
    const failed = await dispatch(PAYLOAD, [{ kind: 'notifyx', config: { apiKey: 'k' } }], CONTEXT)
    expect(failed.failedCount).toBe(1)

    stubFetch(() => reply({ status: 'queued' }))
    const ok = await dispatch(PAYLOAD, [{ kind: 'notifyx', config: { apiKey: 'k' } }], CONTEXT)
    expect(ok.successCount).toBe(1)
  })

  it('accepts WeCom only on errcode zero', async () => {
    stubFetch(() => reply({ errcode: 93000, errmsg: 'invalid webhook' }))
    const failed = await dispatch(PAYLOAD, [{ kind: 'wechatbot', config: { webhook: 'https://qyapi.example.com/x' } }], CONTEXT)
    expect(failed.results[0]!.error).toContain('93000')
  })

  it('mentions everyone in a plain-text WeCom message', async () => {
    await dispatch(PAYLOAD, [{
      kind: 'wechatbot',
      config: { webhook: 'https://qyapi.example.com/x', msgType: 'text', atAll: true },
    }], CONTEXT)
    const body = bodyOf()
    expect(body.msgtype).toBe('text')
    expect((body.text as Record<string, unknown>).mentioned_list).toEqual(['@all'])
  })

  it('accepts Bark only on code 200 and uses the custom path when there is one', async () => {
    stubFetch(() => reply({ code: 200 }))
    await dispatch(PAYLOAD, [{ kind: 'bark', config: { server: 'https://bark.example.com/mykey' } }], CONTEXT)
    expect(calls[0]!.url).toBe('https://bark.example.com/mykey')
    expect(bodyOf().device_key).toBeUndefined()
  })

  it('posts the device key to the official Bark server', async () => {
    stubFetch(() => reply({ code: 200 }))
    await dispatch(PAYLOAD, [{ kind: 'bark', config: { server: 'https://api.day.app', deviceKey: 'k1' } }], CONTEXT)
    expect(calls[0]!.url).toBe('https://api.day.app/push')
    expect(bodyOf().device_key).toBe('k1')
  })

  it('accepts ServerChan only on code zero, and shortens the title', async () => {
    stubFetch(() => reply({ code: 0 }))
    const long = { title: 'x'.repeat(80), content: 'body' }
    const result = await dispatch(long, [{ kind: 'serverchan', config: { sendKey: 's' } }], CONTEXT)
    expect(result.successCount).toBe(1)
    const form = new URLSearchParams(String(calls[0]!.init.body))
    expect(form.get('title')).toHaveLength(32)
  })

  it('accepts PushPlus only on code 200 and forwards the topic', async () => {
    stubFetch(() => reply({ code: 200 }))
    await dispatch(PAYLOAD, [{ kind: 'pushplus', config: { token: 't', topic: 'group' } }], CONTEXT)
    expect(bodyOf().topic).toBe('group')
  })
})

describe('webhook', () => {
  it('fills the reader template', async () => {
    await dispatch(PAYLOAD, [{
      kind: 'webhook',
      config: { url: 'https://example.com/hook', template: '{"text":"{{title}} / {{daysRemaining}}","tag":"{{ruleType}}"}' },
    }], { ...CONTEXT })
    expect(bodyOf()).toEqual({ text: 'Netflix / ', tag: '' })
  })

  it('falls back to the default body when the template is unreadable', async () => {
    const result = await dispatch(PAYLOAD, [{ kind: 'webhook', config: { url: 'https://example.com/hook', template: '{oops' } }], CONTEXT)
    expect(result.successCount).toBe(1)
    expect(bodyOf().title).toBe('Netflix')
    expect(result.results[0]!.detail).toContain('default body')
  })

  it('sends custom headers', async () => {
    await dispatch(PAYLOAD, [{
      kind: 'webhook',
      config: { url: 'https://example.com/hook', headers: '{"x-signature":"abc"}' },
    }], CONTEXT)
    expect((calls[0]!.init.headers as Record<string, string>)['x-signature']).toBe('abc')
  })
})

describe('email', () => {
  it('posts a card to Resend with the sender name', async () => {
    stubFetch(() => reply({ id: 'msg-1' }))
    const result = await dispatch(PAYLOAD, [{
      kind: 'email',
      config: { apiKey: 're_1', from: 'a@example.com', fromName: 'Inkstone', to: 'b@example.com' },
    }], CONTEXT)
    expect(result.successCount).toBe(1)
    expect(calls[0]!.url).toBe('https://api.resend.com/emails')
    const body = bodyOf()
    expect(body.from).toBe('Inkstone <a@example.com>')
    expect(String(body.html)).toContain('Netflix')
    expect(String(body.html)).toContain('UTC+8')
  })
})

describe('one broken channel does not take the others down', () => {
  it('reports a failure beside the successes', async () => {
    stubFetch((url) => {
      if (url.includes('gotify')) return new Response('no', { status: 500 })
      return reply({ ok: true, code: 200 })
    })
    const result = await dispatch(PAYLOAD, [
      { kind: 'telegram', config: { botToken: 'abc', chatId: '42' } },
      { kind: 'gotify', config: { serverUrl: 'https://gotify.example.com', appToken: 't' } },
    ], CONTEXT)
    expect(result.attempted).toBe(2)
    expect(result.successCount).toBe(1)
    expect(result.failedCount).toBe(1)
  })
})

describe('the test button', () => {
  it('sends the catalog copy for a test message', async () => {
    await testChannel('gotify', { serverUrl: 'https://gotify.example.com', appToken: 't' }, CONTEXT)
    expect(bodyOf().message).toContain('测试')
  })

  it('answers a failure rather than throwing', async () => {
    stubFetch(() => {
      throw new TypeError('network down')
    })
    const result = await testChannel('gotify', { serverUrl: 'https://gotify.example.com', appToken: 't' }, CONTEXT)
    expect(result.success).toBe(false)
    expect(result.error).toContain('network down')
  })
})

/**
 * The nine ways a reminder leaves the building.
 *
 * Each adapter is a small function with the same shape: read the configuration it was given, build one
 * request, ask `outbound` to send it, and decide from the far end's own vocabulary whether it worked.
 * The decision is the part that cannot be generalized — Telegram says `ok`, WeCom says `errcode: 0`,
 * Bark says `code: 200` — so each one states its own predicate rather than sharing a hopeful `res.ok`.
 *
 * All nine are deliberately tolerant of a missing field: `saveChannel` refuses to store a channel that
 * cannot send, so an adapter reaching a blank value means the row was edited outside this app, and the
 * honest answer is a failed delivery with a reason rather than a throw that takes the sweep down.
 */
import {
  escapeMarkdownV2,
  stripMarkdown,
  type ChannelAdapter,
  type ChannelPayload,
  type ChannelResult,
  type SendContext,
} from '@shared/subscriptions/channels'
import { describeTimezone, notifyCopy } from '@shared/subscriptions/notify-copy'
import { formatLocalDate } from '@shared/subscriptions/time'
import type { ChannelKind } from '@shared/subscriptions/model'
import { outbound, parseJson, redact } from './http'

type Config = Record<string, unknown>

function text(config: Config, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}

function flag(config: Config, key: string): boolean {
  const value = config[key]
  return value === true || value === 'true'
}

function failure(kind: ChannelKind, error: string, detail = ''): ChannelResult {
  return { success: false, channel: kind, error, detail: redact(detail) }
}

function success(kind: ChannelKind, detail = ''): ChannelResult {
  return { success: true, channel: kind, detail: redact(detail) }
}

const telegram: ChannelAdapter = {
  kind: 'telegram',
  async send(payload, config) {
    const token = text(config, 'botToken')
    const chatId = text(config, 'chatId')
    if (!token || !chatId) return failure('telegram', 'The bot token and chat id are both required')
    const url = `https://api.telegram.org/bot${token}/sendMessage`
    const plain = `${payload.title}\n\n${payload.content}`
    const body = JSON.stringify({
      chat_id: chatId,
      text: escapeMarkdownV2(`*${payload.title}*\n\n${payload.content}`),
      parse_mode: 'MarkdownV2',
    })

    const first = await outbound(url, { headers: { 'content-type': 'application/json' }, body })
    const parsed = parseJson(first.text)
    if (parsed?.ok === true) return success('telegram', first.text)

    const description = typeof parsed?.description === 'string' ? parsed.description : ''
    if (/parse entities/i.test(description)) {
      const retry = await outbound(url, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: plain }),
      })
      const second = parseJson(retry.text)
      return second?.ok === true
        ? success('telegram', retry.text)
        : failure('telegram', `Telegram refused the message: ${typeof second?.description === 'string' ? second.description : first.error}`, retry.text)
    }
    return failure('telegram', `Telegram refused the message: ${description || first.error}`, first.text)
  },
}

const notifyx: ChannelAdapter = {
  kind: 'notifyx',
  async send(payload, config) {
    const apiKey = text(config, 'apiKey')
    if (!apiKey) return failure('notifyx', 'An API key is required')
    const response = await outbound(`https://www.notifyx.cn/api/v1/send/${encodeURIComponent(apiKey)}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: payload.title,
        content: `## ${payload.title}\n\n${payload.content}`,
        description: 'subscriptions',
      }),
    })
    const parsed = parseJson(response.text)
    return parsed?.status === 'queued'
      ? success('notifyx', response.text)
      : failure('notifyx', `NotifyX answered ${String(parsed?.status ?? response.error)}`, response.text)
  },
}

/**
 * A webhook whose body shape the reader chose.
 *
 * The template is JSON with `{{placeholders}}`; it is stringified, substituted and parsed back, which
 * is the reference project's approach and the only one that lets a value contain quotes without
 * breaking the document. An unreadable template falls back to the default body and says so in the
 * detail, because a webhook that silently sent the wrong shape would be worse than one that sent the
 * documented shape.
 */
const webhook: ChannelAdapter = {
  kind: 'webhook',
  async send(payload, config, context) {
    const url = text(config, 'url')
    if (!url) return failure('webhook', 'An address is required')
    const method = text(config, 'method') === 'GET' ? 'GET' : 'POST'

    let headers: Record<string, string> = { 'content-type': 'application/json' }
    const headerText = text(config, 'headers')
    if (headerText) {
      const parsed = parseJson(headerText)
      if (parsed) headers = { ...headers, ...Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)])) }
    }

    const data = templateData(payload, context)
    let body: Record<string, unknown> = { ...data }
    let note = ''
    const template = text(config, 'template')
    if (template) {
      const applied = applyTemplate(template, data)
      if (applied) body = applied
      else note = 'The message template could not be read; the default body was sent.'
    }

    const response = await outbound(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
    })
    return response.ok
      ? success('webhook', note ? `${note} ${response.text}` : response.text)
      : failure('webhook', `${response.error} from the webhook`, response.text)
  },
}

function templateData(payload: ChannelPayload, context: SendContext): Record<string, unknown> {
  const tags = Array.isArray(payload.metadata?.tags)
    ? payload.metadata!.tags!.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
    : []
  const timestamp = formatLocalDate(context.now ?? Date.now(), context.timezone, 'datetime')
  const copy = notifyCopy(context.locale)
  const tagsLine = tags.length ? `${tags.join(', ')}` : ''
  const message = [payload.title, payload.content, tagsLine, `${copy.sentAt}: ${timestamp}`]
    .filter((part) => part && part.trim())
    .join('\n\n')
  return {
    title: payload.title,
    content: payload.content,
    tags: tags.map((tag) => `- ${tag}`).join('\n'),
    tagsLine,
    rawTags: tags,
    timestamp,
    formattedMessage: message,
    message,
    daysRemaining: payload.metadata?.daysRemaining ?? '',
    ruleType: payload.metadata?.ruleType ?? '',
    ruleValue: payload.metadata?.ruleValue ?? '',
  }
}

function applyTemplate(template: string, data: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(template) as unknown
    const replaced = JSON.stringify(parsed).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(data, key)) return ''
      return JSON.stringify(String(data[key] ?? '')).slice(1, -1)
    })
    const value = JSON.parse(replaced) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

const wechatbot: ChannelAdapter = {
  kind: 'wechatbot',
  async send(payload, config) {
    const url = text(config, 'webhook')
    if (!url) return failure('wechatbot', 'A webhook address is required')
    const markdown = text(config, 'msgType') === 'markdown'
    const body: Record<string, unknown> = markdown
      ? { msgtype: 'markdown', markdown: { content: `# ${payload.title}\n\n${payload.content}` } }
      : { msgtype: 'text', text: { content: `${payload.title}\n\n${stripMarkdown(payload.content)}` } }

    if (!markdown) {
      const textBody = body.text as Record<string, unknown>
      const mobiles = text(config, 'atMobiles').split(',').map((entry) => entry.trim()).filter(Boolean)
      if (flag(config, 'atAll')) textBody.mentioned_list = ['@all']
      else if (mobiles.length) textBody.mentioned_mobile_list = mobiles
    }

    const response = await outbound(url, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const parsed = parseJson(response.text)
    if (parsed?.errcode === 0) return success('wechatbot', response.text)
    return failure(
      'wechatbot',
      `WeCom answered errcode=${String(parsed?.errcode ?? response.error)} ${String(parsed?.errmsg ?? '')}`.trim(),
      response.text,
    )
  },
}

/**
 * Email, through Resend.
 *
 * The card is deliberately plain: a notification is read in whatever client the reader already has, and
 * a layout that depends on a gradient or a web font reads as a broken table in half of them. One
 * accent bar, one heading, the body in readable type, and a footer that says when it was sent.
 */
const email: ChannelAdapter = {
  kind: 'email',
  async send(payload, config, context) {
    const apiKey = text(config, 'apiKey')
    const from = text(config, 'from')
    const to = text(config, 'to')
    if (!apiKey || !from || !to) return failure('email', 'The API key, sender and recipient are all required')
    const fromName = text(config, 'fromName')
    const response = await outbound('https://api.resend.com/emails', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: fromName ? `${fromName} <${from}>` : from,
        to,
        subject: payload.title,
        html: emailHtml(payload, context),
        text: stripMarkdown(payload.content),
      }),
    })
    const parsed = parseJson(response.text)
    return response.ok && typeof parsed?.id === 'string'
      ? success('email', response.text)
      : failure('email', `Resend answered ${String(parsed?.message ?? response.error)}`, response.text)
  },
}

function emailHtml(payload: ChannelPayload, context: SendContext): string {
  const escape = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const copy = notifyCopy(context.locale)
  const paragraphs = stripMarkdown(payload.content)
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#2a2a2a;">${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
  const stamp = `${copy.sentAt}: ${formatLocalDate(context.now ?? Date.now(), context.timezone, 'datetime')} · ${describeTimezone(copy, context.timezone)}`
  return `<!DOCTYPE html>
<html lang="${context.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(payload.title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">
    <div style="height:4px;background:#1f1f1f;"></div>
    <div style="padding:24px 24px 8px;">
      <h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;font-weight:600;color:#18181b;">${escape(payload.title)}</h1>
      ${paragraphs}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.6;color:#71717a;">${escape(stamp)}</div>
  </div>
</body></html>`
}

/**
 * Bark, including the two shapes its server comes in.
 *
 * A reader who runs their own Bark server types its address and nothing else, and that address already
 * carries the device key in its path; the official service needs the key in the body. The reference
 * project distinguished the two by whether the path was empty, which is the only signal available.
 */
const bark: ChannelAdapter = {
  kind: 'bark',
  async send(payload, config) {
    const server = text(config, 'server') || 'https://api.day.app'
    const deviceKey = text(config, 'deviceKey')

    let parsed: URL
    try {
      parsed = new URL(server)
    } catch {
      return failure('bark', 'The server address is not a valid URL')
    }
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
    if (parsed.username) {
      const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
      headers.authorization = `Basic ${btoa(credentials)}`
      parsed.username = ''
      parsed.password = ''
    }
    const custom = parsed.pathname !== '' && parsed.pathname !== '/'
    const base = parsed.toString().replace(/\/+$/, '')
    if (!custom && !deviceKey) return failure('bark', 'The official Bark server needs a device key')

    const body: Record<string, unknown> = { title: payload.title, body: stripMarkdown(payload.content) }
    if (!custom) body.device_key = deviceKey
    if (flag(config, 'isArchive')) body.isArchive = 1

    const response = await outbound(custom ? base : `${base}/push`, {
      headers,
      body: JSON.stringify(body),
    })
    const answer = parseJson(response.text)
    return answer?.code === 200
      ? success('bark', response.text)
      : failure('bark', `Bark answered code=${String(answer?.code ?? response.error)}`, response.text)
  },
}

const gotify: ChannelAdapter = {
  kind: 'gotify',
  async send(payload, config) {
    const server = text(config, 'serverUrl')
    const token = text(config, 'appToken')
    if (!server || !token) return failure('gotify', 'The server address and app token are both required')
    const url = `${server.replace(/\/+$/, '')}/message?token=${encodeURIComponent(token)}`
    const response = await outbound(url, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: payload.title, message: stripMarkdown(payload.content), priority: 5 }),
    })
    return response.ok ? success('gotify', response.text) : failure('gotify', response.error, response.text)
  },
}

const serverchan: ChannelAdapter = {
  kind: 'serverchan',
  async send(payload, config) {
    const sendKey = text(config, 'sendKey')
    if (!sendKey) return failure('serverchan', 'A SendKey is required')
    const body = new URLSearchParams({
      title: payload.title.slice(0, 32),
      desp: `## ${payload.title}\n\n${payload.content}`,
    })
    const response = await outbound(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const answer = parseJson(response.text)
    return answer?.code === 0
      ? success('serverchan', response.text)
      : failure('serverchan', `ServerChan answered code=${String(answer?.code ?? response.error)} ${String(answer?.message ?? '')}`.trim(), response.text)
  },
}

const pushplus: ChannelAdapter = {
  kind: 'pushplus',
  async send(payload, config) {
    const token = text(config, 'token')
    if (!token) return failure('pushplus', 'A token is required')
    const body: Record<string, unknown> = {
      token,
      title: payload.title,
      content: `## ${payload.title}\n\n${payload.content}`,
      template: 'markdown',
    }
    const topic = text(config, 'topic')
    const channel = text(config, 'channel')
    if (topic) body.topic = topic
    if (channel) body.channel = channel

    const response = await outbound('https://www.pushplus.plus/send', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const answer = parseJson(response.text)
    return answer?.code === 200
      ? success('pushplus', response.text)
      : failure('pushplus', `PushPlus answered code=${String(answer?.code ?? response.error)} ${String(answer?.msg ?? '')}`.trim(), response.text)
  },
}

export const ADAPTERS: readonly ChannelAdapter[] = [
  telegram,
  notifyx,
  webhook,
  wechatbot,
  email,
  bark,
  gotify,
  serverchan,
  pushplus,
]

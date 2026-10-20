/**
 * The ten delivery channels, described once.
 *
 * A channel is three things: a kind the database stores, a set of fields a person fills in, and an
 * adapter that turns a message into one HTTP request. The first two live here so the settings screen
 * can draw a form it was not hand-written for, and so the worker can validate the same fields against
 * the same required flags. The third lives beside the worker, because it needs `fetch`.
 *
 * One channel has no request to make: the app's own notification inbox. It is still a channel, because
 * it is still a place a reader decides whether reminders reach them and a result the delivery log keeps.
 *
 * Secrets are marked as such. A `password` field is the only kind whose stored value is never sent back
 * to the browser, and the form treats an empty one as "keep what is there" — the reference project's
 * behaviour, and the only one that lets a reader edit a webhook URL without retyping a bot token.
 */
import type { MessageKey } from '../locales/en-US'
import type { ChannelKind, NotifyLocale } from './model'

export interface ChannelSelectOption {
  value: string
  labelKey: MessageKey
}

export type ChannelField =
  | { key: string; type: 'text' | 'password' | 'url' | 'email'; labelKey: MessageKey; placeholderKey?: MessageKey; required?: boolean; hintKey?: MessageKey }
  | { key: string; type: 'select'; labelKey: MessageKey; options: ChannelSelectOption[] }
  | { key: string; type: 'switch'; labelKey: MessageKey; hintKey?: MessageKey }
  | { key: string; type: 'json' | 'textarea'; labelKey: MessageKey; rows?: number; placeholderKey?: MessageKey; required?: boolean }

export interface ChannelDefinition {
  kind: ChannelKind
  labelKey: MessageKey
  fields: readonly ChannelField[]
}

const METHOD_OPTIONS: ChannelSelectOption[] = [
  { value: 'POST', labelKey: 'subscriptions.option.post' },
  { value: 'GET', labelKey: 'subscriptions.option.get' },
]

const MESSAGE_TYPE_OPTIONS: ChannelSelectOption[] = [
  { value: 'text', labelKey: 'subscriptions.option.plain_text' },
  { value: 'markdown', labelKey: 'subscriptions.option.markdown' },
]

/**
 * What each channel needs, in the order a person fills it in.
 *
 * The order is not arbitrary: the address first, then the credential, then the preferences. A form that
 * asks for a parse mode before it asks where to send has the reader scrolling back to check what they
 * are configuring.
 */
export const CHANNEL_DEFINITIONS: readonly ChannelDefinition[] = [
  {
    kind: 'inapp',
    labelKey: 'subscriptions.channel.inapp',
    // Nothing to fill in: this is the reader's own inbox, not a service holding a credential.
    fields: [],
  },
  {
    kind: 'telegram',
    labelKey: 'subscriptions.channel.telegram',
    fields: [
      { key: 'botToken', type: 'password', labelKey: 'subscriptions.field.bot_token', placeholderKey: 'subscriptions.placeholder.keep_secret', required: true },
      { key: 'chatId', type: 'text', labelKey: 'subscriptions.field.chat_id', placeholderKey: 'subscriptions.placeholder.chat_id', required: true },
    ],
  },
  {
    kind: 'notifyx',
    labelKey: 'subscriptions.channel.notifyx',
    fields: [
      { key: 'apiKey', type: 'password', labelKey: 'subscriptions.field.api_key', placeholderKey: 'subscriptions.placeholder.keep_secret', required: true },
    ],
  },
  {
    kind: 'webhook',
    labelKey: 'subscriptions.channel.webhook',
    fields: [
      { key: 'url', type: 'url', labelKey: 'subscriptions.field.url', placeholderKey: 'subscriptions.placeholder.keep_secret', required: true },
      { key: 'method', type: 'select', labelKey: 'subscriptions.field.method', options: METHOD_OPTIONS },
      { key: 'headers', type: 'json', labelKey: 'subscriptions.field.headers', rows: 3, placeholderKey: 'subscriptions.placeholder.headers' },
      { key: 'template', type: 'json', labelKey: 'subscriptions.field.template', rows: 4, placeholderKey: 'subscriptions.placeholder.template' },
    ],
  },
  {
    kind: 'wechatbot',
    labelKey: 'subscriptions.channel.wechatbot',
    fields: [
      { key: 'webhook', type: 'url', labelKey: 'subscriptions.field.webhook', placeholderKey: 'subscriptions.placeholder.keep_secret', required: true },
      { key: 'msgType', type: 'select', labelKey: 'subscriptions.field.message_type', options: MESSAGE_TYPE_OPTIONS },
      { key: 'atMobiles', type: 'text', labelKey: 'subscriptions.field.at_mobiles', placeholderKey: 'subscriptions.placeholder.at_mobiles' },
      { key: 'atAll', type: 'switch', labelKey: 'subscriptions.field.at_all', hintKey: 'subscriptions.hint.at_all' },
    ],
  },
  {
    kind: 'email',
    labelKey: 'subscriptions.channel.email',
    fields: [
      { key: 'apiKey', type: 'password', labelKey: 'subscriptions.field.api_key', placeholderKey: 'subscriptions.placeholder.keep_secret', required: true },
      { key: 'from', type: 'email', labelKey: 'subscriptions.field.from', placeholderKey: 'subscriptions.placeholder.from', required: true },
      { key: 'fromName', type: 'text', labelKey: 'subscriptions.field.from_name', placeholderKey: 'subscriptions.placeholder.from_name' },
      { key: 'to', type: 'email', labelKey: 'subscriptions.field.to', placeholderKey: 'subscriptions.placeholder.to', required: true },
    ],
  },
  {
    kind: 'bark',
    labelKey: 'subscriptions.channel.bark',
    fields: [
      { key: 'server', type: 'url', labelKey: 'subscriptions.field.server', placeholderKey: 'subscriptions.placeholder.bark_server' },
      { key: 'deviceKey', type: 'password', labelKey: 'subscriptions.field.device_key', placeholderKey: 'subscriptions.placeholder.keep_secret' },
      { key: 'isArchive', type: 'switch', labelKey: 'subscriptions.field.archive', hintKey: 'subscriptions.hint.archive' },
    ],
  },
  {
    kind: 'gotify',
    labelKey: 'subscriptions.channel.gotify',
    fields: [
      { key: 'serverUrl', type: 'url', labelKey: 'subscriptions.field.server_url', placeholderKey: 'subscriptions.placeholder.gotify_server', required: true },
      { key: 'appToken', type: 'password', labelKey: 'subscriptions.field.app_token', placeholderKey: 'subscriptions.placeholder.keep_secret', required: true },
    ],
  },
  {
    kind: 'serverchan',
    labelKey: 'subscriptions.channel.serverchan',
    fields: [
      { key: 'sendKey', type: 'password', labelKey: 'subscriptions.field.send_key', placeholderKey: 'subscriptions.placeholder.keep_secret', required: true },
    ],
  },
  {
    kind: 'pushplus',
    labelKey: 'subscriptions.channel.pushplus',
    fields: [
      { key: 'token', type: 'password', labelKey: 'subscriptions.field.token', placeholderKey: 'subscriptions.placeholder.keep_secret', required: true },
      { key: 'topic', type: 'text', labelKey: 'subscriptions.field.topic', placeholderKey: 'subscriptions.placeholder.topic' },
      { key: 'channel', type: 'text', labelKey: 'subscriptions.field.channel', placeholderKey: 'subscriptions.placeholder.channel' },
    ],
  },
]

const BY_KIND = new Map(CHANNEL_DEFINITIONS.map((definition) => [definition.kind, definition]))

export function channelDefinition(kind: ChannelKind): ChannelDefinition {
  return BY_KIND.get(kind) as ChannelDefinition
}

export function channelLabelKey(kind: ChannelKind): MessageKey {
  return channelDefinition(kind).labelKey
}

/** The fields whose value is a credential: never returned, and blank on save means "keep". */
export function secretFields(kind: ChannelKind): string[] {
  return channelDefinition(kind).fields.filter((field) => field.type === 'password').map((field) => field.key)
}

/** A config object with every credential replaced by the placeholder the form shows. */
export function maskChannelConfig(kind: ChannelKind, config: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...config }
  for (const key of secretFields(kind)) {
    if (masked[key]) masked[key] = ''
  }
  return masked
}

/**
 * A one-line description of what is stored, for the settings row.
 *
 * A URL's host says which server is configured without revealing a token that may sit in its path; a
 * bare credential can only offer its last four characters. Both are safe to paint and enough to tell
 * two configurations apart.
 */
export function channelHint(kind: ChannelKind, config: Record<string, unknown>): string {
  const definition = channelDefinition(kind)
  const urlField = definition.fields.find((field) => field.type === 'url')
  if (urlField) {
    const value = config[urlField.key]
    if (typeof value === 'string' && value.trim()) {
      try {
        return new URL(value).host
      } catch {
        return value.slice(0, 24)
      }
    }
  }
  for (const key of secretFields(kind)) {
    const value = config[key]
    if (typeof value === 'string' && value.length >= 4) return `••••${value.slice(-4)}`
    if (typeof value === 'string' && value.length > 0) return '••••'
  }
  return ''
}

/** What a channel is asked to deliver. `content` is markdown-ish text, which each adapter adapts. */
export interface ChannelPayload {
  title: string
  content: string
  metadata?: {
    tags?: string[]
    daysRemaining?: number
    ruleType?: string
    ruleValue?: number
  }
}

export interface ChannelResult {
  success: boolean
  channel: ChannelKind
  error?: string
  /** Whatever the far end said, already shortened and stripped of anything credential-shaped. */
  detail?: string
}

/** Everything an adapter needs that is not its own configuration. */
export interface SendContext {
  timezone: string
  locale: NotifyLocale
  now?: number
}

export interface ChannelAdapter {
  kind: ChannelKind
  send(payload: ChannelPayload, config: Record<string, unknown>, context: SendContext): Promise<ChannelResult>
}

/** Telegram's MarkdownV2 reserved set. A subscription named `Pro_Plan` breaks the message without it. */
export function escapeMarkdownV2(text: string): string {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

/** Strip the light markdown the body uses, for the channels that take plain text. */
export function stripMarkdown(text: string): string {
  return String(text).replace(/(\*\*|\*|##|#|`)/g, '')
}

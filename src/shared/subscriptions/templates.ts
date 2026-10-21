/**
 * A short list of services people subscribe to most, with where they usually get filed.
 *
 * This is a starting point for a form, not a price list. What a template carries is the shape of the
 * thing — its name as the service writes it, the type and category it is usually filed under, and how
 * often it charges — because those are the three choices that make someone stop and think, and none of
 * them change. What it deliberately does not carry is an amount: a price read from a pricing page on the
 * day this file was written is wrong the day the publisher moves it, the tier a reader is on is their
 * own business, and a number the app filled in silently is a number the reader will not check. The
 * amount stays the one field that is always typed.
 *
 * The names are proper nouns, spelled the way each service spells it, so they are the same in every
 * language and are not interface copy. The two labels are keys into the built-in preset tables, which
 * means the form writes them in the language the reader is reading in and a mistyped key stops
 * compiling.
 */
import type { MessageKey } from '../locales/en-US'
import type { PeriodUnit } from './model'

export interface ServiceTemplate {
  name: string
  typeKey: MessageKey
  categoryKey: MessageKey
  periodValue: number
  periodUnit: PeriodUnit
}

export const SERVICE_TEMPLATES: readonly ServiceTemplate[] = [
  { name: 'Netflix', typeKey: 'subscriptions.type.streaming', categoryKey: 'subscriptions.category.entertainment', periodValue: 1, periodUnit: 'month' },
  { name: 'Disney+', typeKey: 'subscriptions.type.streaming', categoryKey: 'subscriptions.category.family', periodValue: 1, periodUnit: 'month' },
  { name: 'YouTube Premium', typeKey: 'subscriptions.type.streaming', categoryKey: 'subscriptions.category.personal', periodValue: 1, periodUnit: 'month' },
  { name: 'Spotify', typeKey: 'subscriptions.type.music', categoryKey: 'subscriptions.category.personal', periodValue: 1, periodUnit: 'month' },
  { name: 'Apple Music', typeKey: 'subscriptions.type.music', categoryKey: 'subscriptions.category.personal', periodValue: 1, periodUnit: 'month' },
  { name: 'Apple iCloud+', typeKey: 'subscriptions.type.cloud', categoryKey: 'subscriptions.category.personal', periodValue: 1, periodUnit: 'month' },
  { name: 'Google One', typeKey: 'subscriptions.type.cloud', categoryKey: 'subscriptions.category.personal', periodValue: 1, periodUnit: 'month' },
  { name: 'Dropbox', typeKey: 'subscriptions.type.cloud', categoryKey: 'subscriptions.category.work', periodValue: 1, periodUnit: 'month' },
  { name: 'Microsoft 365', typeKey: 'subscriptions.type.software', categoryKey: 'subscriptions.category.productivity', periodValue: 1, periodUnit: 'year' },
  { name: 'Adobe Creative Cloud', typeKey: 'subscriptions.type.software', categoryKey: 'subscriptions.category.work', periodValue: 1, periodUnit: 'month' },
  { name: 'Notion', typeKey: 'subscriptions.type.software', categoryKey: 'subscriptions.category.productivity', periodValue: 1, periodUnit: 'month' },
  { name: '1Password', typeKey: 'subscriptions.type.software', categoryKey: 'subscriptions.category.personal', periodValue: 1, periodUnit: 'year' },
  { name: 'Figma', typeKey: 'subscriptions.type.software', categoryKey: 'subscriptions.category.development', periodValue: 1, periodUnit: 'month' },
  { name: 'GitHub Copilot', typeKey: 'subscriptions.type.ai', categoryKey: 'subscriptions.category.development', periodValue: 1, periodUnit: 'month' },
  { name: 'ChatGPT', typeKey: 'subscriptions.type.ai', categoryKey: 'subscriptions.category.productivity', periodValue: 1, periodUnit: 'month' },
  { name: 'Claude', typeKey: 'subscriptions.type.ai', categoryKey: 'subscriptions.category.productivity', periodValue: 1, periodUnit: 'month' },
  { name: 'Gemini', typeKey: 'subscriptions.type.ai', categoryKey: 'subscriptions.category.productivity', periodValue: 1, periodUnit: 'month' },
  { name: 'PlayStation Plus', typeKey: 'subscriptions.type.gaming', categoryKey: 'subscriptions.category.entertainment', periodValue: 1, periodUnit: 'month' },
  { name: 'Xbox Game Pass', typeKey: 'subscriptions.type.gaming', categoryKey: 'subscriptions.category.entertainment', periodValue: 1, periodUnit: 'month' },
  { name: 'Nintendo Switch Online', typeKey: 'subscriptions.type.gaming', categoryKey: 'subscriptions.category.entertainment', periodValue: 1, periodUnit: 'year' },
  { name: 'Coursera Plus', typeKey: 'subscriptions.type.learning', categoryKey: 'subscriptions.category.study', periodValue: 1, periodUnit: 'month' },
  { name: 'Duolingo Super', typeKey: 'subscriptions.type.learning', categoryKey: 'subscriptions.category.study', periodValue: 1, periodUnit: 'year' },
  { name: 'NYTimes', typeKey: 'subscriptions.type.news', categoryKey: 'subscriptions.category.personal', periodValue: 1, periodUnit: 'month' },
  { name: 'Epic Games Unreal Subscription', typeKey: 'subscriptions.type.software', categoryKey: 'subscriptions.category.development', periodValue: 1, periodUnit: 'month' },
  { name: 'Vercel Pro', typeKey: 'subscriptions.type.server', categoryKey: 'subscriptions.category.development', periodValue: 1, periodUnit: 'month' },
  { name: 'Netlify Pro', typeKey: 'subscriptions.type.server', categoryKey: 'subscriptions.category.development', periodValue: 1, periodUnit: 'month' },
  { name: 'Hetzner Cloud', typeKey: 'subscriptions.type.server', categoryKey: 'subscriptions.category.development', periodValue: 1, periodUnit: 'month' },
  { name: 'Namecheap domain', typeKey: 'subscriptions.type.domain', categoryKey: 'subscriptions.category.development', periodValue: 1, periodUnit: 'year' },
  { name: 'GoDaddy domain', typeKey: 'subscriptions.type.domain', categoryKey: 'subscriptions.category.development', periodValue: 1, periodUnit: 'year' },
]

/** Whether a name in a conversation is one of these, matched the way the reader wrote it. */
export function findServiceTemplate(name: unknown): ServiceTemplate | null {
  if (typeof name !== 'string') return null
  const wanted = name.trim().toLocaleLowerCase()
  if (!wanted) return null
  return SERVICE_TEMPLATES.find((template) => template.name.toLocaleLowerCase() === wanted) ?? null
}

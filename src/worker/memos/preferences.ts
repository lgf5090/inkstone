import {
  MEMO_PREFERENCES_DEFAULTS,
  MEMO_REACTIONS_MAX,
  MEMO_TAG_RULE_MAX_COUNT,
  MEMO_TAG_RULE_MAX_LENGTH,
} from '@shared/memos/constants'
import {
  MEMO_VISIBILITIES,
  type MemoPreferences,
  type MemoPreferencesPatch,
  type MemoTagRule,
  type MemoTagRuleMode,
  type MemoVisibility,
} from '@shared/memos/types'
import { patternSafety } from '@shared/regex-safety'
import { ApiError } from '../lib/errors'

const REACTION_MAX_LENGTH = 64

const PREFERENCE_KEYS = new Set<string>([
  'defaultVisibility',
  'enableDoubleClickEdit',
  'saveMediaMetadata',
  'reactions',
  'tagRules',
  'enableLinkPreview',
  'enableReverseGeocoding',
])

const TAG_RULE_KEYS = new Set<string>(['pattern', 'mode', 'backgroundColor', 'blurContent'])

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const VISIBILITY_MESSAGE = `defaultVisibility must be one of ${MEMO_VISIBILITIES.join(', ')}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultPreferences(): MemoPreferences {
  return {
    ...MEMO_PREFERENCES_DEFAULTS,
    reactions: [...MEMO_PREFERENCES_DEFAULTS.reactions],
    tagRules: MEMO_PREFERENCES_DEFAULTS.tagRules.map((rule) => ({ ...rule })),
  }
}

function parseVisibility(value: unknown): MemoVisibility {
  if (typeof value !== 'string' || !(MEMO_VISIBILITIES as readonly string[]).includes(value)) {
    throw ApiError.badRequest(VISIBILITY_MESSAGE)
  }
  return value as MemoVisibility
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be a boolean`)
  return value
}

function parseReactions(value: unknown): string[] {
  if (!Array.isArray(value)) throw ApiError.badRequest('reactions must be an array of strings')
  if (value.length > MEMO_REACTIONS_MAX) {
    throw ApiError.badRequest(`reactions cannot contain more than ${MEMO_REACTIONS_MAX} entries`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw ApiError.badRequest(`reactions[${index}] must be a string`)
    const reaction = entry.trim()
    if (!reaction) throw ApiError.badRequest(`reactions[${index}] cannot be empty`)
    if (reaction.length > REACTION_MAX_LENGTH) {
      throw ApiError.badRequest(`reactions[${index}] cannot exceed ${REACTION_MAX_LENGTH} characters`)
    }
    if (seen.has(reaction)) throw ApiError.badRequest(`reactions[${index}] repeats "${reaction}"`)
    seen.add(reaction)
    return reaction
  })
}

function parseTagPattern(value: unknown, path: string): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${path}.pattern must be a string`)
  if (!value.trim()) throw ApiError.badRequest(`${path}.pattern cannot be empty`)
  if (value.length > MEMO_TAG_RULE_MAX_LENGTH) {
    throw ApiError.badRequest(`${path}.pattern cannot exceed ${MEMO_TAG_RULE_MAX_LENGTH} characters`)
  }
  return value
}

function parseTagMode(value: unknown, path: string): MemoTagRuleMode {
  if (value !== 'exact' && value !== 'regex') {
    throw ApiError.badRequest(`${path}.mode must be exact or regex`)
  }
  return value
}

function parseTagColor(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw ApiError.badRequest(
      `${path}.backgroundColor must be null or a #RGB, #RRGGBB or #RRGGBBAA hex color`,
    )
  }
  return value
}

function parseTagBlur(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${path}.blurContent must be a boolean`)
  return value
}

function assertSafeRegex(pattern: string, path: string): void {
  const refusal = patternSafety(pattern, MEMO_TAG_RULE_MAX_LENGTH)
  if (refusal === 'unsafe') {
    throw ApiError.badRequest(`${path}.pattern is too complex to run safely`)
  }
  if (refusal === 'syntax') {
    throw ApiError.badRequest(`${path}.pattern is not a valid regular expression`)
  }
  try {
    new RegExp(pattern)
  } catch {
    throw ApiError.badRequest(`${path}.pattern is not a valid regular expression`)
  }
}

function parseTagRule(value: unknown, path: string): MemoTagRule {
  if (!isRecord(value)) throw ApiError.badRequest(`${path} must be an object`)
  for (const key of Object.keys(value)) {
    if (!TAG_RULE_KEYS.has(key)) throw ApiError.badRequest(`${path}.${key} is not a tag rule field`)
  }
  const pattern = parseTagPattern(value.pattern, path)
  const mode = parseTagMode(value.mode, path)
  const backgroundColor = parseTagColor(value.backgroundColor, path)
  const blurContent = parseTagBlur(value.blurContent, path)
  if (mode === 'regex') assertSafeRegex(pattern, path)
  return { pattern, mode, backgroundColor, blurContent }
}

function parseTagRules(value: unknown): MemoTagRule[] {
  if (!Array.isArray(value)) throw ApiError.badRequest('tagRules must be an array')
  if (value.length > MEMO_TAG_RULE_MAX_COUNT) {
    throw ApiError.badRequest(`tagRules cannot contain more than ${MEMO_TAG_RULE_MAX_COUNT} rules`)
  }
  return value.map((rule, index) => parseTagRule(rule, `tagRules[${index}]`))
}

function mergePreferences(
  current: MemoPreferences,
  patch: Readonly<Record<string, unknown>>,
): MemoPreferences {
  for (const key of Object.keys(patch)) {
    if (!PREFERENCE_KEYS.has(key)) throw ApiError.badRequest(`Unknown memo preference "${key}"`)
  }
  return {
    defaultVisibility: patch.defaultVisibility === undefined
      ? current.defaultVisibility
      : parseVisibility(patch.defaultVisibility),
    enableDoubleClickEdit: patch.enableDoubleClickEdit === undefined
      ? current.enableDoubleClickEdit
      : parseBoolean(patch.enableDoubleClickEdit, 'enableDoubleClickEdit'),
    saveMediaMetadata: patch.saveMediaMetadata === undefined
      ? current.saveMediaMetadata
      : parseBoolean(patch.saveMediaMetadata, 'saveMediaMetadata'),
    reactions: patch.reactions === undefined ? current.reactions : parseReactions(patch.reactions),
    tagRules: patch.tagRules === undefined ? current.tagRules : parseTagRules(patch.tagRules),
    enableLinkPreview: patch.enableLinkPreview === undefined
      ? current.enableLinkPreview
      : parseBoolean(patch.enableLinkPreview, 'enableLinkPreview'),
    enableReverseGeocoding: patch.enableReverseGeocoding === undefined
      ? current.enableReverseGeocoding
      : parseBoolean(patch.enableReverseGeocoding, 'enableReverseGeocoding'),
  }
}

function parseStoredPreferences(json: string): MemoPreferences | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  try {
    return mergePreferences(defaultPreferences(), value)
  } catch {
    return null
  }
}

export async function getMemoPreferences(
  db: D1Database,
  userId: string,
): Promise<MemoPreferences> {
  const row = await db
    .prepare('SELECT json FROM memos_preferences WHERE user_id = ?1')
    .bind(userId)
    .first<{ json: string }>()
  if (!row) return defaultPreferences()
  const stored = parseStoredPreferences(row.json)
  if (stored) return stored
  console.warn('[inkstone] Stored memo preferences could not be read; serving defaults')
  return defaultPreferences()
}

export async function patchMemoPreferences(
  db: D1Database,
  userId: string,
  patch: MemoPreferencesPatch,
): Promise<MemoPreferences> {
  if (!isRecord(patch)) throw ApiError.badRequest('Preferences must be a JSON object')
  const current = await getMemoPreferences(db, userId)
  const next = mergePreferences(current, patch)
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(
      `INSERT INTO memos_preferences (user_id, json, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify(next), now)
    .run()
  return next
}

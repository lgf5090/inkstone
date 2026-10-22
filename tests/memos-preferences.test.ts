// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MEMO_PREFERENCES_DEFAULTS,
  MEMO_REACTIONS_MAX,
  MEMO_TAG_RULE_MAX_COUNT,
  MEMO_TAG_RULE_MAX_LENGTH,
} from '../src/shared/memos/constants'
import type { MemoPreferencesPatch, MemoTagRule } from '../src/shared/memos/types'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { MEMOS_SCHEMA_STATEMENTS } from '../src/worker/memos/schema'
import { getMemoPreferences, patchMemoPreferences } from '../src/worker/memos/preferences'
import { memoPreferenceRoutes } from '../src/worker/routes/memos/preferences'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = 'user-owner'
const OTHER = 'user-other'
const PREFERENCES_URL = 'http://localhost/api/memos/preferences'
const COLOR_MESSAGE =
  'tagRules[0].backgroundColor must be null or a #RGB, #RRGGBB or #RRGGBBAA hex color'
const CORRUPT_MESSAGE = '[inkstone] Stored memo preferences could not be read; serving defaults'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MEMOS_SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  env = testBindings(db)
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) c.set('userId', userId)
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/memos/preferences', memoPreferenceRoutes)
})

afterEach(() => sqlite.close())

function rule(overrides: Partial<MemoTagRule> = {}): MemoTagRule {
  return { pattern: 'work', mode: 'exact', backgroundColor: null, blurContent: false, ...overrides }
}

function storedPreferences(userId = OWNER): { json: string; updated_at: number } | undefined {
  return sqlite
    .prepare('SELECT json, updated_at FROM memos_preferences WHERE user_id = ?')
    .get(userId) as { json: string; updated_at: number } | undefined
}

function insertStoredPreferences(json: string, userId = OWNER): void {
  sqlite
    .prepare('INSERT INTO memos_preferences (user_id, json, updated_at) VALUES (?, ?, ?)')
    .run(userId, json, 1)
}

async function getPreferences(userId: string | null = OWNER): Promise<Response> {
  return await app.request(
    PREFERENCES_URL,
    { headers: userId ? { 'x-test-user': userId } : {} },
    env,
  )
}

async function patchPreferences(patch: unknown, userId: string | null = OWNER): Promise<Response> {
  return await app.request(
    PREFERENCES_URL,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(userId ? { 'x-test-user': userId } : {}),
      },
      body: JSON.stringify(patch),
    },
    env,
  )
}

describe('memo preferences store', () => {
  it('serves the defaults for an account that never saved preferences', async () => {
    await expect(getMemoPreferences(db, OWNER)).resolves.toEqual(MEMO_PREFERENCES_DEFAULTS)
  })

  it('merges a partial patch over the defaults and persists the whole object', async () => {
    const patched = await patchMemoPreferences(db, OWNER, {
      defaultVisibility: 'public',
      reactions: ['👍', '🔥'],
      enableReverseGeocoding: true,
    })

    expect(patched).toEqual({
      ...MEMO_PREFERENCES_DEFAULTS,
      defaultVisibility: 'public',
      reactions: ['👍', '🔥'],
      enableReverseGeocoding: true,
    })
    const row = storedPreferences()
    expect(row).toBeDefined()
    expect(JSON.parse(row!.json)).toEqual(patched)
    expect(row!.updated_at).toBeGreaterThan(0)
    await expect(getMemoPreferences(db, OWNER)).resolves.toEqual(patched)
  })

  it('replaces list preferences instead of appending to them', async () => {
    await patchMemoPreferences(db, OWNER, { reactions: ['🎉'] })
    const patched = await patchMemoPreferences(db, OWNER, { reactions: ['🔥'] })
    expect(patched.reactions).toEqual(['🔥'])
  })

  it('round-trips tag rules', async () => {
    const tagRules: MemoTagRule[] = [
      rule({ pattern: 'work', backgroundColor: '#abc', blurContent: true }),
      rule({ pattern: '^secret-\\d+$', mode: 'regex', backgroundColor: '#11223344' }),
      rule({ pattern: 'private', backgroundColor: null }),
    ]

    const patched = await patchMemoPreferences(db, OWNER, { tagRules })

    expect(patched.tagRules).toEqual(tagRules)
    await expect(getMemoPreferences(db, OWNER)).resolves.toEqual({
      ...MEMO_PREFERENCES_DEFAULTS,
      tagRules,
    })
  })

  it('round-trips the transcription settings and normalises blanks', async () => {
    const patched = await patchMemoPreferences(db, OWNER, {
      transcriptionProviderId: 'provider-1',
      transcriptionModel: 'whisper-1',
      transcriptionLanguage: ' zh-CN ',
      transcriptionPrompt: '  Inkstone, memo  ',
    })
    expect(patched.transcriptionProviderId).toBe('provider-1')
    expect(patched.transcriptionModel).toBe('whisper-1')
    expect(patched.transcriptionLanguage).toBe('zh-CN')
    expect(patched.transcriptionPrompt).toBe('Inkstone, memo')
    await expect(getMemoPreferences(db, OWNER)).resolves.toEqual(patched)

    const cleared = await patchMemoPreferences(db, OWNER, {
      transcriptionProviderId: '',
      transcriptionModel: null,
      transcriptionLanguage: '   ',
      transcriptionPrompt: '',
    })
    expect(cleared.transcriptionProviderId).toBeNull()
    expect(cleared.transcriptionModel).toBeNull()
    expect(cleared.transcriptionLanguage).toBe('')
    expect(cleared.transcriptionPrompt).toBe('')
  })

  it('accepts the documented maxima and every allowed hex length', async () => {
    const tagRules: MemoTagRule[] = [
      rule({ pattern: 'x'.repeat(MEMO_TAG_RULE_MAX_LENGTH), backgroundColor: '#abc' }),
      rule({ pattern: 'y'.repeat(MEMO_TAG_RULE_MAX_LENGTH), backgroundColor: '#A1B2C3' }),
      rule({ pattern: 'z'.repeat(MEMO_TAG_RULE_MAX_LENGTH), backgroundColor: '#12345678' }),
      ...Array.from({ length: MEMO_TAG_RULE_MAX_COUNT - 3 }, (_, index) => rule({ pattern: `tag-${index}` })),
    ]
    const reactions = [
      'r'.repeat(64),
      ...Array.from({ length: MEMO_REACTIONS_MAX - 1 }, (_, index) => `reaction-${index}`),
    ]

    const patched = await patchMemoPreferences(db, OWNER, { reactions, tagRules })

    expect(patched.reactions).toEqual(reactions)
    expect(patched.tagRules).toHaveLength(MEMO_TAG_RULE_MAX_COUNT)
  })

  it('merges a partial stored object over the defaults without writing', async () => {
    const json = JSON.stringify({ defaultVisibility: 'protected' })
    insertStoredPreferences(json)

    await expect(getMemoPreferences(db, OWNER)).resolves.toEqual({
      ...MEMO_PREFERENCES_DEFAULTS,
      defaultVisibility: 'protected',
    })
    expect(storedPreferences()?.json).toBe(json)
  })

  it('falls back to the defaults when the stored JSON does not parse', async () => {
    insertStoredPreferences('{not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(getMemoPreferences(db, OWNER)).resolves.toEqual(MEMO_PREFERENCES_DEFAULTS)
      expect(warn).toHaveBeenCalledWith(CORRUPT_MESSAGE)
      expect(storedPreferences()?.json).toBe('{not json')
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to the defaults when the stored values fail validation', async () => {
    const json = JSON.stringify({ defaultVisibility: 'everyone' })
    insertStoredPreferences(json)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(getMemoPreferences(db, OWNER)).resolves.toEqual(MEMO_PREFERENCES_DEFAULTS)
      expect(warn).toHaveBeenCalledWith(CORRUPT_MESSAGE)
      expect(storedPreferences()?.json).toBe(json)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not reuse one account preferences for another', async () => {
    await patchMemoPreferences(db, OWNER, { defaultVisibility: 'public', reactions: ['🔥'] })
    await expect(getMemoPreferences(db, OTHER)).resolves.toEqual(MEMO_PREFERENCES_DEFAULTS)

    await patchMemoPreferences(db, OTHER, { defaultVisibility: 'protected' })

    await expect(getMemoPreferences(db, OWNER)).resolves.toEqual({
      ...MEMO_PREFERENCES_DEFAULTS,
      defaultVisibility: 'public',
      reactions: ['🔥'],
    })
    await expect(getMemoPreferences(db, OTHER)).resolves.toEqual({
      ...MEMO_PREFERENCES_DEFAULTS,
      defaultVisibility: 'protected',
    })
    const { count } = sqlite
      .prepare('SELECT COUNT(*) AS count FROM memos_preferences')
      .get() as { count: number }
    expect(count).toBe(2)
  })
})

describe('memo preferences validation', () => {
  const cases: Array<{ name: string; patch: Record<string, unknown>; message: string }> = [
    {
      name: 'an unknown visibility',
      patch: { defaultVisibility: 'friends' },
      message: 'defaultVisibility must be one of private, protected, public',
    },
    {
      name: 'a non-boolean double-click switch',
      patch: { enableDoubleClickEdit: 'yes' },
      message: 'enableDoubleClickEdit must be a boolean',
    },
    {
      name: 'a non-boolean media metadata switch',
      patch: { saveMediaMetadata: 1 },
      message: 'saveMediaMetadata must be a boolean',
    },
    {
      name: 'a non-boolean link preview switch',
      patch: { enableLinkPreview: null },
      message: 'enableLinkPreview must be a boolean',
    },
    {
      name: 'a non-boolean reverse geocoding switch',
      patch: { enableReverseGeocoding: 'off' },
      message: 'enableReverseGeocoding must be a boolean',
    },
    {
      name: 'a reaction set that is not an array',
      patch: { reactions: '👍' },
      message: 'reactions must be an array of strings',
    },
    {
      name: 'a non-string reaction',
      patch: { reactions: ['👍', 1] },
      message: 'reactions[1] must be a string',
    },
    {
      name: 'an empty reaction',
      patch: { reactions: ['👍', '  '] },
      message: 'reactions[1] cannot be empty',
    },
    {
      name: 'a reaction longer than 64 characters',
      patch: { reactions: ['r'.repeat(65)] },
      message: 'reactions[0] cannot exceed 64 characters',
    },
    {
      name: 'a duplicate reaction',
      patch: { reactions: ['👍', '👍'] },
      message: 'reactions[1] repeats "👍"',
    },
    {
      name: 'too many reactions',
      patch: { reactions: Array.from({ length: MEMO_REACTIONS_MAX + 1 }, (_, index) => `r${index}`) },
      message: `reactions cannot contain more than ${MEMO_REACTIONS_MAX} entries`,
    },
    {
      name: 'a tag rule set that is not an array',
      patch: { tagRules: {} },
      message: 'tagRules must be an array',
    },
    {
      name: 'a tag rule that is not an object',
      patch: { tagRules: ['work'] },
      message: 'tagRules[0] must be an object',
    },
    {
      name: 'too many tag rules',
      patch: {
        tagRules: Array.from({ length: MEMO_TAG_RULE_MAX_COUNT + 1 }, () => rule()),
      },
      message: `tagRules cannot contain more than ${MEMO_TAG_RULE_MAX_COUNT} rules`,
    },
    {
      name: 'a missing tag pattern',
      patch: { tagRules: [{ mode: 'exact', backgroundColor: null, blurContent: false }] },
      message: 'tagRules[0].pattern must be a string',
    },
    {
      name: 'an empty tag pattern',
      patch: { tagRules: [rule({ pattern: '   ' })] },
      message: 'tagRules[0].pattern cannot be empty',
    },
    {
      name: 'an oversized tag pattern',
      patch: { tagRules: [rule({ pattern: 'x'.repeat(MEMO_TAG_RULE_MAX_LENGTH + 1) })] },
      message: `tagRules[0].pattern cannot exceed ${MEMO_TAG_RULE_MAX_LENGTH} characters`,
    },
    {
      name: 'an unknown tag rule mode',
      patch: { tagRules: [rule({ mode: 'glob' as MemoTagRule['mode'] })] },
      message: 'tagRules[0].mode must be exact or regex',
    },
    {
      name: 'an unsafe regex',
      patch: { tagRules: [rule({ pattern: '(a+)+$', mode: 'regex' })] },
      message: 'tagRules[0].pattern is too complex to run safely',
    },
    {
      name: 'a regex that does not parse',
      patch: { tagRules: [rule({ pattern: '[', mode: 'regex' })] },
      message: 'tagRules[0].pattern is not a valid regular expression',
    },
    {
      name: 'a CSS color name',
      patch: { tagRules: [rule({ backgroundColor: 'red' })] },
      message: COLOR_MESSAGE,
    },
    {
      name: 'a hex color of the wrong length',
      patch: { tagRules: [rule({ backgroundColor: '#12345' })] },
      message: COLOR_MESSAGE,
    },
    {
      name: 'a functional color',
      patch: { tagRules: [rule({ backgroundColor: 'rgb(0, 0, 0)' })] },
      message: COLOR_MESSAGE,
    },
    {
      name: 'a non-boolean blur flag',
      patch: { tagRules: [rule({ blurContent: 'yes' as unknown as boolean })] },
      message: 'tagRules[0].blurContent must be a boolean',
    },
    {
      name: 'an unknown tag rule field',
      patch: { tagRules: [{ ...rule(), color: '#fff' }] },
      message: 'tagRules[0].color is not a tag rule field',
    },
    {
      name: 'an unknown preference',
      patch: { fontSize: 14 },
      message: 'Unknown memo preference "fontSize"',
    },
    {
      name: 'an overlong transcription language',
      patch: { transcriptionLanguage: 'x'.repeat(17) },
      message: 'transcriptionLanguage cannot exceed 16 characters',
    },
    {
      name: 'an overlong transcription prompt',
      patch: { transcriptionPrompt: 'x'.repeat(2001) },
      message: 'transcriptionPrompt cannot exceed 2000 characters',
    },
  ]

  for (const { name, patch, message } of cases) {
    it(`rejects ${name}`, async () => {
      await expect(
        patchMemoPreferences(db, OWNER, patch as unknown as MemoPreferencesPatch),
      ).rejects.toMatchObject({ status: 400, message })
      expect(storedPreferences()).toBeUndefined()
    })
  }

  it('leaves saved preferences untouched when a later patch is refused', async () => {
    await patchMemoPreferences(db, OWNER, { defaultVisibility: 'public' })
    await expect(
      patchMemoPreferences(db, OWNER, { reactions: ['x', 'x'] }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(getMemoPreferences(db, OWNER)).resolves.toEqual({
      ...MEMO_PREFERENCES_DEFAULTS,
      defaultVisibility: 'public',
    })
  })
})

describe('memo preferences routes', () => {
  it('refuses both endpoints without a signed-in account', async () => {
    expect((await getPreferences(null)).status).toBe(401)
    expect((await patchPreferences({ defaultVisibility: 'public' }, null)).status).toBe(401)
  })

  it('round-trips a patch over HTTP for the signed-in account', async () => {
    const tagRules = [rule({ backgroundColor: '#123abc', blurContent: true })]
    const patched = await patchPreferences({
      defaultVisibility: 'public',
      reactions: ['👍', '🎉'],
      tagRules,
    })

    expect(patched.status).toBe(200)
    expect(await patched.json()).toEqual({
      ...MEMO_PREFERENCES_DEFAULTS,
      defaultVisibility: 'public',
      reactions: ['👍', '🎉'],
      tagRules,
    })

    const current = await getPreferences()
    expect(current.status).toBe(200)
    expect(await current.json()).toEqual({
      ...MEMO_PREFERENCES_DEFAULTS,
      defaultVisibility: 'public',
      reactions: ['👍', '🎉'],
      tagRules,
    })
  })

  it('answers 400 with the validation message', async () => {
    const response = await patchPreferences({ reactions: ['👍', '👍'] })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'bad_request', message: 'reactions[1] repeats "👍"' },
    })
  })

  it('serves each account its own preferences', async () => {
    await patchPreferences({ defaultVisibility: 'public' }, OWNER)

    const owner = await getPreferences(OWNER)
    const other = await getPreferences(OTHER)

    expect(await owner.json()).toMatchObject({ defaultVisibility: 'public' })
    expect(await other.json()).toEqual(MEMO_PREFERENCES_DEFAULTS)
  })
})

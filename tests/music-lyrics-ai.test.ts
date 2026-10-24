// @vitest-environment node
/**
 * AI lyric translation: the JSON contract, the cache keyed by the source text, and the endpoint's
 * separation of "no model", "no lyrics", "the model lost a line" and "the provider is down".
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings } from '../src/worker/env'
import { sha256Hex } from '../src/worker/lib/encoding'
import { errorResponse } from '../src/worker/lib/errors'
import { AssistantStore } from '../src/worker/assistant/store'
import { MusicStore } from '../src/worker/music/store'
import { lyricSourceLines } from '../src/worker/music/lyrics-ai'
import { musicRoutes } from '../src/worker/routes/music'
import { musicTrackKey } from '../src/shared/music/model'
import {
  buildMusicAiTranslationLrc,
  parseMusicAiTranslateBody,
  parseMusicAiTranslation,
  resolveMusicAiTargetLang,
} from '../src/shared/music/lyrics-ai'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const ALICE = 'user-alice'
const mocks = vi.hoisted(() => ({ userId: 'user-alice' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
  requireOwner: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

const LRC = '[00:01.00]你好\n[00:03.00]世界'

let sqlite: DatabaseSync
let env: ReturnType<typeof testBindings>
let music: MusicStore
let assistant: AssistantStore
const app = new Hono<AppBindings>()
app.onError((error, c) => errorResponse(c, error))
app.route('/api/music', musicRoutes)

function sse(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
const chunk = (text: string) =>
  frame({ choices: [{ index: 0, finish_reason: null, delta: { content: text } }] })
const stop = () => frame({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })

function stubTranslation(text: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(sse([chunk(text), stop()]), {
    headers: { 'content-type': 'text/event-stream' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function seedTrack(lrc = LRC): Promise<{ id: string, trackKey: string }> {
  const track = await music.upsertTrack({
    provider: 'netease',
    providerId: '42',
    title: 'Song',
    artists: [{ id: '1', name: 'Artist' }],
    album: 'Album',
    durationMs: 180_000,
  })
  const trackKey = musicTrackKey('netease', '42')
  await music.saveLyric({ trackKey, lrc, tlyric: '', yrc: '' })
  return { id: track.id, trackKey }
}

async function configureModel(): Promise<void> {
  const provider = await assistant.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  const model = await assistant.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  await assistant.saveSettings({ ...(await assistant.getSettings()), activeModelId: model.id })
}

function translate(trackId: string, body: unknown = { targetLang: 'en-US' }): Promise<Response> {
  return Promise.resolve(app.request(
    `/api/music/library/lyrics/${trackId}/ai-translate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
  ))
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  mocks.userId = ALICE
  music = new MusicStore(env.DB, ALICE)
  assistant = new AssistantStore(env.DB, ALICE, env)
})

afterEach(() => vi.unstubAllGlobals())

describe('the translation wire contract', () => {
  it('reads the body and rejects a language outside the two catalogs', () => {
    expect(parseMusicAiTranslateBody(undefined)).toEqual({ ok: true, targetLang: 'auto', force: false })
    expect(parseMusicAiTranslateBody({ targetLang: 'zh-CN', force: true })).toEqual({ ok: true, targetLang: 'zh-CN', force: true })
    expect(parseMusicAiTranslateBody({ targetLang: 'fr' }).ok).toBe(false)
    expect(parseMusicAiTranslateBody({ targetLang: 'en-US', force: 'yes' }).ok).toBe(false)
  })

  it('holds the model to one entry per line, in order', () => {
    const good = parseMusicAiTranslation('{"lines":[{"index":0,"text":"Hello"},{"index":1,"text":"World"}]}', 2)
    expect(good).toEqual({ ok: true, lines: ['Hello', 'World'] })
    expect(parseMusicAiTranslation('{"lines":[{"index":0,"text":"Hello"}]}', 2).ok).toBe(false)
    expect(parseMusicAiTranslation('{"lines":[{"index":1,"text":"a"},{"index":0,"text":"b"}]}', 2).ok).toBe(false)
    expect(parseMusicAiTranslation('{"lines":[{"index":0,"text":" "}]}', 1).ok).toBe(false)
    expect(parseMusicAiTranslation('{"lines":[{"index":0,"text":"' + 'x'.repeat(501) + '"}]}', 1).ok).toBe(false)
    expect(parseMusicAiTranslation('no json here', 1).ok).toBe(false)
  })

  it('keeps the provider timeline in the cached LRC', () => {
    expect(buildMusicAiTranslationLrc([
      { startTime: 1_002, text: 'a' },
      { startTime: 63_500, text: 'b' },
    ], ['甲', '乙'])).toBe('[00:01.00]甲\n[01:03.50]乙')
  })

  it('auto picks the opposite script, not the source script', () => {
    expect(resolveMusicAiTargetLang([{ startTime: 0, text: '你好世界' }], 'auto')).toBe('en-US')
    expect(resolveMusicAiTargetLang([{ startTime: 0, text: 'Hello world' }], 'auto')).toBe('zh-CN')
    expect(resolveMusicAiTargetLang([{ startTime: 0, text: '你好' }], 'zh-CN')).toBe('zh-CN')
  })
})

describe('POST /library/lyrics/:trackId/ai-translate', () => {
  it('answers 404 when the lyric has no timed text', async () => {
    const track = await seedTrack('')
    const response = await translate(track.id)
    expect(response.status).toBe(404)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('music_lyrics_unavailable')
  })

  it('answers 409 when no assistant model is active', async () => {
    const track = await seedTrack()
    const response = await translate(track.id)
    expect(response.status).toBe(409)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('music_ai_unavailable')
  })

  it('returns a cached translation whose source hash still matches, without calling a model', async () => {
    const track = await seedTrack()
    const source = lyricSourceLines({ lrc: LRC, yrc: '' })
    await music.putAiLyric({
      trackKey: track.trackKey,
      kind: 'translation',
      lang: 'en-US',
      sourceHash: await sha256Hex(JSON.stringify(source)),
      payload: '[00:01.00]Hello\n[00:03.00]World',
      model: 'Example one',
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await translate(track.id)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      lines: [{ startTime: 1_000, text: 'Hello' }, { startTime: 3_000, text: 'World' }],
      model: 'Example one',
      cached: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('translates once, caches by source hash, and serves the second request from the cache', async () => {
    const track = await seedTrack()
    await configureModel()
    const fetchMock = stubTranslation('{"lines":[{"index":0,"text":"Hello"},{"index":1,"text":"World"}]}')

    const first = await translate(track.id)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      lines: [{ startTime: 1_000, text: 'Hello' }, { startTime: 3_000, text: 'World' }],
      model: 'Example one',
      cached: false,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await music.getAiLyric(track.trackKey, 'translation', 'en-US')).not.toBeNull()

    const second = await translate(track.id)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ cached: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a mismatched line count with 422 and writes nothing', async () => {
    const track = await seedTrack()
    await configureModel()
    stubTranslation('{"lines":[{"index":0,"text":"Hello"}]}')

    const response = await translate(track.id)
    expect(response.status).toBe(422)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('music_ai_mismatch')
    expect(await music.getAiLyric(track.trackKey, 'translation', 'en-US')).toBeNull()
  })

  it('refuses a lyric beyond the 200-line ceiling before calling a model', async () => {
    const track = await seedTrack(Array.from({ length: 201 }, (_, index) => `[00:00.${String(index % 100).padStart(2, '0')}]line`).join('\n'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await translate(track.id)
    expect(response.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

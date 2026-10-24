// @vitest-environment jsdom
/**
 * The bridge between a worker tool and this tab's player.
 *
 * Two promises are under test. The worker turns an effect envelope into activity metadata without
 * handing the envelope to the model; the browser runs that effect once, on a local turn only, and
 * never from a thread opened later. The runner half is exercised with the same wire stub the other
 * assistant tests use, because "the model read {ok:true} and the row kept the effect" is a claim about
 * both bodies and cannot be read off either one alone.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent, MusicClientEffect, ToolActivity } from '@shared/assistant'
import { clipMusicClientEffect, isToolEffectEnvelope, MAX_MUSIC_EFFECT_PATH_CHARS, MAX_MUSIC_EFFECT_SEEK_MS, MAX_MUSIC_EFFECT_TRACK_REFS } from '@shared/assistant'
import type { MusicLibraryPayload } from '@shared/music/api'
import type { MusicTrack } from '@shared/music/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { isNamingRequest, namingAnswer } from './doubles/naming-pass'
import { useUi } from '../src/client/store/ui'
import { musicApi } from '../src/client/features/music/api'
import { useMusicUi } from '../src/client/features/music/store/ui'
import { runPendingMusicEffects } from '../src/client/features/music/use-tool-effects'

const player = vi.hoisted(() => ({
  queue: { tracks: [] as Array<{ id: string, provider: string, providerId: string }>, index: 0, mode: 'order' as const, original: null },
  status: 'idle' as 'idle' | 'playing' | 'paused' | 'loading',
  setQueue: vi.fn((tracks: Array<{ id: string }>) => tracks[0] ?? null),
  playTrack: vi.fn(async () => true),
  toggle: vi.fn(async () => true),
  pause: vi.fn(),
  next: vi.fn(async () => true),
  prev: vi.fn(async () => true),
  seek: vi.fn(),
  addNext: vi.fn(),
  removeFromQueue: vi.fn(async () => true),
}))

vi.mock('../src/client/features/music/store/player', () => ({
  useMusicPlayer: { getState: () => player },
}))

function track(providerId: string, id = `track-${providerId}`): MusicTrack {
  return {
    id,
    provider: 'netease',
    providerId,
    kind: 'song',
    title: `Track ${providerId}`,
    artists: [{ id: 'artist', name: 'Artist' }],
    album: 'Album',
    albumId: 'album',
    coverUrl: '',
    coverKey: '',
    durationMs: 180_000,
    format: 'mp3',
    bitrate: 320_000,
    size: 1_000,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: 'exhigh',
    createdAt: 0,
    updatedAt: 0,
  }
}

function activity(id: string, effect: MusicClientEffect): ToolActivity {
  return { id, name: 'music_play', status: 'success', effect }
}

function library(tracks: MusicTrack[] = []): MusicLibraryPayload {
  return {
    tracks,
    playlists: [],
    favorites: [],
    history: [],
    recent: [],
    downloads: [],
    uploads: [],
    subscriptions: [],
  }
}

let toast: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  sessionStorage.clear()
  player.queue = { tracks: [], index: 0, mode: 'order', original: null }
  player.status = 'idle'
  vi.clearAllMocks()
  vi.spyOn(musicApi, 'library').mockResolvedValue(library())
  toast = vi.spyOn(useUi.getState(), 'toast').mockReturnValue('toast')
  useMusicUi.setState({ lyricsOpen: false, queueOpen: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the effect envelope', () => {
  it('recognises only the effects this client can run', () => {
    expect(isToolEffectEnvelope({ effect: { kind: 'music.play', trackRefs: ['netease:1'], mode: 'replace' } })).toBe(true)
    expect(isToolEffectEnvelope({ effect: { kind: 'music.control', action: 'seek', value: 1_000 } })).toBe(true)
    expect(isToolEffectEnvelope({ effect: { kind: 'music.control', action: 'seek' } })).toBe(false)
    expect(isToolEffectEnvelope({ effect: { kind: 'music.play', trackRefs: [1], mode: 'replace' } })).toBe(false)
    expect(isToolEffectEnvelope({ effect: { kind: 'music.queue', action: 'delete' } })).toBe(false)
    expect(isToolEffectEnvelope({ result: { ok: true } })).toBe(false)
    expect(isToolEffectEnvelope(null)).toBe(false)
  })

  it('bounds refs, paths and a seek before they are stored', () => {
    const play = clipMusicClientEffect({
      kind: 'music.play',
      trackRefs: Array.from({ length: MAX_MUSIC_EFFECT_TRACK_REFS + 5 }, (_, index) => `netease:${index}`),
      mode: 'replace',
    })
    expect(play.kind === 'music.play' && play.trackRefs).toHaveLength(MAX_MUSIC_EFFECT_TRACK_REFS)

    const open = clipMusicClientEffect({ kind: 'music.open', view: 'cloud', path: 'x'.repeat(MAX_MUSIC_EFFECT_PATH_CHARS + 5) })
    expect(open.kind === 'music.open' && open.path).toHaveLength(MAX_MUSIC_EFFECT_PATH_CHARS)

    const seek = clipMusicClientEffect({ kind: 'music.control', action: 'seek', value: MAX_MUSIC_EFFECT_SEEK_MS + 1 })
    expect(seek.kind === 'music.control' && seek.value).toBe(MAX_MUSIC_EFFECT_SEEK_MS)
  })
})

describe('running a local turn', () => {
  it('plays resolved refs once, even when the same activity is seen again', async () => {
    const sample = track('1')
    vi.mocked(musicApi.library).mockResolvedValue(library([sample]))
    const turn = { tools: [activity('call-play-once', { kind: 'music.play', trackRefs: ['netease:1'], mode: 'replace' })] }

    await runPendingMusicEffects(turn, false)
    await runPendingMusicEffects(turn, false)

    expect(player.setQueue).toHaveBeenCalledTimes(1)
    expect(player.setQueue).toHaveBeenCalledWith([sample], { autoplay: true })
    expect(JSON.parse(sessionStorage.getItem('inkstone.music.appliedToolEffects') ?? '[]')).toContain('call-play-once')
  })

  it('never replays a history row and never runs another tab\'s turn', async () => {
    const effect: MusicClientEffect = { kind: 'music.play', trackRefs: ['netease:1'], mode: 'replace' }
    await runPendingMusicEffects(null, false)
    expect(player.setQueue).not.toHaveBeenCalled()

    await runPendingMusicEffects({ tools: [activity('call-remote', effect)] }, true)
    expect(player.setQueue).not.toHaveBeenCalled()
  })

  it('says so when a named track is not in the library', async () => {
    await runPendingMusicEffects({ tools: [activity('call-missing', { kind: 'music.play', trackRefs: ['netease:404'], mode: 'replace' })] }, false)
    expect(player.setQueue).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
  })

  it('uses the queue before reading the library, and appends in the model\'s order', async () => {
    const first = track('1')
    const second = track('2')
    player.queue = { tracks: [first, second], index: 0, mode: 'order', original: null }
    await runPendingMusicEffects({ tools: [activity('call-append', { kind: 'music.play', trackRefs: ['netease:1', 'netease:2'], mode: 'append' })] }, false)

    expect(musicApi.library).not.toHaveBeenCalled()
    expect(player.addNext.mock.calls.map(([entry]) => entry.id)).toEqual([second.id, first.id])
  })

  it('runs the player actions a control effect names', async () => {
    const current = track('1')
    player.queue = { tracks: [current], index: 0, mode: 'order', original: null }
    player.status = 'paused'
    await runPendingMusicEffects({
      tools: [
        activity('call-resume', { kind: 'music.control', action: 'resume' }),
        activity('call-seek', { kind: 'music.control', action: 'seek', value: 4_000 }),
      ],
    }, false)

    expect(player.toggle).toHaveBeenCalledTimes(1)
    expect(player.seek).toHaveBeenCalledWith(4_000)
  })

  it('clears the queue and opens the overlays this port has', async () => {
    await runPendingMusicEffects({ tools: [activity('call-clear', { kind: 'music.queue', action: 'clear' })] }, false)
    expect(player.setQueue).toHaveBeenCalledWith([], { autoplay: false })

    // The two overlays are mutually exclusive in the UI store, so they are opened one at a time.
    await runPendingMusicEffects({ tools: [activity('call-lyrics', { kind: 'music.open', view: 'lyrics' })] }, false)
    expect(useMusicUi.getState().lyricsOpen).toBe(true)
    await runPendingMusicEffects({ tools: [activity('call-queue', { kind: 'music.open', view: 'queue' })] }, false)
    expect(useMusicUi.getState().queueOpen).toBe(true)
    expect(useMusicUi.getState().lyricsOpen).toBe(false)
  })
})

function sse(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
const toolFrame = (id: string, name: string, args: unknown) => frame({
  choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }],
})
const finishFrame = (reason: string) => frame({ choices: [{ index: 0, finish_reason: reason, delta: {} }] })
const textFrame = (text: string) => frame({ choices: [{ index: 0, finish_reason: null, delta: { content: text } }] })

describe('the worker side of a playback tool', () => {
  let sqlite: DatabaseSync
  let env: Env
  let store: AssistantStore

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
    store = new AssistantStore(env.DB as D1Database, 'music-effect-user', env)
    const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
    const model = await store.createModel({ providerId: provider.id, model: 'example-model', maxOutputTokens: 256 })
    await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
  })

  afterEach(() => {
    sqlite.close()
  })

  it('puts the effect on the activity and only {ok:true} in front of the model', async () => {
    const conversation = await store.createConversation('Music')
    expect(await store.claimRun(conversation.id)).not.toBeNull()

    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (isNamingRequest(body)) return namingAnswer()
      requests.push(body)
      const frames = requests.length === 1
        ? [toolFrame('call-music', 'music_play', { trackRefs: ['netease:42', 'local:1'] }), finishFrame('tool_calls')]
        : [textFrame('Playing it now.'), finishFrame('stop')]
      return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const runner = new AssistantRunner({
      store,
      env,
      ftsEnabled: false,
      origin: 'http://localhost',
      settings: await store.getSettings(),
    })
    const events: ChatStreamEvent[] = []
    try {
      for await (const event of runner.chat({
        conversationId: conversation.id,
        message: 'Play these two.',
        signal: new AbortController().signal,
      })) {
        events.push(event)
      }
    } finally {
      vi.unstubAllGlobals()
    }

    const music = events
      .filter((event) => event.type === 'tool' && event.tool)
      .map((event) => event.tool)
      .find((tool) => tool?.name === 'music_play' && tool.status === 'success')
    expect(music?.effect).toEqual({ kind: 'music.play', trackRefs: ['netease:42', 'local:1'], mode: 'replace' })
    expect(music?.result).toContain('"ok": true')

    const toolMessage = ((requests[1]?.messages ?? []) as Array<{ role: string, content?: string }>)
      .find((entry) => entry.role === 'tool')
    expect(toolMessage?.content).toBe(JSON.stringify({ ok: true }))

    const done = events.find((event) => event.type === 'done') as { finalMessage?: { tools: ToolActivity[] } } | undefined
    const stored = done?.finalMessage?.tools.find((tool) => tool.name === 'music_play')
    expect(stored?.effect).toEqual({ kind: 'music.play', trackRefs: ['netease:42', 'local:1'], mode: 'replace' })
  })
})

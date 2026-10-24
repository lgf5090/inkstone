/**
 * Plays the effects a local assistant turn brings back.
 *
 * A tool runs in the worker, but the music is in this tab's player. The worker therefore answers a
 * playback tool with an effect, and this is the only place that turns one into a press: play, pause,
 * queue, open. The rules are deliberately narrow.
 *
 *  - Only the tab that asked carries it out. A turn being watched in another tab is not this tab's
 *    press to make, and a thread opened later is a record, not a replay.
 *  - Each activity id is claimed once, in memory and in sessionStorage, so a re-render, a reload of the
 *    same tab or a reconnect cannot play the same instruction twice.
 *  - A failure is said out loud with a toast. A silent no-op would leave the model's "playing" and the
 *    reader's silence saying opposite things.
 */
import { useEffect } from 'react'
import { isMusicClientEffect, type MusicClientEffect, type ToolActivity } from '@shared/assistant'
import { musicTrackKey, type MusicTrack } from '@shared/music/model'
import { useAssistant } from '../chat/assistant-store'
import { useUi } from '../../store/ui'
import { musicApi } from './api'
import { musicText } from './components/labels'
import { useMusicPlayer } from './store/player'
import { useMusicUi } from './store/ui'

const STORAGE_KEY = 'inkstone.music.appliedToolEffects'
const MAX_REMEMBERED_EFFECTS = 200

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    // A storage-denied frame throws on the access itself; the in-memory set is still a guard.
    return null
  }
}

function remembered(): string[] {
  const store = storage()
  if (!store) return []
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    // A half-written record is not worth trusting; the next effect simply starts a new list.
    return []
  }
}

const applied = new Set<string>(remembered())

function persist(): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify([...applied].slice(-MAX_REMEMBERED_EFFECTS)))
  } catch {
    // Private mode or a full quota. The in-memory set still stops a double run this session.
  }
}

/** Claims an activity once. Returns false when some earlier render already ran it. */
function claim(activityId: string): boolean {
  if (!activityId || applied.has(activityId)) return false
  applied.add(activityId)
  if (applied.size > MAX_REMEMBERED_EFFECTS * 2) {
    const keep = [...applied].slice(-MAX_REMEMBERED_EFFECTS)
    applied.clear()
    for (const id of keep) applied.add(id)
  }
  persist()
  return true
}

function fail(title: string): void {
  useUi.getState().toast({ title, tone: 'danger' })
}

function uniqueRefs(refs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ref of refs) {
    const value = ref.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function trackIndex(tracks: readonly MusicTrack[]): Map<string, MusicTrack> {
  const index = new Map<string, MusicTrack>()
  for (const track of tracks) {
    index.set(track.id, track)
    index.set(musicTrackKey(track.provider, track.providerId), track)
  }
  return index
}

/**
 * Turns the refs the model named into tracks the player can hold.
 *
 * The queue comes first because it is already in memory and is what "add this" usually means. The
 * library is read only when something is still missing; a ref that is in neither library nor queue is
 * reported rather than dropped silently.
 */
async function resolveTrackRefs(refs: readonly string[]): Promise<{ tracks: MusicTrack[], missing: string[] }> {
  const index = trackIndex(useMusicPlayer.getState().queue.tracks)
  let missing = refs.filter((ref) => !index.has(ref))
  if (missing.length) {
    const library = await musicApi.library()
    for (const [ref, track] of trackIndex([...library.tracks, ...library.favorites])) index.set(ref, track)
    missing = refs.filter((ref) => !index.has(ref))
  }
  const tracks: MusicTrack[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const track = index.get(ref)
    if (!track || seen.has(track.id)) continue
    seen.add(track.id)
    tracks.push(track)
  }
  return { tracks, missing }
}

async function play(effect: Extract<MusicClientEffect, { kind: 'music.play' }>): Promise<void> {
  const refs = uniqueRefs(effect.trackRefs)
  if (!refs.length) {
    fail(musicText('music.assistant.play_none'))
    return
  }
  const { tracks, missing } = await resolveTrackRefs(refs)
  if (!tracks.length) {
    fail(musicText('music.assistant.play_none'))
    return
  }
  if (missing.length) fail(musicText('music.assistant.play_missing', { count: missing.length }))
  const player = useMusicPlayer.getState()
  if (effect.mode === 'append') {
    // `addNext` inserts directly after the current track, so the list is added back to front to read
    // in the order the model named it.
    for (const track of [...tracks].reverse()) player.addNext(track)
    return
  }
  if (!player.setQueue(tracks, { autoplay: true })) fail(musicText('music.assistant.play_none'))
}

async function control(effect: Extract<MusicClientEffect, { kind: 'music.control' }>): Promise<void> {
  const player = useMusicPlayer.getState()
  const current = player.queue.tracks[player.queue.index] ?? null
  switch (effect.action) {
    case 'pause':
      if (!current) return fail(musicText('music.assistant.control_failed'))
      player.pause()
      return
    case 'resume':
      if (!current) return fail(musicText('music.assistant.control_failed'))
      if (player.status === 'playing' || player.status === 'loading') return
      if (!(await player.toggle())) fail(musicText('music.assistant.control_failed'))
      return
    case 'next':
      if (!(await player.next())) fail(musicText('music.assistant.control_failed'))
      return
    case 'prev':
      if (!(await player.prev())) fail(musicText('music.assistant.control_failed'))
      return
    case 'seek': {
      if (!current) return fail(musicText('music.assistant.control_failed'))
      const value = effect.value
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return fail(musicText('music.assistant.control_failed'))
      }
      player.seek(value)
    }
  }
}

async function queue(effect: Extract<MusicClientEffect, { kind: 'music.queue' }>): Promise<void> {
  const player = useMusicPlayer.getState()
  if (effect.action === 'clear') {
    player.setQueue([], { autoplay: false })
    return
  }
  const refs = uniqueRefs(effect.trackRefs ?? [])
  if (!refs.length) return fail(musicText('music.assistant.control_failed'))
  if (effect.action === 'remove') {
    let removed = 0
    const index = trackIndex(player.queue.tracks)
    for (const ref of refs) {
      const track = index.get(ref)
      if (track && await player.removeFromQueue(track.id)) removed++
    }
    if (!removed) fail(musicText('music.assistant.control_failed'))
    return
  }
  const { tracks } = await resolveTrackRefs(refs)
  if (!tracks.length) return fail(musicText('music.assistant.play_none'))
  for (const track of [...tracks].reverse()) player.addNext(track)
}

async function runEffect(effect: MusicClientEffect): Promise<void> {
  try {
    switch (effect.kind) {
      case 'music.play':
        return await play(effect)
      case 'music.control':
        return await control(effect)
      case 'music.queue':
        return await queue(effect)
      case 'music.open':
        // Only the overlays this port already has. A now-playing or cloud destination without its own
        // screen is left alone rather than opening the wrong thing.
        if (effect.view === 'lyrics') useMusicUi.getState().setLyricsOpen(true)
        else if (effect.view === 'queue') useMusicUi.getState().setQueueOpen(true)
        return
    }
  } catch {
    // The failure is the reader's to see: the model's words already say something happened.
    fail(musicText('music.assistant.effect_failed'))
  }
}

export interface MusicEffectTurn {
  tools: readonly ToolActivity[]
}

/**
 * Runs every unclaimed success effect on a turn.
 *
 * Exported rather than buried in the hook so the decision — which turn, which activity, once — can be
 * read and tested without a renderer.
 */
export async function runPendingMusicEffects(turn: MusicEffectTurn | null, remoteStreaming: boolean): Promise<void> {
  if (!turn || remoteStreaming) return
  // One at a time: a step can ask for a play and a pause, and running both at once would decide which
  // landed last by network timing rather than by the order the model asked for.
  for (const tool of turn.tools) {
    if (tool.status !== 'success' || !tool.effect || !isMusicClientEffect(tool.effect)) continue
    if (!claim(tool.id)) continue
    await runEffect(tool.effect)
  }
}

/** Watches the local turn for playback effects. Historical messages are never a turn. */
export function useMusicToolEffects(): void {
  const turn = useAssistant((state) => state.turn)
  const remoteStreaming = useAssistant((state) => state.remoteStreaming)
  useEffect(() => {
    void runPendingMusicEffects(turn, remoteStreaming)
  }, [turn, remoteStreaming])
}

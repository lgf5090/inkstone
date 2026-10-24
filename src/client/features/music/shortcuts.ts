/**
 * The music app's own keys, registered only while the music container is mounted.
 *
 * They go through the shared hotkey registry rather than a second window listener, so the shortcut
 * reference lists them and the registry's input/IME guards apply. `allowInOverlay` is on because the
 * full-screen lyric is a dialog by design and a reader there still expects the transport keys; a text
 * field inside any overlay is still excluded by the registry's editable-target check.
 *
 * Play/pause is `k` rather than a bare space: the registry formats a chord as named key parts, and a
 * space would render as an empty key cap in the reference. A focused button already answers Space.
 */
import { useEffect } from 'react'
import { registerAll, type Hotkey } from '../../lib/hotkeys'
import { useMusicLibrary } from './store/library'
import { selectCurrentTrack, useMusicPlayer } from './store/player'
import { useMusicUi } from './store/ui'
import { musicText } from './components/labels'

export const MUSIC_SHORTCUTS = {
  playPause: 'k',
  previous: 'shift+arrowleft',
  next: 'shift+arrowright',
  volumeUp: 'shift+arrowup',
  volumeDown: 'shift+arrowdown',
  favorite: 'f',
  lyrics: 'l',
  queue: 'q',
} as const

export const MUSIC_VOLUME_STEP = 0.05

function hasTrack(): boolean {
  return Boolean(selectCurrentTrack(useMusicPlayer.getState()))
}

export function musicHotkeys(): Hotkey[] {
  const group = (): string => musicText('music.shortcuts.group')
  return [
    {
      id: 'music-play-pause',
      combo: MUSIC_SHORTCUTS.playPause,
      description: () => musicText('music.playbar.play'),
      group,
      allowInOverlay: true,
      enabled: hasTrack,
      handler: () => { void useMusicPlayer.getState().toggle() },
    },
    {
      id: 'music-previous',
      combo: MUSIC_SHORTCUTS.previous,
      description: () => musicText('music.playbar.previous'),
      group,
      allowInOverlay: true,
      enabled: hasTrack,
      handler: () => { void useMusicPlayer.getState().prev() },
    },
    {
      id: 'music-next',
      combo: MUSIC_SHORTCUTS.next,
      description: () => musicText('music.playbar.next'),
      group,
      allowInOverlay: true,
      enabled: hasTrack,
      handler: () => { void useMusicPlayer.getState().next('user') },
    },
    {
      id: 'music-volume-up',
      combo: MUSIC_SHORTCUTS.volumeUp,
      description: () => musicText('music.shortcuts.volume_up'),
      group,
      allowInOverlay: true,
      handler: () => {
        const player = useMusicPlayer.getState()
        player.setVolume(player.volume + MUSIC_VOLUME_STEP)
      },
    },
    {
      id: 'music-volume-down',
      combo: MUSIC_SHORTCUTS.volumeDown,
      description: () => musicText('music.shortcuts.volume_down'),
      group,
      allowInOverlay: true,
      handler: () => {
        const player = useMusicPlayer.getState()
        player.setVolume(player.volume - MUSIC_VOLUME_STEP)
      },
    },
    {
      id: 'music-favorite',
      combo: MUSIC_SHORTCUTS.favorite,
      description: () => musicText('music.song.favorite'),
      group,
      allowInOverlay: true,
      enabled: hasTrack,
      handler: () => {
        const track = selectCurrentTrack(useMusicPlayer.getState())
        if (track) void useMusicLibrary.getState().toggleFavorite(track)
      },
    },
    {
      id: 'music-lyrics',
      combo: MUSIC_SHORTCUTS.lyrics,
      description: () => musicText('music.playbar.lyrics'),
      group,
      allowInOverlay: true,
      enabled: hasTrack,
      handler: () => useMusicUi.getState().toggleLyrics(),
    },
    {
      id: 'music-queue',
      combo: MUSIC_SHORTCUTS.queue,
      description: () => musicText('music.playbar.queue'),
      group,
      allowInOverlay: true,
      handler: () => useMusicUi.getState().toggleQueue(),
    },
  ]
}

/** Register the keys and return the disposer, for a mount effect or a test. */
export function registerMusicShortcuts(): () => void {
  return registerAll(musicHotkeys())
}

/** Mount-time registration for the music container. */
export function useMusicShortcuts(): void {
  useEffect(() => registerMusicShortcuts(), [])
}

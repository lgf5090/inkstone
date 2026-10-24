/** M3U parsing, matching and export for the tracks this app can already see. */
import { musicArtistNames } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'

export interface M3UEntry {
  durationMs: number | null
  artist: string
  title: string
  location: string
}

function splitDisplay(display: string): { artist: string; title: string } {
  const separator = display.indexOf(' - ')
  if (separator < 0) return { artist: '', title: display.trim() }
  return {
    artist: display.slice(0, separator).trim(),
    title: display.slice(separator + 3).trim(),
  }
}

export function parseM3U(text: string): M3UEntry[] {
  const entries: M3UEntry[] = []
  let pending: Omit<M3UEntry, 'location'> | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#EXTM3U')) continue
    if (line.startsWith('#EXTINF:')) {
      const body = line.slice('#EXTINF:'.length)
      const comma = body.indexOf(',')
      const seconds = Number(comma < 0 ? body : body.slice(0, comma))
      const display = comma < 0 ? '' : body.slice(comma + 1)
      const { artist, title } = splitDisplay(display)
      pending = {
        durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
        artist,
        title,
      }
      continue
    }
    if (line.startsWith('#')) continue
    if (pending) {
      entries.push({ ...pending, location: line })
      pending = null
    } else {
      const { artist, title } = splitDisplay(line)
      entries.push({ durationMs: null, artist, title, location: line })
    }
  }
  return entries.filter((entry) => entry.title !== '' || entry.location !== '')
}

export function buildM3U(tracks: readonly MusicTrack[]): string {
  const lines = ['#EXTM3U']
  for (const track of tracks) {
    const display = musicArtistNames(track) ? `${musicArtistNames(track)} - ${track.title}` : track.title
    lines.push(`#EXTINF:${Math.max(0, Math.round(track.durationMs / 1000))},${display}`)
    lines.push(`music/track/${track.id}`)
  }
  return lines.join('\n')
}

function key(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function locationId(location: string): string {
  const match = location.match(/music\/track\/([^/?#]+)/)
  return match?.[1] ?? ''
}

export interface M3UMatch {
  matched: MusicTrack[]
  unmatched: number
}

/** Match entries to the list the reader can see; no library-wide guess is made from another shelf. */
export function matchM3UTracks(entries: readonly M3UEntry[], tracks: readonly MusicTrack[]): M3UMatch {
  const byId = new Map(tracks.map((track) => [track.id, track]))
  const byDisplay = new Map<string, MusicTrack>()
  const byTitle = new Map<string, MusicTrack>()
  for (const track of tracks) {
    const title = key(track.title)
    byTitle.set(title, byTitle.get(title) ?? track)
    const display = key(`${musicArtistNames(track)} - ${track.title}`)
    byDisplay.set(display, byDisplay.get(display) ?? track)
  }

  const matched: MusicTrack[] = []
  const seen = new Set<string>()
  let unmatched = 0
  for (const entry of entries) {
    const fromLocation = byId.get(locationId(entry.location))
    const display = key(entry.artist ? `${entry.artist} - ${entry.title}` : entry.title)
    const track = fromLocation
      ?? byDisplay.get(display)
      ?? byTitle.get(key(entry.title))
    if (!track) {
      unmatched += 1
      continue
    }
    if (seen.has(track.id)) continue
    seen.add(track.id)
    matched.push(track)
  }
  return { matched, unmatched }
}

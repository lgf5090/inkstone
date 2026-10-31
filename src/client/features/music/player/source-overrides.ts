/**
 * Public playback sources for tracks that do not live in this app's music library.
 *
 * The blog reuses the music app's player, queue and audio engine, but its tracks are public files
 * served by the blog rather than library rows behind the authenticated stream route. The override is
 * keyed by track id and read where the player resolves a URL; an app session never installs one.
 */
const overrides = new Map<string, string>()
let libraryIntegration = true

/** A public surface has no music library; history and favourites must not be written there. */
export function setMusicLibraryIntegration(enabled: boolean): void {
  libraryIntegration = enabled
}

export function musicLibraryIntegrationEnabled(): boolean {
  return libraryIntegration
}

export function setMusicSourceOverrides(next: Readonly<Record<string, string>> | null): void {
  overrides.clear()
  if (!next) return
  for (const [id, url] of Object.entries(next)) {
    if (id && url) overrides.set(id, url)
  }
}

export function musicSourceOverride(trackId: string): string | null {
  return overrides.get(trackId) ?? null
}

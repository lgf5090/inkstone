/**
 * Choose between the official provider and the account's configured HTTP resolver.
 *
 * The resolver is only consulted when it is enabled and its coordinates are present; the priority
 * list decides whether it is tried before or after the official source. A failure on a custom-first
 * attempt falls through to the official source when that source is still allowed, because a resolver
 * outage must not make the library unplayable.
 */
import type { MusicSettings, MusicTrack } from '@shared/music/model'
import { resolveCustomSource, type CustomResolverConfig } from './custom/resolver'
import type { MusicStreamSource } from './types'

export interface MusicSourceResolver {
  /** `null` means the caller should use the official provider for this quality. */
  resolveCustom(quality: string): Promise<MusicStreamSource | null>
  readonly officialAllowed: boolean
}

export function createMusicSourceResolver(
  track: MusicTrack,
  settings: MusicSettings | null,
): MusicSourceResolver {
  const enabled = Boolean(settings?.customResolverEnabled && settings.customResolverUrl)
  const priority = settings?.sourcePriority ?? ['official', 'custom']
  const customFirst = enabled && priority.includes('custom')
  // A disabled resolver falls back to the official path even if the stored priority names custom
  // only; otherwise a stale toggle would make every track unplayable.
  const officialAllowed = priority.includes('official') || !enabled
  const config: CustomResolverConfig | null = customFirst && settings
    ? {
        url: settings.customResolverUrl,
        method: settings.customResolverMethod,
        params: settings.customResolverParams,
        responseUrlPath: settings.customResolverResponsePath,
        qualityMapping: settings.customResolverQualityMap,
      }
    : null
  return {
    officialAllowed,
    async resolveCustom(quality) {
      if (!config) return null
      return await resolveCustomSource({ track, quality, config })
    },
  }
}

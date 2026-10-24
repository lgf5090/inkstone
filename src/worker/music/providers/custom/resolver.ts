/**
 * The custom HTTP resolver: a user-configured endpoint that turns one track id into an audio URL.
 *
 * It is deliberately not a script host. The reference project let readers import JavaScript music
 * sources; executing that code inside the worker would turn a personal library into an arbitrary
 * code runner. This resolver only performs one guarded HTTP request and reads one JSON field.
 */
import { assertRelayableEndpoint, isBlockedTarget } from '@shared/ai-proxy-guard'
import { MUSIC_LIMITS } from '@shared/music/constants'
import type { MusicTrack } from '@shared/music/model'
import { outbound } from '../../../lib/outbound'
import { MusicProviderError, type MusicStreamSource } from '../types'

export interface CustomResolverConfig {
  url: string
  method: 'GET' | 'POST'
  params: Record<string, string>
  responseUrlPath: string
  qualityMapping: Record<string, string>
}

export interface CustomResolverInput {
  track: MusicTrack
  quality: string
  config: CustomResolverConfig
}

const PLACEHOLDER = /\{(id|quality|title|artist|album)\}/g

function expand(value: string, track: MusicTrack, quality: string): string {
  return value.replace(PLACEHOLDER, (_match, name: string) => {
    switch (name) {
      case 'id': return track.providerId
      case 'quality': return quality
      case 'title': return track.title
      case 'artist': return track.artists.map((artist) => artist.name).join(', ')
      case 'album': return track.album
      default: return ''
    }
  })
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value
  let cursor: unknown = value
  for (const segment of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function sourceUrlOf(payload: unknown, path: string): string {
  const value = readPath(payload, path)
  if (typeof value !== 'string' || !value.trim()) {
    throw new MusicProviderError(502, 'source_unavailable', 'The custom resolver returned no audio address')
  }
  let url: URL
  try {
    url = assertRelayableEndpoint(value.trim())
  } catch (error) {
    throw new MusicProviderError(
      502,
      'source_unavailable',
      error instanceof Error ? error.message : 'The custom resolver returned an unusable address',
    )
  }
  if (isBlockedTarget(url.hostname)) {
    throw new MusicProviderError(502, 'source_unavailable', 'The custom resolver returned a blocked address')
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new MusicProviderError(502, 'source_unavailable', 'The custom resolver returned an unsupported port')
  }
  return url.toString()
}

function formatFromUrl(url: string): string {
  const extension = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''
  return ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'mp4'].includes(extension) ? extension : ''
}

export async function resolveCustomSource(input: CustomResolverInput): Promise<MusicStreamSource> {
  const { track, quality, config } = input
  let endpoint: URL
  try {
    endpoint = assertRelayableEndpoint(config.url)
  } catch (error) {
    throw new MusicProviderError(
      400,
      'invalid_resolver',
      error instanceof Error ? error.message : 'The custom resolver address is not usable',
    )
  }
  const resolverQuality = config.qualityMapping[quality] || quality
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.params)) {
    params[key] = expand(value, track, resolverQuality)
  }
  if (!Object.values(params).some((value) => value.includes(track.providerId))) {
    params.id ??= track.providerId
  }

  let requestUrl = endpoint.toString()
  const init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } = {
    method: config.method,
    headers: { accept: 'application/json' },
  }
  if (config.method === 'GET') {
    const search = new URLSearchParams(params)
    requestUrl += `${requestUrl.includes('?') ? '&' : '?'}${search.toString()}`
  } else {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(params)
  }

  const response = await outbound(requestUrl, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    timeoutMs: MUSIC_LIMITS.resolverTimeoutMs,
    maxBytes: MUSIC_LIMITS.resolverResponseBytes,
  })
  if (!response.ok) {
    throw new MusicProviderError(
      502,
      'source_unavailable',
      response.error || `The custom resolver answered ${response.status}`,
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(response.text)
  } catch {
    throw new MusicProviderError(502, 'source_unavailable', 'The custom resolver did not return JSON')
  }
  const url = sourceUrlOf(payload, config.responseUrlPath)
  return {
    url,
    expiresAt: 0,
    format: formatFromUrl(url) || track.format,
    bitrate: null,
    size: null,
    quality: resolverQuality,
    freeTrial: false,
  }
}

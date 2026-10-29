/** Deployment-level YouTube configuration: the upstream base, region and local quota budget. */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { YOUTUBE_DAILY_QUOTA_DEFAULT } from '@shared/youtube/model'

const DEFAULT_API_BASE = 'https://www.googleapis.com/youtube/v3'
const MAX_DAILY_QUOTA = 1_000_000

export interface YouTubeDeploymentConfig {
  base: string
  region: string | null
  limit: number
}

function configError(message: string): ApiError {
  return new ApiError(500, 'internal', message)
}

function isLoopbackHost(hostname: string): boolean {
  const name = hostname.toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

export function youtubeApiBase(env: Env): string {
  const raw = (env.YOUTUBE_API_BASE ?? '').trim() || DEFAULT_API_BASE
  let url: URL
  try {
    url = new URL(raw)
  }
  catch {
    throw configError('YOUTUBE_API_BASE must be an https URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw configError('YOUTUBE_API_BASE must use https (http is allowed only for a loopback host)')
  }
  if (url.username || url.password) throw configError('YOUTUBE_API_BASE may not carry credentials')
  if (url.search || url.hash) throw configError('YOUTUBE_API_BASE may not carry a query or fragment')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function youtubeRegion(env: Env): string | null {
  const region = (env.YOUTUBE_REGION_CODE ?? '').trim()
  if (!region) return null
  if (!/^[A-Z]{2}$/.test(region)) {
    throw configError('YOUTUBE_REGION_CODE must be two uppercase letters')
  }
  return region
}

export function youtubeDailyLimit(env: Env): number {
  const raw = (env.YOUTUBE_DAILY_QUOTA ?? '').trim()
  if (!raw) return YOUTUBE_DAILY_QUOTA_DEFAULT
  if (!/^\d+$/.test(raw)) {
    throw configError('YOUTUBE_DAILY_QUOTA must be an integer between 1 and 1000000')
  }
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DAILY_QUOTA) {
    throw configError('YOUTUBE_DAILY_QUOTA must be an integer between 1 and 1000000')
  }
  return limit
}

export function youtubeDeploymentConfig(env: Env): YouTubeDeploymentConfig {
  return {
    base: youtubeApiBase(env),
    region: youtubeRegion(env),
    limit: youtubeDailyLimit(env),
  }
}

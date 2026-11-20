import type { Env } from '../env'
import { meterAcrossIsolates, MusicShareLimiter, type SharedMeterResult } from '../music/share-limiter'

export class GithubLimiter extends MusicShareLimiter {}

export function meterGithubAcrossIsolates(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
): Promise<SharedMeterResult | null> {
  return meterAcrossIsolates(
    env,
    env.GITHUB_LIMITER,
    'github-budget',
    'https://github-limit.internal/meter',
    key,
    limit,
    windowMs,
  )
}

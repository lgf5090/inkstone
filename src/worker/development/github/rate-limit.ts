import type { Env } from '../../env'
import { ApiError } from '../../lib/errors'
import { createMinuteBudget } from '../../lib/rate-limit'
import { meterGithubAcrossIsolates } from '../../durable/github-limiter'

export interface GithubBudget {
  spend: (env: Env, userId: string) => Promise<void>
}

export function createGithubBudget(limit: number, name: string, message: string): GithubBudget {
  const isolate = createMinuteBudget(limit, message)
  return {
    async spend(env: Env, userId: string): Promise<void> {
      const shared = await meterGithubAcrossIsolates(env, `${name}:${userId}`, limit, 60_000)
      if (!shared) {
        isolate(userId)
        return
      }
      if (!shared.allowed) {
        throw new ApiError(429, 'too_many_attempts', message, {
          retryAfterSeconds: shared.retryAfter,
        })
      }
    },
  }
}

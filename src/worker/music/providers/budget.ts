/**
 * One per-account budget for every path that makes the worker call the music provider.
 *
 * Discovery, lyrics, account status, online playback and download slices each build a provider and
 * spend an upstream request; keeping the counter beside the provider factory is what stops a client
 * from bypassing discovery's old route-local limit through one of the other doors.
 */
import { createMinuteBudget } from '../../lib/rate-limit'

const PROVIDER_READ_BUDGET = 120
const PROVIDER_READ_MESSAGE = 'Too many music requests. Try again in a minute.'

export const spendProviderRead = createMinuteBudget(PROVIDER_READ_BUDGET, PROVIDER_READ_MESSAGE)

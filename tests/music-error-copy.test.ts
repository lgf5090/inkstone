// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/client/lib/api'
import {
  describeError,
  shouldRetryQrPoll,
} from '../src/client/features/music/pages/parts/P2QueryState'

describe('music failure details', () => {
  it('keeps the route reason beside the localized sentence', () => {
    const error = new ApiError(
      502,
      'music_provider_unavailable',
      '音乐服务暂时不可用',
      undefined,
      'Netease answered 8821',
    )
    expect(describeError(error)).toBe('音乐服务暂时不可用 (Netease answered 8821)')
  })

  it('does not repeat a reason that is already the message', () => {
    const error = new ApiError(400, 'bad_request', 'The request is invalid', undefined, 'The request is invalid')
    expect(describeError(error)).toBe('The request is invalid')
  })

  it('retries only gateway failures, a bounded number of times', () => {
    expect(shouldRetryQrPoll(new ApiError(502, 'music_provider_unavailable', 'unavailable'), 0)).toBe(true)
    expect(shouldRetryQrPoll(new ApiError(503, 'music_provider_unavailable', 'unavailable'), 2)).toBe(true)
    expect(shouldRetryQrPoll(new ApiError(504, 'music_provider_unavailable', 'unavailable'), 2)).toBe(true)
    expect(shouldRetryQrPoll(new ApiError(502, 'music_provider_unavailable', 'unavailable'), 3)).toBe(false)
    expect(shouldRetryQrPoll(new ApiError(400, 'bad_request', 'bad'), 0)).toBe(false)
    expect(shouldRetryQrPoll(new Error('offline'), 0)).toBe(false)
  })
})

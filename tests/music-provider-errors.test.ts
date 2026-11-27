// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/worker/lib/errors'
import { MusicProviderError } from '../src/worker/music/providers/types'
import { musicProviderErrorToApiError } from '../src/worker/routes/music'

describe('music provider error mapping', () => {
  it('turns an unexpected provider failure into a 502 instead of a 500', () => {
    const mapped = musicProviderErrorToApiError(new Error('upstream closed the socket'))
    expect(mapped).toBeInstanceOf(ApiError)
    expect(mapped).toMatchObject({ status: 502, code: 'music_provider_unavailable' })
  })

  it('keeps a provider refusal in the API vocabulary', () => {
    const mapped = musicProviderErrorToApiError(new MusicProviderError(404, 'not_found', 'No lyric'))
    expect(mapped).toMatchObject({ status: 404, code: 'not_found' })
  })
})

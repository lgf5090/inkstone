// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { ApiError } from '../src/client/lib/api'
import { describeXgetError } from '../src/client/features/development/xget/api'

beforeAll(async () => {
  await initI18n()
})

describe('the Xget error copy', () => {
  it('maps stable server codes with their details', () => {
    expect(
      describeXgetError(new ApiError(400, 'xget_token_length', 'English', { min: 8, max: 128 })),
    ).toBe(t('development.xget.error.token_length', { min: 8, max: 128 }))
    expect(
      describeXgetError(new ApiError(400, 'xget_invalid_origin', 'English', { origin: 'bad' })),
    ).toBe(t('development.xget.error.invalid_origin', { origin: 'bad' }))
    expect(
      describeXgetError(new ApiError(400, 'xget_unsupported_method', 'English', { method: 'TRACE' })),
    ).toBe(t('development.xget.error.unsupported_method', { method: 'TRACE' }))
    expect(describeXgetError(new ApiError(403, 'xget_demo_readonly', 'English'))).toBe(
      t('development.xget.error.demo_readonly'),
    )
  })

  it('does not append the raw English server detail for unknown xget codes', () => {
    const error = new ApiError(400, 'bad_request', '请求内容有误', undefined, 'English detail')
    expect(describeXgetError(error)).toBe('请求内容有误')
  })
})

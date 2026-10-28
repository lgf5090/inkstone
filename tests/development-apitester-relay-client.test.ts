// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildResolvedRequest, formatSize, tryParseJson } from '../src/client/features/development/api-tester/lib/relay-client'
import { defaultRequest } from '../src/shared/development/api-tester/state'
import type { HttpRequestConfig } from '../src/shared/development/api-tester/types'

function config(patch: Partial<HttpRequestConfig> = {}): HttpRequestConfig {
  return { ...defaultRequest(), ...patch }
}

describe('API Tester relay request builder', () => {
  it('applies variables, query params, duplicate headers and bearer auth', () => {
    const request = config({
      url: '{{base}}/users',
      headers: [
        { id: '1', key: 'X-Trace', value: '{{trace}}', enabled: true },
        { id: '2', key: 'x-trace', value: 'override', enabled: true },
        { id: '3', key: 'Off', value: 'no', enabled: false },
      ],
      params: [{ id: '4', key: 'q', value: '{{term}}', enabled: true }],
      auth: { ...defaultRequest().auth, type: 'bearer', token: '{{token}}' },
    })
    const resolved = buildResolvedRequest(request, [
      { key: 'base', value: 'https://api.example.com' },
      { key: 'trace', value: 't1' },
      { key: 'term', value: 'hello world' },
      { key: 'token', value: 'secret' },
    ], 'rest')
    expect(resolved.url).toBe('https://api.example.com/users?q=hello+world')
    expect(resolved.headers).toEqual([
      { key: 'x-trace', value: 'override' },
      { key: 'Authorization', value: 'Bearer secret' },
    ])
    expect(resolved.method).toBe('GET')
  })

  it('builds a GraphQL POST body and content type', () => {
    const request = config({ graphqlQuery: 'query { me }', graphqlVariables: '{"id":1}', auth: defaultRequest().auth })
    const resolved = buildResolvedRequest(request, [], 'graphql')
    expect(resolved.method).toBe('POST')
    expect(resolved.headers).toContainEqual({ key: 'Content-Type', value: 'application/json' })
    expect(JSON.parse(resolved.body ?? '{}')).toEqual({ query: 'query { me }', variables: { id: 1 } })
  })

  it('encodes form bodies and carries binary file ids', () => {
    const form = buildResolvedRequest(
      config({
        bodyType: 'form-urlencoded',
        formFields: [{ id: '1', key: 'a b', value: 'c&d', enabled: true }],
      }),
      [],
      'rest',
    )
    expect(form.body).toBe('a%20b=c%26d')
    expect(form.headers).toContainEqual({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' })

    const binary = buildResolvedRequest(
      config({ bodyType: 'binary', bodyFileId: 'file-1', bodyFileName: 'a.bin' }),
      [],
      'rest',
    )
    expect(binary.bodyFileId).toBe('file-1')
    expect(binary.body).toBeNull()
  })

  it('formats sizes and parses JSON safely', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(2 * 1024 * 1024)).toBe('2.00 MB')
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 })
    expect(tryParseJson('no')).toBeNull()
  })
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CODEGEN_LANGUAGES,
  generateCode,
  type CodegenRequest,
} from '../src/client/features/development/api-tester/lib/codegen'

function postRequest(overrides: Partial<CodegenRequest> = {}): CodegenRequest {
  return {
    method: 'POST',
    url: 'https://api.example.com/v1/items',
    headers: [
      { key: 'X-Trace', value: 'trace-1', enabled: true },
      { key: 'X-Disabled', value: 'hidden', enabled: false },
      { key: 'Content-Type', value: 'application/json', enabled: true },
    ],
    queryParams: [
      { key: 'page', value: '2', enabled: true },
      { key: 'q', value: 'hello world', enabled: true },
      { key: 'skip', value: 'yes', enabled: false },
    ],
    body: '{"title":"Ada","count":2}',
    bodyType: 'json',
    auth: { type: 'bearer', token: 'token-123' },
    ...overrides,
  }
}

describe('code generator', () => {
  it('exposes the reference language catalog with ids, labels and categories', () => {
    expect(CODEGEN_LANGUAGES.map((language) => language.id)).toEqual([
      'curl',
      'httpie',
      'wget',
      'javascript-fetch',
      'javascript-axios',
      'node-http',
      'python-requests',
      'python-httpx',
      'go-nethttp',
      'java-okhttp',
      'java-httpclient',
      'php-curl',
      'php-guzzle',
      'ruby-nethttp',
      'rust-reqwest',
      'csharp-httpclient',
      'swift-urlsession',
      'kotlin-okhttp',
      'dart-http',
      'clojure-cljhttp',
    ])
    for (const language of CODEGEN_LANGUAGES) {
      expect(language.label.trim().length).toBeGreaterThan(0)
      expect(language.category.trim().length).toBeGreaterThan(0)
      expect(typeof language.generate).toBe('function')
    }
  })

  it('renders a full cURL command with encoded query, headers, auth and body', () => {
    expect(generateCode('curl', postRequest())).toBe(
      `curl --location 'https://api.example.com/v1/items?page=2&q=hello%20world' \\
  --request 'POST' \\
  --header 'X-Trace: trace-1' \\
  --header 'Content-Type: application/json' \\
  --header 'Authorization: Bearer token-123' \\
  --data '{"title":"Ada","count":2}'`,
    )
  })

  for (const language of CODEGEN_LANGUAGES) {
    it(`${language.id} includes URL, query, headers, body and auth`, () => {
      const code = generateCode(language.id, postRequest())
      expect(code.length).toBeGreaterThan(0)
      expect(code).toContain('api.example.com/v1/items')
      expect(code).toContain('page=2')
      expect(code).toContain('q=hello%20world')
      expect(code).toContain('X-Trace')
      expect(code).toContain('trace-1')
      expect(code).toContain('application/json')
      expect(code).toContain('Authorization')
      expect(code).toContain('Bearer token-123')
      expect(code).toContain('Ada')
      expect(code.toLowerCase()).toContain('post')
      expect(code).not.toContain('X-Disabled')
      expect(code).not.toContain('skip=yes')
    })
  }

  it('escapes single quotes for shell, PHP and Ruby string literals', () => {
    const body = `It's "quoted" \\ line`
    const request = postRequest({ body, bodyType: 'raw' })

    expect(generateCode('curl', request)).toContain("--data 'It'\\''s \"quoted\" \\ line'")
    expect(generateCode('httpie', request)).toContain("--raw 'It'\\''s \"quoted\" \\ line'")
    expect(generateCode('php-curl', request)).toContain("'It\\'s \"quoted\" \\\\ line'")
    expect(generateCode('ruby-nethttp', request)).toContain("'It\\'s \"quoted\" \\\\ line'")
  })

  it('escapes double-quoted strings for JavaScript and Python', () => {
    const body = 'line "one"\npath\\two'
    const expected = 'line \\"one\\"\\npath\\\\two'
    expect(generateCode('javascript-fetch', postRequest({ body, bodyType: 'raw' }))).toContain(expected)
    expect(generateCode('python-requests', postRequest({ body, bodyType: 'raw' }))).toContain(expected)
  })

  it('uses Go raw strings and falls back to a double-quoted string for backticks', () => {
    const plain = generateCode('go-nethttp', postRequest({ body: 'plain body', bodyType: 'raw' }))
    expect(plain).toContain('`plain body`')

    const withBacktick = generateCode('go-nethttp', postRequest({ body: 'a`b', bodyType: 'raw' }))
    expect(withBacktick).toContain('"a`b"')
  })

  it('encodes Basic auth from username and password', () => {
    const encoded = Buffer.from('user:p@ss:word').toString('base64')
    const code = generateCode(
      'curl',
      postRequest({ auth: { type: 'basic', username: 'user', password: 'p@ss:word' } }),
    )
    expect(code).toContain(`Authorization: Basic ${encoded}`)
    expect(code).toContain('Authorization: Basic dXNlcjpwQHNzOndvcmQ=')
  })

  it('moves API key auth into a header or a query parameter', () => {
    const header = generateCode(
      'curl',
      postRequest({ auth: { type: 'apikey_header', keyName: 'X-API-Key', keyValue: 'secret value' } }),
    )
    expect(header).toContain('X-API-Key: secret value')
    expect(header).not.toContain('X-API-Key=')

    const query = generateCode(
      'curl',
      postRequest({ auth: { type: 'apikey_query', keyName: 'api_key', keyValue: 'secret value' } }),
    )
    expect(query).toContain('api_key=secret%20value')
    expect(query).not.toContain('Authorization')
  })

  it('omits authorization for auth type none and bearer without a token', () => {
    expect(generateCode('curl', postRequest({ auth: { type: 'none' } }))).not.toContain('Authorization')
    expect(generateCode('curl', postRequest({ auth: { type: 'bearer', token: '' } }))).not.toContain(
      'Authorization',
    )
  })

  it('resolves Content-Type from the body type when no header is supplied', () => {
    const cases: Array<[CodegenRequest['bodyType'], string]> = [
      ['json', 'application/json'],
      ['xml', 'application/xml'],
      ['form-data', 'multipart/form-data'],
      ['x-www-form-urlencoded', 'application/x-www-form-urlencoded'],
      ['raw', 'text/plain'],
    ]
    for (const [bodyType, contentType] of cases) {
      const request = postRequest({ headers: [], auth: undefined, body: 'payload', bodyType })
      expect(generateCode('java-okhttp', request)).toContain(`MediaType.parse("${contentType}")`)
    }
  })

  it('does not emit a body for empty or binary requests', () => {
    const empty = postRequest({ method: 'GET', body: '', bodyType: 'none' })
    expect(generateCode('curl', empty)).not.toContain('--data')
    expect(generateCode('javascript-fetch', empty)).not.toContain('body:')
    expect(generateCode('java-okhttp', empty)).toContain('.method("GET", null)')
    expect(generateCode('clojure-cljhttp', empty)).toContain(':method :get')

    for (const language of CODEGEN_LANGUAGES) {
      const binary = postRequest({ body: '', bodyType: 'binary' })
      expect(generateCode(language.id, binary), language.id).toContain(
        'Binary request body is not included in the generated code.',
      )
    }
    const binary = postRequest({ body: '', bodyType: 'binary' })
    expect(generateCode('curl', binary)).toContain('# Binary request body')
    expect(generateCode('java-okhttp', binary)).toContain('// Binary request body')
    expect(generateCode('clojure-cljhttp', binary)).toContain(';; Binary request body')
  })

  it('joins query parameters to an existing query string or a trailing question mark', () => {
    const existing = postRequest({
      url: 'https://api.example.com/search?existing=1',
      headers: [],
      auth: undefined,
      body: '',
      bodyType: 'none',
      queryParams: [{ key: 'q', value: 'a b', enabled: true }],
    })
    expect(generateCode('curl', existing)).toContain(
      'https://api.example.com/search?existing=1&q=a%20b',
    )

    const trailing = postRequest({
      url: 'https://api.example.com/search?',
      headers: [],
      auth: undefined,
      body: '',
      bodyType: 'none',
      queryParams: [{ key: 'q', value: 'a b', enabled: true }],
    })
    expect(generateCode('curl', trailing)).toContain('https://api.example.com/search?q=a%20b')

    const none = postRequest({
      url: 'https://api.example.com/search',
      queryParams: [],
      auth: undefined,
    })
    expect(generateCode('curl', none)).toContain("'https://api.example.com/search'")
  })

  it('returns an empty string for an unknown language id', () => {
    expect(generateCode('unknown-language', postRequest())).toBe('')
  })
})

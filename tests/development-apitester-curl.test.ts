// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseCurl } from '../src/client/features/development/api-tester/lib/curl-parser'

describe('cURL parser', () => {
  it('parses a bare URL into an empty GET request', () => {
    const { request, warnings } = parseCurl("curl 'https://api.example.com/users?page=1'")
    expect(warnings).toEqual([])
    expect(request.url).toBe('https://api.example.com/users?page=1')
    expect(request.method).toBe('GET')
    expect(request.bodyType).toBe('none')
    expect(request.body).toBe('')
    expect(request.headers).toEqual([])
    expect(request.params).toEqual([])
    expect(request.formFields).toEqual([])
    expect(request.auth.type).toBe('none')
  })

  it('handles single quotes, double quotes, escapes and line continuations', () => {
    const command = `curl "https://api.example.com/items" \\
  -H "X-Note: say \\"hi\\" \\\\ done" \\
  -H 'X-Path: C:\\tmp' \\
  -X PATCH`
    const { request, warnings } = parseCurl(command)
    expect(warnings).toEqual([])
    expect(request.url).toBe('https://api.example.com/items')
    expect(request.method).toBe('PATCH')
    expect(request.headers.map((header) => [header.key, header.value])).toEqual([
      ['X-Note', 'say "hi" \\ done'],
      ['X-Path', 'C:\\tmp'],
    ])
  })

  it('supports long request flags and a bare non-http URL fallback', () => {
    const long = parseCurl('curl --request PUT https://api.example.com/items/1')
    expect(long.warnings).toEqual([])
    expect(long.request.method).toBe('PUT')
    expect(long.request.url).toBe('https://api.example.com/items/1')

    const bare = parseCurl('curl example.com/api -X POST')
    expect(bare.warnings).toEqual([])
    expect(bare.request.url).toBe('example.com/api')
    expect(bare.request.method).toBe('POST')
  })

  it('deduplicates headers, drops content-length and moves bearer auth out of headers', () => {
    const command = `curl https://api.example.com/headers \\
  --header 'Content-Type: text/plain' \\
  -H 'content-type: application/json' \\
  -H 'Content-Length: 99' \\
  -H 'Authorization: Bearer abc.def' \\
  -H 'X-Test: one'`
    const { request, warnings } = parseCurl(command)
    expect(warnings).toEqual([])
    expect(request.headers.map((header) => [header.key, header.value])).toEqual([
      ['content-type', 'application/json'],
      ['X-Test', 'one'],
    ])
    expect(request.auth).toMatchObject({ type: 'bearer', token: 'abc.def' })
  })

  it('decodes a Basic authorization header into auth', () => {
    const encoded = Buffer.from('alice:p@ss:word').toString('base64')
    const { request, warnings } = parseCurl(
      `curl https://api.example.com/auth -H 'Authorization: Basic ${encoded}'`,
    )
    expect(warnings).toEqual([])
    expect(request.headers).toEqual([])
    expect(request.auth).toMatchObject({ type: 'basic', username: 'alice', password: 'p@ss:word' })
  })

  it('keeps auth untouched when a Basic header is not valid base64', () => {
    const { request, warnings } = parseCurl(
      "curl https://api.example.com/auth -H 'Authorization: Basic !!!'",
    )
    expect(warnings).toEqual([])
    expect(request.headers).toEqual([])
    expect(request.auth.type).toBe('none')
  })

  it('maps -u/--user to basic auth and keeps colons inside the password', () => {
    const { request, warnings } = parseCurl(
      "curl https://api.example.com/auth --user 'bob:p@ss:1'",
    )
    expect(warnings).toEqual([])
    expect(request.auth).toMatchObject({ type: 'basic', username: 'bob', password: 'p@ss:1' })
  })

  it('infers JSON and urlencoded bodies from -d/--data', () => {
    const json = parseCurl('curl https://api.example.com/items -X POST -d \'{"a": 1}\'')
    expect(json.warnings).toEqual([])
    expect(json.request.method).toBe('POST')
    expect(json.request.bodyType).toBe('json')
    expect(json.request.body).toBe('{"a": 1}')

    const form = parseCurl(
      "curl https://api.example.com/items -X POST --data 'a=1' --data 'b=two'",
    )
    expect(form.warnings).toEqual([])
    expect(form.request.bodyType).toBe('form-urlencoded')
    expect(form.request.body).toBe('a=1&b=two')
  })

  it('handles --data-raw and --data-binary', () => {
    const raw = parseCurl(
      "curl https://api.example.com/data -X POST --data-raw 'raw text' --data-binary 'more'",
    )
    expect(raw.warnings).toEqual([])
    expect(raw.request.method).toBe('POST')
    expect(raw.request.bodyType).toBe('raw')
    expect(raw.request.body).toBe('raw text&more')

    const json = parseCurl("curl https://api.example.com/data --data-raw '{\"a\":1}'")
    expect(json.warnings).toEqual([])
    expect(json.request.bodyType).toBe('json')
  })

  it('turns -F/--form fields into form-data and replaces duplicate keys', () => {
    const { request, warnings } = parseCurl(
      "curl https://api.example.com/form --form 'name=Ada' -F 'file=@/tmp/a.png' -F 'name=Grace'",
    )
    expect(warnings).toEqual([])
    expect(request.method).toBe('POST')
    expect(request.bodyType).toBe('form-data')
    expect(request.body).toBe('')
    expect(request.formFields.map((field) => [field.key, field.value])).toEqual([
      ['file', '@/tmp/a.png'],
      ['name', 'Grace'],
    ])
  })

  it('ignores structural no-op flags and consumes the arguments of output/flags with values', () => {
    const command =
      'curl https://api.example.com/skip -L -k --compressed -s -S -i -v -o out.txt ' +
      '--connect-timeout 5 -m 10 -A agent -e referer'
    const { request, warnings } = parseCurl(command)
    expect(warnings).toEqual([])
    expect(request.url).toBe('https://api.example.com/skip')
    expect(request.method).toBe('GET')
    expect(request.headers).toEqual([])
    expect(request.bodyType).toBe('none')
  })

  it('reports unknown flags with their flag text', () => {
    const { request, warnings } = parseCurl('curl https://api.example.com/unknown --nope -Z')
    expect(request.url).toBe('https://api.example.com/unknown')
    expect(warnings).toEqual([
      { code: 'unknown_flag', flag: '--nope' },
      { code: 'unknown_flag', flag: '-Z' },
    ])
  })

  it('reports a missing argument when a value flag ends the command', () => {
    expect(parseCurl('curl https://api.example.com/missing -H').warnings).toEqual([
      { code: 'missing_flag_arg', flag: '-H' },
    ])
    expect(parseCurl('curl https://api.example.com/missing --data').warnings).toEqual([
      { code: 'missing_flag_arg', flag: '--data' },
    ])
  })
})

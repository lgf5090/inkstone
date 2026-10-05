// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { randomLocalId } from '../src/client/lib/random-id'
import { friendlyError } from '../src/worker/backup/common'
import { buildSiteInfo } from '../src/worker/lib/session-info'
import { withSecurityHeaders } from '../src/worker/lib/security-headers'
import { makeD1 } from './doubles/d1-sqlite'
import type { Env } from '../src/worker/env'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

it('mints local identifiers without Math.random', () => {
  const ids = new Set(Array.from({ length: 500 }, () => randomLocalId()))
  expect(ids.size).toBe(500)
  expect(randomLocalId('upload').startsWith('upload-')).toBe(true)
  for (const file of ['src/client/lib/api.ts', 'src/client/store/notes.ts', 'src/client/editor/paste.ts']) {
    expect(read(`../${file}`), `${file} still guesses with Math.random`).not.toContain('Math.random')
  }
})

it('keeps third-party error text from carrying credentials into D1 and the UI', () => {
  const leaked = friendlyError(new Error(
    'PUT https://user:hunter2@host.example/dst failed: Bearer abcdef1234567890 line2\r\nline3',
  ))
  expect(leaked).not.toContain('hunter2')
  expect(leaked).not.toContain('abcdef1234567890')
  expect(leaked).not.toContain('\r')
  expect(leaked.length).toBeLessThanOrEqual(240)
  // The curated hints stay, because they are what tells an operator what to fix.
  expect(friendlyError(new Error('SignatureDoesNotMatch'))).toMatch(/Signature mismatch/)
})

it('answers an unauthenticated session call without the version or the binding matrix', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  sqlite.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)')
  const env = {
    DB: makeD1(sqlite),
    FILES: {},
    FILES_KV: {},
    SYNC_HUB: {},
    APP_NAME: 'Inkstone',
  } as unknown as Env
  const anonymous = await buildSiteInfo(env, false)
  expect(anonymous.version).toBeUndefined()
  expect(anonymous.r2Enabled).toBe(false)
  expect(anonymous.kvEnabled).toBe(false)
  expect(anonymous.attachmentStorage).toBeNull()
  expect(anonymous.realtimeEnabled).toBe(false)
  expect(anonymous.name).toBe('Inkstone')
  expect(anonymous.initialized).toBe(false)
})

it('keeps the OAuth/MCP responses inside the same header policy as the app', async () => {
  const hardened = withSecurityHeaders(
    Response.json({ error: 'invalid_request' }, { status: 400 }),
    'https://notes.example/oauth/token',
  )
  expect(hardened.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  expect(hardened.headers.get('X-Frame-Options')).toBe('DENY')
  expect(hardened.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(hardened.headers.get('Cache-Control')).toBe('no-store')
  expect((await hardened.json()).error).toBe('invalid_request')

  const index = read('../src/worker/index.ts')
  expect(index).toContain('withSecurityHeaders(response, oauthRequest.url)')
  expect(index).not.toContain('error_description: error.message')
})

it('falls back to read-only when a consent form submits no usable scope', () => {
  const authorize = read('../src/worker/routes/mcp-authorize.ts')
  expect(authorize).toContain('selected.length ? selected : [MCP_SCOPES.read]')
  expect(authorize).not.toContain('selected : parsed.scope')
})

it('deletes note copies from mcp_operations on both purge paths', () => {
    const notes = read('../src/worker/routes/notes.ts')
    expect(notes.match(/DELETE FROM mcp_operations/g)?.length).toBe(2)
    expect(notes).toContain('instr(mcp_operations.response_json, e.value) > 0')
    expect(notes).toContain('WHERE user_id = ?1 AND instr(response_json, ?2) > 0')
});

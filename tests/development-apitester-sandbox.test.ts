// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { executeScript } from '../src/client/features/development/api-tester/lib/script-vm'
import type { ScriptContext } from '../src/shared/development/api-tester/types'

function context(): ScriptContext {
  return {
    environment: { base: 'https://api.example.com' },
    variables: { base: 'https://api.example.com' },
    request: {
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: [{ id: '1', key: 'Accept', value: 'application/json', enabled: true }],
      params: [],
      body: '',
    },
    dynamic: { timestamp: 1, uuid: 'u', iso: '1970-01-01T00:00:00.000Z' },
  }
}

describe('API Tester QuickJS sandbox', () => {
  it('runs pre-script mutations', async () => {
    const result = await executeScript({
      mode: 'pre',
      script: `
        pm.variables.set('token', 'abc');
        pm.environment.set('base', 'https://staging.example.com');
        pm.request.headers.upsert({ key: 'X-Token', value: pm.variables.get('token') });
        pm.request.params.add({ key: 'q', value: '1' });
      `,
      context: context(),
    })
    expect(result.error).toBeUndefined()
    expect(result.variables.token).toBe('abc')
    expect(result.env.base).toBe('https://staging.example.com')
    expect(result.headers?.find((header) => header.key === 'X-Token')?.value).toBe('abc')
    expect(result.params?.find((param) => param.key === 'q')?.value).toBe('1')
  })

  it('collects passing and failing pm.test assertions', async () => {
    const ctx = context()
    ctx.response = {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true,"items":[1,2]}',
      durationMs: 10,
      sizeBytes: 20,
    }
    const result = await executeScript({
      mode: 'tests',
      script: `
        pm.test('status', () => pm.expect(pm.response.status).to.equal(200));
        pm.test('json', () => pm.expect(pm.response.json().ok).to.be.ok());
        pm.test('fails', () => pm.expect(pm.response.json().items).to.include(9));
      `,
      context: ctx,
    })
    expect(result.tests).toHaveLength(3)
    expect(result.tests.filter((test) => test.passed)).toHaveLength(2)
    expect(result.tests[2]?.error).toContain('include')
  })

  it('cannot see window or fetch', async () => {
    const result = await executeScript({
      mode: 'pre',
      script: `pm.variables.set('windowType', typeof window); pm.variables.set('fetchType', typeof fetch);`,
      context: context(),
    })
    expect(result.variables.windowType).toBe('undefined')
    expect(result.variables.fetchType).toBe('undefined')
  })

  it('stops an infinite loop at the deadline', async () => {
    const result = await executeScript({
      mode: 'pre',
      script: 'while (true) {}',
      context: context(),
      deadlineMs: 100,
    })
    expect(result.error).toBeTruthy()
  })

  it('reports a syntax error without executing', async () => {
    const result = await executeScript({ mode: 'pre', script: 'pm.test(', context: context() })
    expect(result.error).toContain('SyntaxError')
  })
})

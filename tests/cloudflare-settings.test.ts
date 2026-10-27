// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCloudflareBed, readJson, seedAccount, stubCloudflare, cfJson, TEST_USER } from './cloudflare-fixtures'

vi.mock('../src/worker/middleware/auth', () => ({
  requireClientHeader: async (_c: unknown, next: () => Promise<void>) => { await next() },
  loadSession: async (_c: unknown, next: () => Promise<void>) => { await next() },
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'u'.repeat(26))
    await next()
  },
}))

afterEach(() => vi.unstubAllGlobals())

async function send(bed: Awaited<ReturnType<typeof makeCloudflareBed>>, method: string, path: string, body?: unknown) {
  return bed.app.request(`/api/cloudflare${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }, bed.env)
}

describe('settings and tasks routes', () => {
  it('reports what the deployment actually has', async () => {
    const bed = await makeCloudflareBed()
    const response = await send(bed, 'GET', '/settings')
    expect(response.status).toBe(200)
    const body = await readJson<{ platform: string; r2: boolean; vault: boolean; version: string }>(response)
    expect(body.platform).toBe('cloudflare-workers')
    expect(body.r2).toBe(true)
    expect(body.vault).toBe(true)
    expect(body.version.length).toBeGreaterThan(0)
  })

  it('stores demo account ids and refuses a malformed one', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    const saved = await send(bed, 'PUT', '/settings/demo-accounts', { ids: [id] })
    expect(saved.status).toBe(200)
    const reread = await readJson<{ demo_account_ids: string }>(await send(bed, 'GET', '/settings'))
    expect(reread.demo_account_ids).toBe(id)
    const bad = await send(bed, 'PUT', '/settings/demo-accounts', { ids: ['not-an-id'] })
    expect(bad.status).toBe(400)
  })

  it('clears the module cache', async () => {
    const bed = await makeCloudflareBed()
    const response = await send(bed, 'POST', '/settings/cache/clear')
    expect(response.status).toBe(200)
    expect(await readJson<{ cleared: boolean }>(response)).toEqual({ cleared: true })
  })

  it('creates a task, refuses a bad cron, runs it and reads its history', async () => {
    const bed = await makeCloudflareBed()
    stubCloudflare(() => cfJson({ viewer: { accounts: [{ total: [], byModel: [], workers: [], pages: [] }] } }))
    const created = await send(bed, 'POST', '/tasks', { name: 'Daily', type: 'quota_report', cron: '0 8 * * *' })
    expect(created.status).toBe(201)
    const { task } = await readJson<{ task: { id: string } }>(created)

    const bad = await send(bed, 'POST', '/tasks', { name: 'Bad', type: 'quota_report', cron: '99 * * * *' })
    expect(bad.status).toBe(400)

    const list = await readJson<{ tasks: Array<{ id: string }> }>(await send(bed, 'GET', '/tasks'))
    expect(list.tasks.map((entry) => entry.id)).toEqual([task.id])

    const run = await send(bed, 'POST', `/tasks/${task.id}/run`)
    expect(run.status).toBe(200)
    expect(await readJson<{ status: string }>(run)).toMatchObject({ status: 'success' })

    const history = await readJson<{ executions: Array<{ status: string }> }>(await send(bed, 'GET', `/tasks/${task.id}/history`))
    expect(history.executions[0]?.status).toBe('success')

    const removed = await send(bed, 'DELETE', `/tasks/${task.id}`)
    expect(removed.status).toBe(200)
    expect((await readJson<{ tasks: unknown[] }>(await send(bed, 'GET', '/tasks'))).tasks).toEqual([])
  })

  it('cannot read or run another reader’s task', async () => {
    const bed = await makeCloudflareBed()
    await bed.env.DB.prepare(
      `INSERT INTO cloudflare_scheduled_task (id, user_id, name, type, cron, config, enabled, created_at, updated_at)
       VALUES (?, ?, 'Theirs', 'quota_report', '* * * * *', NULL, 1, ?, ?)`,
    ).bind('t'.repeat(26), 'o'.repeat(26), Date.now(), Date.now()).run()
    expect((await readJson<{ tasks: unknown[] }>(await send(bed, 'GET', '/tasks'))).tasks).toEqual([])
    const run = await send(bed, 'POST', `/tasks/${'t'.repeat(26)}/run`)
    expect(run.status).toBe(404)
  })
})

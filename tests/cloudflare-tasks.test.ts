// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTask,
  deleteTask,
  executeTask,
  getTask,
  listExecutions,
  listTasks,
  runDueCloudflareTasks,
  runTaskNow,
  updateTask,
} from '../src/worker/cloudflare/tasks'
import { makeCloudflareBed, seedAccount, stubCloudflare, cfJson, TEST_USER } from './cloudflare-fixtures'

afterEach(() => vi.unstubAllGlobals())

const GRAPHQL = {
  viewer: {
    accounts: [{
      total: [{ sum: { totalNeurons: 5 } }],
      byModel: [],
      workers: [],
      pages: [],
    }],
  },
}

function stubCloudflareForTasks(options: {
  kvKeys?: string[]
  tables?: string[]
  r2Objects?: Array<{ key: string; uploaded: string }>
  onDelete?: (path: string) => void
} = {}): void {
  stubCloudflare((url, init) => {
    if (url.pathname.endsWith('/graphql')) return Response.json({ data: GRAPHQL })
    if (url.pathname.endsWith('/keys')) {
      return cfJson((options.kvKeys ?? []).map((name) => ({ name })))
    }
    if (url.pathname.endsWith('/bulk') && init?.method === 'DELETE') {
      return cfJson(null)
    }
    if (url.pathname.endsWith('/query')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { sql?: string }
      if (body.sql?.includes('sqlite_master')) {
        return cfJson([{ results: (options.tables ?? ['notes']).map((name) => ({ name })) }])
      }
      return cfJson([{ results: [{ id: 1, title: 'A note' }] }])
    }
    if (url.pathname.includes('/objects/') && init?.method === 'DELETE') {
      options.onDelete?.(url.pathname)
      return Response.json({ success: true })
    }
    if (url.pathname.endsWith('/objects')) {
      return Response.json({ success: true, result: options.r2Objects ?? [] })
    }
    return new Response('not found', { status: 404 })
  })
}

describe('scheduled tasks', () => {
  it('creates, lists, edits and deletes a task, refusing a bad cron', async () => {
    const bed = await makeCloudflareBed()
    const id = await createTask(bed.env, TEST_USER, { name: 'Nightly', type: 'quota_report', cron: '0 3 * * *' })
    expect((await listTasks(bed.env, TEST_USER)).map((task) => task.name)).toEqual(['Nightly'])
    await updateTask(bed.env, TEST_USER, id, { enabled: false, name: 'Nightly report' })
    expect((await getTask(bed.env, TEST_USER, id))?.enabled).toBe(0)
    await expect(createTask(bed.env, TEST_USER, { name: 'Bad', type: 'quota_report', cron: '99 * * * *' })).rejects.toThrow(/cron/i)
    await expect(createTask(bed.env, TEST_USER, { name: 'Bad', type: 'nope', cron: '* * * * *' })).rejects.toThrow(/task type/i)
    await deleteTask(bed.env, TEST_USER, id)
    expect(await getTask(bed.env, TEST_USER, id)).toBeNull()
  })

  it('runs a quota report and records the execution either way', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER)
    stubCloudflareForTasks()
    const id = await createTask(bed.env, TEST_USER, { name: 'Quota', type: 'quota_report', cron: '*/5 * * * *' })
    const result = await runTaskNow(bed.env, TEST_USER, id)
    expect(result.status).toBe('success')
    const executions = await listExecutions(bed.env, TEST_USER, id)
    expect(executions[0]?.status).toBe('success')
    expect(executions[0]?.finished_at).toBeGreaterThan(0)
  })

  it('deletes KV keys under the configured prefix only', async () => {
    const bed = await makeCloudflareBed()
    const { id: accountId } = await seedAccount(bed, TEST_USER)
    const calls: string[] = []
    let deleted: unknown = null
    stubCloudflare((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/keys')) return cfJson([{ name: 'tmp/a' }, { name: 'tmp/b' }])
      if (url.pathname.endsWith('/bulk')) {
        deleted = JSON.parse(String(init?.body ?? 'null'))
        return cfJson(null)
      }
      return new Response('not found', { status: 404 })
    })
    const id = await createTask(bed.env, TEST_USER, {
      name: 'KV',
      type: 'kv_cleanup',
      cron: '0 4 * * *',
      config: { account_id: accountId, namespace_id: 'ns-1', key_prefix: 'tmp/' },
    })
    const result = await runTaskNow(bed.env, TEST_USER, id)
    expect(result.status).toBe('success')
    expect(result.detail).toContain('Deleted 2 keys')
    expect(deleted).toEqual(['tmp/a', 'tmp/b'])
    expect(calls.some((call) => call.includes('prefix=tmp%2F'))).toBe(true)
  })

  it('writes a D1 table dump into the deployment bucket', async () => {
    const bed = await makeCloudflareBed()
    const { id: accountId } = await seedAccount(bed, TEST_USER)
    stubCloudflareForTasks({ tables: ['notes'] })
    const id = await createTask(bed.env, TEST_USER, {
      name: 'D1',
      type: 'd1_backup',
      cron: '0 2 * * *',
      config: { account_id: accountId, database_id: 'db-1' },
    })
    const result = await runTaskNow(bed.env, TEST_USER, id)
    expect(result.status).toBe('success')
    const keys = [...bed.files.objects.keys()].filter((key) => key.startsWith('cloudflare/d1-backups/db-1/'))
    expect(keys.length).toBe(1)
    expect(keys[0]!.endsWith('/notes.jsonl')).toBe(true)
    expect(new TextDecoder().decode(bed.files.objects.get(keys[0]!))).toContain('"title":"A note"')
  })

  it('deletes only R2 objects older than the configured age', async () => {
    const bed = await makeCloudflareBed()
    const { id: accountId } = await seedAccount(bed, TEST_USER)
    const deleted: string[] = []
    stubCloudflareForTasks({
      r2Objects: [
        { key: 'backup/old', uploaded: '2020-01-01T00:00:00Z' },
        { key: 'backup/new', uploaded: new Date().toISOString() },
      ],
      onDelete: (path) => deleted.push(path),
    })
    const id = await createTask(bed.env, TEST_USER, {
      name: 'R2',
      type: 'r2_cleanup',
      cron: '0 5 * * *',
      config: { account_id: accountId, bucket: 'b', prefix: 'backup/', max_age_days: 7 },
    })
    const result = await runTaskNow(bed.env, TEST_USER, id)
    expect(result.status).toBe('success')
    expect(result.detail).toContain('Deleted 1 objects')
    expect(deleted.length).toBe(1)
    expect(deleted[0]).toContain('backup%2Fold')
  })

  it('records a refusal instead of pretending, and one task does not stop the next', async () => {
    const bed = await makeCloudflareBed()
    const { id: accountId } = await seedAccount(bed, TEST_USER)
    stubCloudflareForTasks()
    const bad = await createTask(bed.env, TEST_USER, {
      name: 'No prefix',
      type: 'kv_cleanup',
      cron: '0 6 * * *',
      config: { account_id: accountId, namespace_id: 'ns' },
    })
    const good = await createTask(bed.env, TEST_USER, {
      name: 'Quota',
      type: 'quota_report',
      cron: '* * * * *',
    })
    const badResult = await executeTask(bed.env, (await getTask(bed.env, TEST_USER, bad))!)
    expect(badResult.status).toBe('error')
    expect(badResult.detail).toMatch(/prefix/i)
    const goodResult = await executeTask(bed.env, (await getTask(bed.env, TEST_USER, good))!)
    expect(goodResult.status).toBe('success')
  })

  it('runs a due task once per minute, and never twice for the same fire', async () => {
    const bed = await makeCloudflareBed()
    stubCloudflareForTasks()
    const id = await createTask(bed.env, TEST_USER, { name: 'Every minute', type: 'quota_report', cron: '* * * * *' })
    const fire = Date.UTC(2026, 9, 27, 9, 41, 0)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(fire)
      await runDueCloudflareTasks(bed.env, fire)
      vi.setSystemTime(fire + 10_000)
      await runDueCloudflareTasks(bed.env, fire + 10_000)
      expect((await listExecutions(bed.env, TEST_USER, id)).length).toBe(1)
      vi.setSystemTime(fire + 60_000)
      await runDueCloudflareTasks(bed.env, fire + 60_000)
      expect((await listExecutions(bed.env, TEST_USER, id)).length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a reader’s tasks out of another reader’s list', async () => {
    const bed = await makeCloudflareBed()
    await createTask(bed.env, TEST_USER, { name: 'Mine', type: 'quota_report', cron: '0 0 * * *' })
    expect(await listTasks(bed.env, 'o'.repeat(26))).toEqual([])
    await expect(updateTask(bed.env, 'o'.repeat(26), 'nope', { enabled: false })).rejects.toThrow(/does not exist/i)
  })
})

/**
 * R2 snapshot files for the Prompt Optimizer.
 *
 * A backup is the module's own export JSON under `tools/PromptOptimizer/backup/{userId}/{id}.json`,
 * and a download is the same document under `txt/` or `json/`. Files are read back through the store
 * row, never by a key the browser supplies.
 */

import { PROMPT_OPTIMIZER_R2_PREFIX, type BackupRecord } from '@shared/tools/prompt-optimizer/types'
import { ApiError } from '../../lib/errors'
import { newId } from '../../lib/id'
import type { Env } from '../../env'
import type { PromptOptimizerStore } from './store'

export async function createBackup(input: {
  env: Env
  store: PromptOptimizerStore
  userId: string
  kind: 'manual'
}): Promise<BackupRecord> {
  if (!input.env.FILES) throw new ApiError(503, 'internal', 'This deployment has no file bucket')
  const payload = await input.store.exportAll()
  const body = JSON.stringify(payload, null, 2)
  const id = newId()
  const key = `${PROMPT_OPTIMIZER_R2_PREFIX}/backup/${input.userId}/${id}.json`
  const filename = `prompt-optimizer-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  await input.env.FILES.put(key, body, { httpMetadata: { contentType: 'application/json' } })
  return input.store.insertBackup({ id, filename, r2Key: key, bytes: body.length, kind: input.kind })
}

export async function readBackup(input: {
  env: Env
  store: PromptOptimizerStore
  id: string
}): Promise<{ payload: Record<string, unknown>; filename: string }> {
  if (!input.env.FILES) throw new ApiError(503, 'internal', 'This deployment has no file bucket')
  const backup = await input.store.getBackup(input.id)
  if (!backup) throw new ApiError(404, 'not_found', 'Backup not found')
  const object = await input.env.FILES.get(backup.r2Key)
  if (!object) throw new ApiError(404, 'not_found', 'Backup is missing from storage')
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await object.text()) as Record<string, unknown>
  } catch {
    throw new ApiError(422, 'bad_request', 'This backup is not valid JSON')
  }
  return { payload, filename: backup.filename }
}

export async function deleteBackup(input: {
  env: Env
  store: PromptOptimizerStore
  id: string
}): Promise<boolean> {
  const backup = await input.store.deleteBackup(input.id)
  if (!backup) return false
  if (input.env.FILES) await input.env.FILES.delete(backup.r2Key)
  return true
}

export async function exportText(input: {
  env: Env
  store: PromptOptimizerStore
  userId: string
  format: 'json' | 'txt'
  document: unknown
}): Promise<{ key: string; filename: string; body: string; contentType: string }> {
  if (!input.env.FILES) throw new ApiError(503, 'internal', 'This deployment has no file bucket')
  const id = newId()
  const filename = `prompt-optimizer-${id}.${input.format}`
  const key = `${PROMPT_OPTIMIZER_R2_PREFIX}/${input.format}/${input.userId}/${id}.${input.format}`
  const body = input.format === 'json'
    ? JSON.stringify(input.document, null, 2)
    : renderText(input.document)
  const contentType = input.format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
  await input.env.FILES.put(key, body, { httpMetadata: { contentType } })
  return { key, filename, body, contentType }
}

function renderText(document: unknown): string {
  const value = document as {
    records?: {
      chain_id?: string
      chainId?: string
      version?: number
      optimized_prompt?: string
      optimizedPrompt?: string
      created_at?: number
      createdAt?: number
      workspace?: string
      versions?: { version: number; optimizedPrompt: string; createdAt: number }[]
    }[]
    favorites?: { title: string; content: string; tags: string[] }[]
  }
  const lines: string[] = ['# Prompt Optimizer export', '']
  if (Array.isArray(value.records)) {
    lines.push('## History', '')
    const chains = new Map<string, {
      version: number
      prompt: string
      createdAt: number
      workspace: string
    }[]>()
    for (const record of value.records) {
      if (Array.isArray(record.versions)) {
        // Older backups stored chains; keep rendering them rather than dropping the section.
        const chainId = record.chainId ?? record.chain_id ?? 'unknown'
        for (const version of record.versions) {
          const list = chains.get(chainId) ?? []
          list.push({ version: version.version, prompt: version.optimizedPrompt, createdAt: version.createdAt, workspace: record.workspace ?? '' })
          chains.set(chainId, list)
        }
        continue
      }
      const chainId = record.chain_id ?? record.chainId ?? 'unknown'
      const list = chains.get(chainId) ?? []
      list.push({
        version: record.version ?? list.length + 1,
        prompt: record.optimized_prompt ?? record.optimizedPrompt ?? '',
        createdAt: record.created_at ?? record.createdAt ?? 0,
        workspace: record.workspace ?? '',
      })
      chains.set(chainId, list)
    }
    for (const [chainId, versions] of chains) {
      lines.push(`### Chain ${chainId}`)
      for (const version of [...versions].sort((a, b) => a.version - b.version)) {
        const stamp = version.createdAt ? new Date(version.createdAt).toISOString() : 'unknown time'
        lines.push(`--- v${version.version}${version.workspace ? ` [${version.workspace}]` : ''} (${stamp}) ---`)
        lines.push(version.prompt, '')
      }
    }
  }
  if (Array.isArray(value.favorites)) {
    lines.push('## Favorites', '')
    for (const favorite of value.favorites) {
      lines.push(`### ${favorite.title}${favorite.tags?.length ? ` [${favorite.tags.join(', ')}]` : ''}`)
      lines.push(favorite.content, '')
    }
  }
  return lines.join('\n')
}

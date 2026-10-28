import type {
  ImgbedChannel,
  ImgbedFile,
  ImgbedListResult,
  ImgbedTokenScope,
} from '@shared/imgbed/model'
import type { ImgbedPageSettings, ImgbedUploadSettings } from '@shared/imgbed/settings'
import { CLIENT_HEADER } from '@shared/constants'
import { request } from '../../lib/api'

export interface ImgbedConfigResponse {
  page: ImgbedPageSettings
  upload: Pick<ImgbedUploadSettings, 'maxFileSizeMB' | 'chunkThresholdMB' | 'partSizeMB' | 'loadBalance'>
  channels: { id: string; type: string; name: string; fixed: boolean }[]
  user: { id: string; role: string | null }
}

export interface ImgbedChannelResponse extends ImgbedChannel {
  hasPassword?: boolean
  hasToken?: boolean
}

export interface ImgbedToken {
  id: string
  name: string
  prefix: string
  scopes: ImgbedTokenScope[]
  expiresAt: number | null
  autoDelete: boolean
  owner: string
  createdAt: number
  lastUsedAt: number | null
}

export interface ImgbedStatsResponse {
  totalFiles: number
  totalBytes: number
  categoryStats: Record<string, number>
  accessStats: { normal: number; blocked: number }
  labelStats: Record<string, number>
  oldestAt: number | null
  newestAt: number | null
  lastUpdated: number | null
  uploadTrend: {
    labels: string[]
    total: number[]
    range: { startDate: string; endDate: string } | null
    groupBy: {
      category: { series: { name: string; total: number; data: number[] }[]; limited: boolean }
      directory: { series: { name: string; total: number; data: number[] }[]; limited: boolean }
    }
  }
}

export function imgbedQuery(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue
    search.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function imgbedApi<T>(path: string, options: Parameters<typeof request>[1] = {}): Promise<T> {
  return request<T>(path, options)
}

function uploadRequest(file: File, folder: string, nameType: string, channel: string, channelName: string, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<{ src: string; url?: string; publicUrl?: string; id?: string }[]> {
  const form = new FormData()
  form.append('file', file)
  const query = imgbedQuery({ uploadFolder: folder, uploadNameType: nameType, uploadChannel: channel, channelName })
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/imgbed/upload${query}`)
    xhr.setRequestHeader(CLIENT_HEADER, '1')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)) }
    xhr.onload = () => { const body = xhr.response as { error?: { message?: string } } | unknown[] | null; if (xhr.status >= 200 && xhr.status < 300) resolve(body as { src: string }[]); else reject(new Error((body as { error?: { message?: string } })?.error?.message ?? `Upload failed (${xhr.status})`)) }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}

export function imgbedUpload(
  file: File,
  folder: string,
  nameType: string,
  channel: string,
  channelName: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
  chunkThresholdMB = 20,
): Promise<{ src: string; url?: string; publicUrl?: string; id?: string }[]> {
  if (file.size > chunkThresholdMB * 1024 * 1024) return imgbedChunkedUpload(file, folder, nameType, channel, channelName, onProgress, signal)
  return uploadRequest(file, folder, nameType, channel, channelName, onProgress, signal)
}

async function imgbedChunkedUpload(
  file: File,
  folder: string,
  nameType: string,
  channel: string,
  channelName: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<{ src: string; url?: string; publicUrl?: string; id?: string }[]> {
  let init: { mode?: string; uploadId?: string; partSize?: number; totalParts?: number }
  try {
    init = await imgbedApi('/api/imgbed/uploads/init', { method: 'POST', body: { fileName: file.name, fileType: file.type || 'application/octet-stream', size: file.size, folder, nameType, channel, channelName } })
  } catch (error) {
    if (file.size <= 100 * 1024 * 1024) return uploadRequest(file, folder, nameType, channel, channelName, onProgress, signal)
    throw error
  }
  if (init.mode === 'single' || !init.uploadId || !init.partSize || !init.totalParts) {
    return uploadRequest(file, folder, nameType, channel, channelName, onProgress, signal)
  }
  const partSize = init.partSize
  const totalParts = init.totalParts
  const progress = new Array(totalParts).fill(0)
  let complete = false
  const update = (): void => { const sum = progress.reduce((a, b) => a + b, 0); onProgress(Math.round(sum / totalParts)) }
  const uploadPart = async (index: number): Promise<void> => {
    const start = index * partSize
    const chunk = file.slice(start, Math.min(start + partSize, file.size))
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `/api/imgbed/uploads/${init.uploadId}/parts/${index}`)
      xhr.setRequestHeader(CLIENT_HEADER, '1')
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) { progress[index] = Math.round((event.loaded / event.total) * 100); update() } }
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Part ${index + 1} failed (${xhr.status})`))
      xhr.onerror = () => reject(new Error(`Part ${index + 1} failed`))
      if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.send(chunk)
    })
    progress[index] = 100
    update()
  }
  try {
    let next = 0
    const workers = Array.from({ length: Math.min(1, totalParts) }, async () => {
      while (next < totalParts) {
        const index = next++
        await uploadPart(index)
      }
    })
    await Promise.all(workers)
    complete = true
    const result = await imgbedApi<{ src: string; url?: string; id?: string }>(`/api/imgbed/uploads/${init.uploadId}/complete`, { method: 'POST' })
    onProgress(100)
    return [result]
  } catch (error) {
    if (complete) throw error
    await imgbedApi(`/api/imgbed/uploads/${init.uploadId}`, { method: 'DELETE' }).catch(() => {})
    throw error
  }
}


export async function imgbedExternalUpload(url: string, folder: string, nameType: string): Promise<{ src: string; url?: string; id?: string }[]> {
  const form = new FormData()
  form.append('url', url)
  const query = imgbedQuery({ uploadChannel: 'external', uploadFolder: folder, uploadNameType: nameType })
  const response = await fetch(`/api/imgbed/upload${query}`, { method: 'POST', headers: { [CLIENT_HEADER]: '1' }, body: form })
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | unknown[] | null
  if (!response.ok) throw new Error((body as { error?: { message?: string } })?.error?.message ?? 'External link failed')
  return body as { src: string }[]
}

export async function imgbedFetchUrl(url: string): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch('/api/imgbed/fetch-url', {
    method: 'POST',
    headers: { [CLIENT_HEADER]: '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? 'The URL could not be fetched')
  }
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition) ?? /filename="?([^";]+)"?/i.exec(disposition)
  const fileName = match?.[1] ? decodeURIComponent(match[1]) : (new URL(url).pathname.split('/').pop() || 'pasted-file')
  return { blob: await response.blob(), fileName }
}

export async function imgbedDelete(id: string, folder = false): Promise<void> {
  await imgbedApi(`/api/imgbed/manage/files${imgbedQuery({ id, folder })}`, { method: 'DELETE' })
}

export async function imgbedMove(ids: string[], dist: string): Promise<void> {
  await imgbedApi('/api/imgbed/manage/files/move', { method: 'POST', body: { ids, dist } })
}

export async function imgbedRename(id: string, newId: string): Promise<ImgbedFile> {
  return imgbedApi('/api/imgbed/manage/files/rename', { method: 'POST', body: { id, newId } })
}

export async function imgbedSetAccess(ids: string[], listType: string, label?: string): Promise<void> {
  await imgbedApi('/api/imgbed/manage/files/access', { method: 'POST', body: { ids, listType, label } })
}

export async function imgbedFileLinks(id: string): Promise<{ kind: string; value: string }[]> {
  const result = await imgbedApi<{ links: { kind: string; value: string }[] }>(`/api/imgbed/manage/files/links${imgbedQuery({ id })}`)
  return result.links
}

export async function imgbedSetTags(id: string, tags: string[], action: 'set' | 'add' | 'remove' = 'add'): Promise<string[]> {
  const result = await imgbedApi<{ results: { tags: string[] }[] }>('/api/imgbed/manage/tags', { method: 'POST', body: { id, tags, action } })
  return result.results[0]?.tags ?? []
}

export async function imgbedList(params: Record<string, string | number | boolean | string[] | undefined>): Promise<ImgbedListResult> {
  return imgbedApi(`/api/imgbed/manage/list${imgbedQuery(params)}`)
}

export async function imgbedCopyLinks(ids: string[], format: string): Promise<string> {
  const result = await imgbedApi<{ links: string }>('/api/imgbed/manage/files/copy-links', { method: 'POST', body: { ids, format } })
  return result.links
}

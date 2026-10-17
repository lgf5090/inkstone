import type { RssFetchResult } from '@shared/rss/model'
import { CLIENT_HEADER } from '@shared/constants'
import type { ReaderUsage } from '@shared/types'
import type { ChatAttachment,
  AssistantSkill,
  AssistantSkillInput,
  AssistantSkillBundle,
  SkillImportResult,
  MessageFeedback,
} from '@shared/assistant'
import type { MarkdownBackupManifest } from '@shared/backup-format'
import type { ConversationShareInfo, PublicConversation } from '@shared/assistant'
import type {
  PublicSharePresence,
  SharePresencePosition,
  SharePresenceSession,
} from '@shared/share-presence'
import type {
  AppLocale,
  Attachment,
  AttachmentWithUsage,
  BackupRun,
  BackupTarget,
  BackupTargetInput,
  BackupTargetPatchInput,
  Backlink,
  CommunityTemplate,
  CommunityTemplateInput,
  Folder,
  GraphResponse,
  ImportResult,
  ListNotesResponse,
  McpAiSearchStatus,
  McpApiKey,
  McpSettingsInfo,
  Note,
  NoteVersion,
  NoteVersionMeta,
  PatchNoteBody,
  SearchDocumentsResponse,
  PasswordLoginResult,
  PublicUser,
  PublicNote,
  SearchResponse,
  SessionInfo,
  ShareInfo,
  ShareListItem,
  SyncResponse,
  Tag,
  TestConnectionResult,
  TotpRecoveryCodesResult,
  TotpLoginResult,
  TotpSetupInfo,
  TotpStatus,
  UpdateCheckResponse,
  UserSettings,
} from '@shared/types'
import type {
  AssistantAnswerVersion,
  AssistantMcpCatalogEntry,
  AssistantMcpProblem,
  AssistantMcpServer,
  AssistantMcpServerDetail,
  AssistantArtifact,
  AssistantConversation,
  ChatFolderNode,
  ChatProjectNode,
  ConversationTag,
  AssistantImportSummary,
  AssistantLimits,
  AssistantMemory,
  AssistantMessage,
  AssistantModel,
  AssistantNotification,
  AssistantProvider,
  AssistantProviderKey,
  AssistantSettings,
  AssistantUsage,
  AssistantStats,
  AssistantUsageOverview,
  AssistantVendorModel,
  Automation as AssistantAutomation,
  AutomationRun as AssistantAutomationRun,
  MemoryReview,
  PendingAction,
  Project as AssistantProject,
  Task as AssistantTask,
} from '@shared/assistant'
import { publishBroadcast } from './db'
import { randomLocalId } from './random-id'
import { getLocale, t, translateApiError } from './i18n'


export const CLIENT_ID = randomLocalId()

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /**
     * What the route actually said, kept next to the localised line rather than in place of it.
     *
     * A code the client has a mapping for answers with one sentence for every kind of mistake it covers —
     * "the request is invalid" covers an unset name and an over-long one alike — while the route usually
     * names the field it refused. Mapping the code used to throw that sentence away, so a form could only
     * repeat the generic refusal for a mistake it was able to point at. It is a detail line for a surface
     * that has one, never a toast headline: it is the server's own English, and no catalog key translates it.
     */
    readonly serverMessage?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  get isOffline(): boolean {
    return this.status === 0
  }
  get isAuth(): boolean {
    return this.status === 401
  }
  get isConflict(): boolean {
    return this.status === 409
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
  formData?: FormData
  timeoutMs?: number
  /**
   * Conditional GET/POST support for a caller that polls. `onEtag` is handed whatever the server
   * answered with, including on the 304 that carries no body, so the next beat can send it back.
   */
  ifNoneMatch?: string
  onEtag?: (etag: string | null) => void
  /** A question about *now* must not be answered from the cache; a stored "where is the talk" is a
   * different question's answer. */
  cache?: RequestCache
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, formData, timeoutMs, ifNoneMatch, onEtag, cache } = options

  const headers: Record<string, string> = {
    [CLIENT_HEADER]: '1',
    'X-Inkstone-Origin': CLIENT_ID,
    'Accept-Language': getLocale(),
  }
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch
  let payload: BodyInit | undefined
  if (formData) {
    payload = formData
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const timeoutController = timeoutMs && timeoutMs > 0 ? new AbortController() : null
  let timedOut = false
  let timeoutHandle = 0
  let detachCallerSignal: (() => void) | undefined
  if (timeoutController) {
    const abortFromCaller = () => timeoutController.abort(signal?.reason)
    if (signal?.aborted) abortFromCaller()
    else if (signal) {
      signal.addEventListener('abort', abortFromCaller, { once: true })
      detachCallerSignal = () => signal.removeEventListener('abort', abortFromCaller)
    }
    timeoutHandle = window.setTimeout(() => {
      timedOut = true
      timeoutController.abort()
    }, timeoutMs)
  }

  try {
    const response = await fetch(path, {
      method,
      headers,
      body: payload,
      signal: timeoutController?.signal ?? signal,
      credentials: 'same-origin',
      ...(cache ? { cache } : {}),
    })

    const notifyOtherTabs = method !== 'GET' && shouldNotifyOtherTabs(path)
    if (response.status === 204) {
      if (notifyOtherTabs) publishBroadcast({ type: 'local-write', clientId: CLIENT_ID })
      return undefined as T
    }

    // A 304 is not `ok` to fetch, so it has to be answered before the failure path below or every
    // "nothing moved" beat would surface as an error. It carries no body: the caller keeps what it
    // holds, and the ETag it already has is the one that just proved itself.
    if (response.status === 304) {
      onEtag?.(response.headers.get('ETag') ?? ifNoneMatch ?? null)
      return undefined as T
    }

    const isJson = isJsonResponse(response)
    let data: unknown = null
    let invalidJson = false
    if (isJson) {
      const raw = await response.text()
      if (raw.trim()) {
        try {
          data = JSON.parse(raw)
        } catch {
          invalidJson = true
        }
      }
    }

    if (!response.ok) {
      const error = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error
      const code = error?.code ?? 'unknown'
      const fallback = error?.message ?? t("api.request_failed_status", { status: response.status })
      throw new ApiError(
        response.status,
        code,
        translateApiError(code, fallback),
        error?.details,
        error?.message,
      )
    }

    if (invalidJson) {
      throw new ApiError(502, 'invalid_response', t("api.invalid_server_response"))
    }

    if (notifyOtherTabs) {
      publishBroadcast({ type: 'local-write', clientId: CLIENT_ID })
    }
    return (isJson ? data : await response.text()) as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (timedOut) throw new ApiError(0, 'request_timeout', t("api.request_timed_out"))
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiError(0, 'offline', t("api.no_network_connection"))
  } finally {
    if (timeoutHandle) window.clearTimeout(timeoutHandle)
    detachCallerSignal?.()
  }
}

function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'))
}

async function fetchDownload(path: string, fallbackName: string): Promise<{ response: Response; filename: string }> {
  let response: Response
  try {
    response = await fetch(path, {
      headers: {
        [CLIENT_HEADER]: '1',
        'X-Inkstone-Origin': CLIENT_ID,
        'Accept-Language': getLocale(),
      },
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'offline', t("api.no_network_connection"))
  }

  if (!response.ok) {
    const data = isJsonResponse(response)
      ? await response.json().catch(() => null)
      : null
    const error = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error
    const code = error?.code ?? 'unknown'
    const fallback = error?.message ?? t("api.request_failed_status", { status: response.status })
    throw new ApiError(
      response.status,
      code,
      translateApiError(code, fallback),
      error?.details,
    )
  }

  const disposition = response.headers.get('Content-Disposition') ?? ''
  const filename = /filename="([^"\r\n]+)"/i.exec(disposition)?.[1] ?? fallbackName
  return { response, filename }
}

async function saveDownload(format: 'json' | 'zip'): Promise<void> {
  if (format === 'zip') {
    const picker = (window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName: string
        types: Array<{ description: string; accept: Record<string, string[]> }>
      }) => Promise<FileSystemFileHandle>
    }).showSaveFilePicker
    if (picker) {
      let handle: FileSystemFileHandle
      try {
        handle = await picker.call(window, {
          suggestedName: `inkstone-backup-${new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 15)}.zip`,
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
        })
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return
        throw error
      }
      const { response } = await fetchDownload('/api/export?format=zip', 'inkstone-backup.zip')
      if (!response.body) throw new ApiError(0, 'unknown', t('api.no_network_connection'))
      const writable = await handle.createWritable()
      await response.body.pipeTo(writable)
      return
    }

    const { response, filename } = await fetchDownload('/api/export?format=zip', 'inkstone-backup.zip')
    await saveResponseDownload(response, filename)
    return
  }

  const { response, filename } = await fetchDownload('/api/export?format=json', 'inkstone-export.json')
  await saveResponseDownload(response, filename)
}

async function saveResponseDownload(response: Response, filename: string): Promise<void> {
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

function shouldNotifyOtherTabs(path: string): boolean {
  return /^\/api\/(?:notes(?:\/|$)|folders(?:\/|$)|tags(?:\/|$)|import(?:\?|$))/.test(path)
}


/** What the owner's own question answers: nothing, or where the show is and how long it may run — and in
 * either case how many browsers have been reading it lately (PR-M7). */
export type PresenceStatus = { running: false, viewers: number } | { running: true, expiresAt: number, presence: PublicSharePresence, viewers: number }

/**
 * Uploads one chat attachment with a byte counter.
 *
 * `XMLHttpRequest` rather than `request()`: fetch reports nothing while the body is going out, and a
 * multi-megabyte picture that appears to do nothing for ten seconds reads as a broken button.
 */
function uploadChatFileWithProgress(
  file: File,
  onProgress: (sent: number, total: number) => void,
  extractedText?: string,
): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    // The browser's own reading of a document, when it could make one; the server stores it beside the
    // bytes so the model is shown the contents on every turn rather than only the one that uploaded it.
    if (extractedText) form.append('text', extractedText)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/assistant/files')
    xhr.responseType = 'text'
    xhr.setRequestHeader(CLIENT_HEADER, '1')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    xhr.onload = () => {
      let parsed: { attachment?: ChatAttachment, error?: { message?: string } } = {}
      try {
        parsed = JSON.parse(xhr.responseText || '{}') as typeof parsed
      } catch {
        parsed = {}
      }
      if (xhr.status >= 200 && xhr.status < 300 && parsed.attachment) {
        onProgress(file.size, file.size)
        resolve(parsed.attachment)
        return
      }
      reject(new Error(parsed.error?.message || `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('The upload could not reach the server.'))
    xhr.onabort = () => reject(new Error('The upload was cancelled.'))
    xhr.send(form)
  })
}

/** Reads a stored file back with a byte counter, for the viewer's progress bar. */
async function downloadChatFileWithProgress(
  id: string,
  onProgress: (received: number, total: number) => void,
): Promise<Blob> {
  const response = await fetch(`/api/assistant/files/${id}`, { headers: { [CLIENT_HEADER]: '1' } })
  if (!response.ok) throw new Error(`Download failed (${response.status})`)
  const total = Number(response.headers.get('content-length') ?? 0)
  if (!response.body || !total) {
    const blob = await response.blob()
    onProgress(blob.size, blob.size)
    return blob
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    onProgress(received, total)
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Blob([merged as unknown as BlobPart], { type: response.headers.get('content-type') ?? 'application/octet-stream' })
}

export const api = {
  session: () => request<SessionInfo>('/api/auth/session'),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  auth: {
    register: (username: string, password: string, locale: AppLocale = getLocale(), setupToken?: string) =>
      request<SessionInfo>('/api/auth/register', {
        method: 'POST',
        body: setupToken ? { username, password, locale, setupToken } : { username, password, locale },
      }),
    login: (username: string, password: string) =>
      request<PasswordLoginResult>('/api/auth/login', { method: 'POST', body: { username, password } }),
    totp: {
      status: () => request<TotpStatus>('/api/auth/totp/status'),
      startSetup: (currentPassword: string) =>
        request<TotpSetupInfo>('/api/auth/totp/setup', {
          method: 'POST',
          body: { currentPassword },
        }),
      confirmSetup: (setupToken: string, code: string) =>
        request<TotpRecoveryCodesResult & { enabledAt: number }>('/api/auth/totp/setup/confirm', {
          method: 'POST',
          body: { setupToken, code },
        }),
      cancelSetup: (setupToken: string) =>
        request<{ ok: true }>('/api/auth/totp/setup', {
          method: 'DELETE',
          body: { setupToken },
        }),
      completeLogin: (challengeToken: string, code: string) =>
        request<TotpLoginResult>('/api/auth/totp/login', {
          method: 'POST',
          body: { challengeToken, code },
        }),
      regenerateRecoveryCodes: (currentPassword: string, code: string) =>
        request<TotpRecoveryCodesResult>('/api/auth/totp/recovery-codes', {
          method: 'POST',
          body: { currentPassword, code },
        }),
      disable: (currentPassword: string, code: string) =>
        request<{ ok: true }>('/api/auth/totp', {
          method: 'DELETE',
          body: { currentPassword, code },
        }),
    },
    setPassword: (body: {
      currentPassword: string
      newPassword: string
    }) =>
      request<{ ok: true }>('/api/auth/password', { method: 'POST', body }),
    updateProfile: (body: { name?: string; avatarUrl?: string }) =>
      request<PublicUser>('/api/auth/profile', {
        method: 'PUT',
        body,
        timeoutMs: 30_000,
      }).then((user) => {
        publishBroadcast({ type: 'profile-changed', clientId: CLIENT_ID })
        return user
      }),
    updateRegistration: (enabled: boolean, password: string) =>
      request<{ ok: true; registrationOpen: boolean }>('/api/settings/registration', {
        method: 'PUT',
        body: { enabled, password },
      }).then((result) => {
        publishBroadcast({ type: 'site-changed', clientId: CLIENT_ID })
        return result
      }),
  },

  notes: {
    list: (params: Record<string, string | number | undefined>) =>
      request<ListNotesResponse>(`/api/notes${toQuery(params)}`),
    get: (id: string) => request<Note>(`/api/notes/${id}`),
    create: (body: { id?: string; content?: string; title?: string; folderId?: string | null; isStarred?: boolean }) =>
      request<Note>('/api/notes', { method: 'POST', body, timeoutMs: 30_000 }),
    patch: (id: string, body: PatchNoteBody) =>
      request<Note>(`/api/notes/${id}`, { method: 'PATCH', body, timeoutMs: 30_000 }),
    remove: (id: string) => request<Note>(`/api/notes/${id}`, { method: 'DELETE' }),
    restore: (id: string) => request<Note>(`/api/notes/${id}/restore`, { method: 'POST' }),
    purge: (id: string) => request<{ ok: true; cursor: number }>(`/api/notes/${id}/purge`, { method: 'DELETE' }),
    rebuildDerived: (cursor: string | null) =>
      request<{ ok: true; updated: number; nextCursor: string | null }>('/api/notes/rebuild-derived', {
        method: 'POST',
        body: { cursor },
        timeoutMs: 30_000,
      }),
    duplicate: (id: string, body: { id?: string } = {}) =>
      request<Note>(`/api/notes/${id}/duplicate`, { method: 'POST', body }),
    emptyTrash: () => request<{ purged: number }>('/api/notes/trash/empty', { method: 'POST' }),
    versions: (id: string, signal?: AbortSignal) =>
      request<{ versions: NoteVersionMeta[] }>(`/api/notes/${id}/versions`, { signal }),
    version: (id: string, versionId: string, signal?: AbortSignal) =>
      request<NoteVersion>(`/api/notes/${id}/versions/${versionId}`, { signal }),
    restoreVersion: (id: string, versionId: string) =>
      request<Note>(`/api/notes/${id}/versions/${versionId}/restore`, { method: 'POST' }),
    backlinks: (id: string, signal?: AbortSignal) =>
      request<{ backlinks: Backlink[]; unlinked: Backlink[] }>(`/api/notes/${id}/backlinks`, { signal }),
    linkMention: (id: string, sourceNoteId: string) =>
      request<{ status: 'linked'; note: Note } | { status: 'no-mention' }>(`/api/notes/${id}/link-mention`, {
        method: 'POST',
        body: { sourceNoteId },
      }),
  },

  folders: {
    list: () => request<{ folders: Folder[] }>('/api/folders'),
    create: (body: { id?: string; name?: string; parentId?: string | null; icon?: string | null; color?: string | null }) =>
      request<Folder>('/api/folders', { method: 'POST', body }),
    patch: (id: string, body: {
      name?: string
      parentId?: string | null
      beforeId?: string | null
      icon?: string | null
      color?: string | null
    }) =>
      request<Folder>(`/api/folders/${id}`, { method: 'PATCH', body }),
    remove: (id: string, strategy: 'move-up' | 'delete' = 'move-up') =>
      request<{ ok: true }>(`/api/folders/${id}?strategy=${strategy}`, { method: 'DELETE' }),
  },

  tags: {
    list: () => request<{ tags: Tag[] }>('/api/tags'),
    create: (body: { id?: string; name: string; color?: string | null }) =>
      request<Tag>('/api/tags', { method: 'POST', body }),
    patch: (id: string, body: { name?: string; color?: string | null; isPinned?: boolean }) =>
      request<Tag | { ok: true; renamed: number }>(`/api/tags/${id}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      request<{ ok: true; affected: number }>(`/api/tags/${id}`, { method: 'DELETE' }),
    move: (id: string, parent: string | null) =>
      request<{ ok: true; moved: number }>(`/api/tags/${id}/move`, { method: 'POST', body: { parent } }),
  },

  search: (q: string, limit = 50, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal }),
  reindex: () => request<{ ok: true; queued: number }>('/api/search/reindex', { method: 'POST' }),
  /**
   * Bodies for the local search index. Ids travel in the body, not the query string, so a page of 40
   * note ids cannot outgrow the URL or land in an access log.
   */
  searchDocuments: (ids: readonly string[]) =>
    request<SearchDocumentsResponse>('/api/search/documents', {
      method: 'POST',
      body: { ids: [...ids] },
    }),
  graph: (params: import('@shared/types').GraphQuery = {}, signal?: AbortSignal) =>
    request<GraphResponse>(`/api/graph${toQuery({
      mode: params.mode,
      center: params.center,
      depth: params.depth,
      q: params.q,
      folderId: params.folderId,
      tag: params.tag,
      tags: params.tags?.length ? params.tags.join(',') : undefined,
      tagsMatch: params.tags?.length ? params.tagsMatch : undefined,
      includeOrphans: params.includeOrphans === undefined ? undefined : params.includeOrphans ? 1 : 0,
      includeUnresolved: params.includeUnresolved === undefined ? undefined : params.includeUnresolved ? 1 : 0,
      tagNodes: params.showTagNodes === undefined ? undefined : params.showTagNodes ? 1 : 0,
      excluded: params.excluded?.length ? params.excluded.join(',') : undefined,
      direction: params.mode === 'local' ? params.direction : undefined,
      limit: params.limit,
    })}`, { signal }),

  sync: (since: number, options: { after?: string; snapshot?: number } = {}) =>
    request<SyncResponse>(
      `/api/sync${toQuery({ since, after: options.after, snapshot: options.snapshot })}`,
      { timeoutMs: 30_000 },
    ),

  files: {
    list: (cursor?: string, signal?: AbortSignal) => request<{ files: AttachmentWithUsage[]; nextCursor?: string | null }>(
      `/api/files${toQuery({ cursor })}`,
      { signal },
    ),
    byName: (name: string, signal?: AbortSignal) =>
      request<{ files: Attachment[] }>(`/api/files${toQuery({ name })}`, { signal }),
    upload: (file: File, noteId?: string) => {
      const form = new FormData()
      form.append('file', file)
      if (noteId) form.append('noteId', noteId)
      return request<Attachment>('/api/files', { method: 'POST', formData: form })
    },
    remove: (id: string) => request<{ ok: true }>(`/api/files/${id}`, { method: 'DELETE' }),
    prune: () => request<{ removed: number; freedBytes: number }>('/api/files/prune', { method: 'POST' }),
  },

  backup: {
    targets: () => request<{ targets: BackupTarget[] }>('/api/backup/targets'),
    create: (body: BackupTargetInput) => request<BackupTarget>('/api/backup/targets', { method: 'POST', body }),
    patch: (id: string, body: BackupTargetPatchInput) =>
      request<BackupTarget>(`/api/backup/targets/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<{ ok: true }>(`/api/backup/targets/${id}`, { method: 'DELETE' }),
    test: (id: string, body: Partial<BackupTargetInput> = {}) =>
      request<TestConnectionResult>(`/api/backup/targets/${id}/test`, { method: 'POST', body }),
    testDraft: (body: BackupTargetInput) =>
      request<TestConnectionResult>('/api/backup/test', { method: 'POST', body }),
    run: (targetIds?: string[]) => request<BackupRun>('/api/backup/run', { method: 'POST', body: { targetIds } }),
    runs: () => request<{ runs: BackupRun[] }>('/api/backup/runs'),
  },

  settings: {
    get: () => request<UserSettings>('/api/settings'),
    save: (body: Partial<UserSettings>) =>
      request<UserSettings>('/api/settings', { method: 'PUT', body }).then((settings) => {
        publishBroadcast({ type: 'settings-changed', clientId: CLIENT_ID })
        return settings
      }),
    stats: () => request<Record<string, number>>('/api/settings/stats'),
  },

  communityTemplates: {
    list: (before?: string, limit = 50) =>
      request<{ templates: CommunityTemplate[]; hasMore: boolean; nextCursor: string | null }>(
        `/api/templates/community?limit=${encodeURIComponent(String(limit))}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
      ),
    publish: (body: CommunityTemplateInput) =>
      request<{ template: CommunityTemplate }>('/api/templates/community', { method: 'POST', body }),
    remove: (id: string) => request<{ ok: true }>(`/api/templates/community/${id}`, { method: 'DELETE' }),
    use: (id: string) => request<{ uses: number }>(`/api/templates/community/${id}/use`, { method: 'POST' }),
  },

  templateLibrary: {
    load: () => request<{ savedAt: number; library: unknown }>('/api/templates/library'),
    save: (library: string) =>
      request<{ savedAt: number }>('/api/templates/library', { method: 'PUT', body: { library } }),
  },

  quickadd: {
    load: () => request<{ savedAt: number; library: unknown }>('/api/quickadd/library'),
    save: (library: string) =>
      request<{ savedAt: number }>('/api/quickadd/library', { method: 'PUT', body: { library } }),
    fieldValues: (query: { name: string; folder?: string; tag?: string; excludeTag?: string; limit?: number }) =>
      request<{ values: string[] }>(`/api/quickadd/field-values${toQuery(query)}`),
    fieldNotes: (query: { name: string; value?: string; folder?: string; tag?: string; excludeTag?: string; limit?: number }) =>
      request<{ notes: { id: string, title: string }[] }>(`/api/quickadd/field-notes${toQuery(query)}`),
  },

  rss: {
    load: () => request<{ savedAt: number; library: unknown }>('/api/rss/library'),
    save: (library: string) =>
      request<{ savedAt: number }>('/api/rss/library', { method: 'PUT', body: { library } }),
    /** One device's changes, folded into the account's rows by the Worker. */
    patch: (patch: unknown) =>
      request<{ savedAt: number; rows: number }>('/api/rss/patch', { method: 'POST', body: { patch } }),
    fetch: (requests: Array<{ url: string; etag?: string; lastModified?: string }>) =>
      request<{ results: RssFetchResult[] }>('/api/rss/fetch', { method: 'POST', body: { requests } }),
    /** The same-origin address an article image or an episode enclosure loads from. */
    relayUrl: (url: string) => `/api/rss/relay?url=${encodeURIComponent(url)}`,
  },

  mcp: {
    get: () => request<McpSettingsInfo>('/api/mcp'),
    save: (body: {
      enabled?: boolean
      writeEnabled?: boolean
      trashEnabled?: boolean
      /** The server's own tools to switch off, by the name it registers them under. */
      disabledTools?: string[]
    }) => request<{
      enabled: boolean
      preferences: McpSettingsInfo['preferences']
      reconnectRequired: boolean
    }>('/api/mcp', { method: 'PUT', body }),
    revokeGrant: (id: string) => request<{ ok: true }>(`/api/mcp/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    revokeAllGrants: () => request<{ ok: true; revoked: number }>('/api/mcp/grants/revoke-all', { method: 'POST' }),
    /**
     * Mint a key, optionally narrowed to a subset of the scopes the account allows.
     *
     * An absent list means "everything the account allows"; the server narrows whatever is sent against the
     * account's own switches, so this can only ever ask for less.
     */
    createKey: (name: string, scopes?: string[]) =>
      request<{ key: McpApiKey; token: string }>('/api/mcp/keys', { method: 'POST', body: scopes ? { name, scopes } : { name } }),
    revokeKey: (id: string) =>
      request<{ ok: true }>(`/api/mcp/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    aiSearch: {
      save: (enabled: boolean) =>
        request<McpAiSearchStatus>('/api/mcp/ai-search', { method: 'PUT', body: { enabled } }),
      reindex: () =>
        request<McpAiSearchStatus & { ok: true; enqueued: number }>('/api/mcp/ai-search/reindex', { method: 'POST' }),
      clear: () =>
        request<{ ok: true; removed: number }>('/api/mcp/ai-search/clear', { method: 'POST' }),
    },
  },

  update: {
    check: () => request<UpdateCheckResponse>('/api/update', { timeoutMs: 10_000 }),
  },

  share: {
    list: (signal?: AbortSignal) =>
      request<{ shares: ShareListItem[] }>('/api/share', { signal }),
    get: (noteId: string, signal?: AbortSignal) =>
      request<{ share: ShareInfo | null }>(`/api/share/${noteId}`, { signal }),
    create: (noteId: string, body: { password?: string | null; expiresIn?: number | null }) =>
      request<{ share: ShareInfo }>(`/api/share/${noteId}`, { method: 'POST', body }),
    remove: (noteId: string) => request<{ ok: true }>(`/api/share/${noteId}`, { method: 'DELETE' }),
    read: (slug: string, password?: string, signal?: AbortSignal) =>
      request<PublicNote>(`/api/public/${slug}`, { method: 'POST', body: { password }, signal }),
    /** The same read for a published conversation, which has an address of its own. */
    readConversation: (slug: string, password?: string, signal?: AbortSignal) =>
      request<PublicConversation>(`/api/public/conversation/${slug}`, { method: 'POST', body: { password }, signal }),
  },

  /**
   * The audience-follow channel: start a show, move its position, end it.
   *
   * `start` is the only call that ever returns the capability token — the server keeps a hash, so a
   * refresh cannot recover it and a presenter who wants the link again starts a new show. The viewer's
   * read is a public call with no session at all.
   */
  presence: {
    start: (noteId: string) =>
      request<SharePresenceSession>(`/api/share/${noteId}/present/start`, { method: 'POST', body: {} }),
    publish: (noteId: string, position: SharePresencePosition) =>
      request<{ updatedAt: number, viewers: number }>(`/api/share/${noteId}/present`, { method: 'POST', body: position }),
    stop: (noteId: string) =>
      request<{ stopped: true }>(`/api/share/${noteId}/present/stop`, { method: 'POST', body: {} }),
    status: (noteId: string, signal?: AbortSignal) =>
      request<PresenceStatus>(`/api/share/${noteId}/present`, { signal }),
    /**
     * The viewer's heartbeat. `undefined` means "nothing moved since the last beat" (a 304), which is
     * why the caller keeps what it holds rather than treating it as a blank. `cache: 'no-store'`
     * because a stored answer to "where is the talk now" is not a stale answer — it is a different
     * question's.
     */
    read: (slug: string, token: string, ifNoneMatch?: string, onEtag?: (etag: string | null) => void) =>
      request<PublicSharePresence | undefined>(`/api/public/${slug}/present`, { method: 'POST', body: { token }, ifNoneMatch, onEtag, cache: 'no-store' }),
  },

  transfer: {
    save: saveDownload,
    import: (
      files: File[],
      conflict: 'skip' | 'newer' | 'duplicate' = 'newer',
      backup?: { manifest: MarkdownBackupManifest; paths: string[] },
    ) => {
      const form = new FormData()
      for (const file of files) form.append('file', file)
      form.append('conflict', conflict)
      if (backup) {
        form.append('backupManifest', JSON.stringify(backup.manifest))
        form.append('backupPaths', JSON.stringify(backup.paths))
      }
      return request<ImportResult>('/api/import', { method: 'POST', formData: form })
    },
  },

  excalidrawLibrary: {
    getManifest: () => request<{ ok: true; manifest: any }>('/api/excalidraw/library/manifest'),
    saveManifest: (manifest: any) =>
      request<{ ok: true; updatedAt: number }>('/api/excalidraw/library/manifest', {
        method: 'PUT',
        body: { manifest },
      }),
    getOfficialCatalog: () =>
      request<{ ok: boolean; libraries: any[] }>('/api/excalidraw/library/official-catalog'),
    downloadOfficialLibrary: (sourceOrUrl: string) =>
      request<{ ok: boolean; data: any; filename?: string }>('/api/excalidraw/library/official-download', {
        method: 'POST',
        body: /^https?:\/\//i.test(sourceOrUrl) ? { url: sourceOrUrl } : { source: sourceOrUrl },
      }),
    saveFile: (filename: string, content: any) =>
      request<{ ok: true; path: string }>('/api/excalidraw/library/save-file', {
        method: 'POST',
        body: { filename, content },
      }),
  },

  readerLibrary: {
    get: () => request<{ ok: true; library: any; usage: ReaderUsage }>('/api/reader/library'),
    put: (library: unknown) => request<{
      ok: true
      updatedAt: number
      missingBlobs: string[]
      missingCovers: string[]
      usage: ReaderUsage
    }>('/api/reader/library', {
      method: 'PUT',
      body: { library },
    }),
    remove: (bookId: string) => request<{ ok: true; removed: boolean }>(`/api/reader/books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
    }),
    bookUrl: (number: string) => `/api/reader/discovery/book/${encodeURIComponent(number)}`,
    blobUrl: (bookId: string) => `/api/reader/books/${encodeURIComponent(bookId)}/blob`,
    coverUrl: (bookId: string) => `/api/reader/books/${encodeURIComponent(bookId)}/cover`,
  },
  /**
   * The chat assistant. Its own group because it is its own app container: the rail's Chat tab owns
   * these routes, and nothing in the notebook calls them.
   */
  assistant: {
    /** The conversations that wrote one note: the note's own "from a conversation" backlinks. */
    noteWrites: (noteId: string, signal?: AbortSignal) =>
      request<{ conversations: { id: string, title: string, updatedAt: number }[] }>(
        `/api/assistant/note-writes${toQuery({ noteId })}`, { signal },
      ),
    /** A note the browser wrote from a reply: the worker cannot see that save, so the client reports it. */
    recordNoteWrite: (noteId: string, conversationId: string) =>
      request<{ ok: true }>('/api/assistant/note-writes', { method: 'POST', body: { noteId, conversationId } }),
    conversations: (params: { q?: string, folder?: string, project?: string, tag?: string, starred?: string, pinned?: string, archived?: string, limit?: string, cursor?: string } = {}) =>
      request<{ conversations: AssistantConversation[], nextCursor: string | null }>(`/api/assistant/conversations${toQuery(params)}`),
    createConversation: (title?: string, folderId?: string | null) =>
      request<{ conversation: AssistantConversation }>('/api/assistant/conversations', {
        method: 'POST',
        body: folderId === undefined ? { title } : { title, folderId },
      }),
    /** A folder from the notebook's tree; null files the conversation back to unfiled. */
    setConversationProject: (id: string, projectId: string | null) =>
      request<{ conversation: AssistantConversation }>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: { projectId } }),
    moveConversation: (id: string, folderId: string | null) =>
      request<{ conversation: AssistantConversation }>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: { folderId } }),
    /** Put a conversation away or take it back out. Not a delete: the thread stays whole and searchable. */
    setConversationArchived: (id: string, archived: boolean) =>
      request<{ conversation: AssistantConversation }>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: { archived } }),
    conversationShare: (id: string, messageIds: readonly string[] = [], signal?: AbortSignal) =>
      request<{ share: ConversationShareInfo | null }>(`/api/assistant/conversations/${id}/share${shareScopeQuery(messageIds)}`, { signal }),
    createConversationShare: (id: string, body: { password?: string | null, expiresIn?: number | null, rotate?: boolean, messageIds?: readonly string[] }) =>
      request<{ share: ConversationShareInfo }>(`/api/assistant/conversations/${id}/share`, { method: 'POST', body }),
    removeConversationShare: (id: string, messageIds: readonly string[] = []) =>
      request<{ ok: true }>(`/api/assistant/conversations/${id}/share${shareScopeQuery(messageIds)}`, { method: 'DELETE' }),
    conversationFolders: () =>
      request<{ folders: ChatFolderNode[], unfiled: number }>('/api/assistant/folders'),
    conversationProjects: () =>
      request<{ projects: ChatProjectNode[], unfiled: number }>('/api/assistant/projects/summary'),
    conversationTags: () =>
      request<{ tags: (ConversationTag & { count: number })[] }>('/api/assistant/tags'),
    addConversationTag: (id: string, tagId: string) =>
      request<{ ok: true }>(`/api/assistant/conversations/${id}/tags`, { method: 'POST', body: { tagId } }),
    removeConversationTag: (id: string, tagId: string) =>
      request<{ ok: true }>(`/api/assistant/conversations/${id}/tags/${tagId}`, { method: 'DELETE' }),
    conversation: (id: string, params: { limit?: string, before?: string, upto?: string } = {}) =>
      request<{
        conversation: AssistantConversation,
        messages: AssistantMessage[],
        attachments: ChatAttachment[],
        streaming: boolean,
        /** Whether earlier turns exist above this page, and the cursor that asks for them. */
        hasMore: boolean,
        nextBefore: string | null,
        /** Whether the window opened at a search hit has newer turns below it. */
        hasNewer: boolean
      }>(`/api/assistant/conversations/${id}${toQuery(params)}`),
    /** One conversation as a file: the row, every turn, and the answers a turn displaced. */
    conversationExport: (id: string) =>
      request<Record<string, unknown>>(`/api/assistant/conversations/${id}/export`),
    /**
     * The drafts a conversation keeps in its side panel.
     *
     * Fetched with the thread rather than stored on it: a draft is a document, and a listing that carried
     * every one of them would make opening a conversation pay for work the reader may not do.
     */
    conversationArtifacts: (id: string) =>
      request<{ artifacts: AssistantArtifact[] }>(`/api/assistant/conversations/${id}/artifacts`),
    /** The branch a conversation sits on: the thread it came from, and the threads forked off the same point. */
    conversationBranches: (id: string) =>
      request<{
        parent: { id: string, title: string } | null,
        siblings: Array<{ id: string, title: string, updatedAt: number }>,
      }>(`/api/assistant/conversations/${id}/branches`),
    createConversationArtifact: (id: string, body: { title?: string, content: string }) =>
      request<{ artifact: AssistantArtifact }>(`/api/assistant/conversations/${id}/artifacts`, { method: 'POST', body }),
    updateConversationArtifact: (id: string, artifactId: string, body: { title?: string, content?: string, noteId?: string | null }) =>
      request<{ artifact: AssistantArtifact }>(
        `/api/assistant/conversations/${id}/artifacts/${artifactId}`, { method: 'PATCH', body },
      ),
    removeConversationArtifact: (id: string, artifactId: string) =>
      request<{ ok: true }>(`/api/assistant/conversations/${id}/artifacts/${artifactId}`, { method: 'DELETE' }),
    renameConversation: (id: string, title: string) =>
      request<{ conversation: AssistantConversation }>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: { title } }),
    // ------------------------------------------------------------ external MCP servers
    mcpServers: () => request<{ servers: AssistantMcpServer[] }>('/api/assistant/mcp'),
    mcpServer: (id: string) => request<AssistantMcpServerDetail>(`/api/assistant/mcp/${id}`),
    createMcpServer: (body: Record<string, unknown>) =>
      request<{ server: AssistantMcpServer }>('/api/assistant/mcp', { method: 'POST', body }),
    patchMcpServer: (id: string, body: Record<string, unknown>) =>
      request<{ server: AssistantMcpServer }>(`/api/assistant/mcp/${id}`, { method: 'PATCH', body }),
    removeMcpServer: (id: string) => request<{ ok: true }>(`/api/assistant/mcp/${id}`, { method: 'DELETE' }),
    testMcpServer: (id: string, headers?: Record<string, string>) =>
      request<{ ok: boolean, error: string, tools: { name: string, remoteName: string, description: string }[] }>(
        `/api/assistant/mcp/${id}/test`, { method: 'POST', body: headers === undefined ? {} : { headers } },
      ),
    /** The names the composer's / picker can offer, with the servers that failed to list. */
    mcpTools: () => request<{ servers: AssistantMcpCatalogEntry[], problems: AssistantMcpProblem[] }>('/api/assistant/mcp/tools'),
    /**
     * Run one stored third-party call again, with what it was handed the first time.
     *
     * The arguments travel as the ids of the row they are on, never as text: the worker reads them back
     * out of the message, so a client cannot ask for a call that never happened.
     */
    replayMcpTool: (conversationId: string, messageId: string, toolId: string) =>
      request<{ ok: boolean, error: string, result: string }>(
        '/api/assistant/mcp/replay', { method: 'POST', body: { conversationId, messageId, toolId } },
      ),
    /**
     * Ask the worker to start a login at this server's own identity provider.
     *
     * The answer is an address rather than a redirect on purpose: this call is a `fetch`, and a redirect to
     * an external site would drag the session cookie along with it. The caller opens the address itself.
     */
    authorizeMcpServer: (id: string, clientId?: string) =>
      request<{ url: string }>(`/api/assistant/mcp/${id}/authorize`, { method: 'POST', body: clientId ? { clientId } : {} }),
    revokeMcpServer: (id: string) => request<{ ok: true }>(`/api/assistant/mcp/${id}/authorize`, { method: 'DELETE' }),
    /**
     * Withdraw the client registration itself, at the issuer when it can be and here always.
     *
     * A different press from the one above: that one logs the reader out, this one uninstalls the app. The
     * answer carries whether the issuer was actually told, because a client registered by hand has nothing
     * at the far end to delete.
     */
    revokeMcpClient: (id: string) =>
      request<{ ok: true, revokedAtIssuer: boolean }>(`/api/assistant/mcp/${id}/client`, { method: 'DELETE' }),

    /** The answers one turn displaced, oldest first. */
    answerVersions: (conversationId: string, messageId: string) =>
      request<{ versions: AssistantAnswerVersion[] }>(`/api/assistant/conversations/${conversationId}/messages/${messageId}/versions`),
    /** Exchange the turn's live answer for one of its earlier ones. */
    activateAnswerVersion: (conversationId: string, messageId: string, versionId: string) =>
      request<{ message: AssistantMessage }>(
        `/api/assistant/conversations/${conversationId}/messages/${messageId}/versions/${versionId}/activate`,
        { method: 'POST' },
      ),
    /**
     * Retype a turn, and optionally keep the thread it truncates as a branch.
     *
     * `branchTitle` is only read when `keepBranch` is set: the name is interface copy, so the browser
     * names it and the worker clamps it like every other stored title.
     */
    editMessage: (conversationId: string, messageId: string, content: string, branchTitle?: string) =>
      request<{ message: AssistantMessage, removed: number, branch: AssistantConversation | null }>(
        `/api/assistant/conversations/${conversationId}/messages/${messageId}`,
        { method: 'PATCH', body: branchTitle === undefined ? { content } : { content, keepBranch: true, branchTitle } },
      ),
    /** Deletes the turns a reader selected, without the pairing a single delete applies. */
    deleteMessages: (conversationId: string, ids: readonly string[]) =>
      request<{ removed: string[], messages: AssistantMessage[] }>(
        `/api/assistant/conversations/${conversationId}/messages/delete`,
        { method: 'POST', body: { ids } },
      ),
    /** A new conversation carrying this one up to and including one message. */
    forkConversation: (conversationId: string, messageId: string, title: string) =>
      request<{ conversation: AssistantConversation, messages: AssistantMessage[] }>(
        `/api/assistant/conversations/${conversationId}/fork`,
        { method: 'POST', body: { messageId, title } },
      ),
    /** The reader's verdict on one answer, or null to take it back. */
    rateAnswer: (conversationId: string, messageId: string, feedback: MessageFeedback | null) =>
      request<{ message: AssistantMessage }>(
        `/api/assistant/conversations/${conversationId}/messages/${messageId}/feedback`,
        { method: 'PATCH', body: { feedback } },
      ),
    /** Take a turn back: the message and, under a reader's own row, the answer it drew. */
    removeMessage: (conversationId: string, messageId: string) =>
      request<{ removed: string[], messages: AssistantMessage[] }>(
        `/api/assistant/conversations/${conversationId}/messages/${messageId}`,
        { method: 'DELETE' },
      ),
    pinConversation: (id: string, pinned: boolean) =>
      request<{ conversation: AssistantConversation }>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: { pinned } }),
    uploadChatFile: (file: File, onProgress: (sent: number, total: number) => void, extractedText?: string) =>
      uploadChatFileWithProgress(file, onProgress, extractedText),
    chatFileUrl: (id: string) => `/api/assistant/files/${id}`,
    downloadChatFile: (id: string, onProgress: (received: number, total: number) => void) =>
      downloadChatFileWithProgress(id, onProgress),
    addChatFileFromUrl: (url: string) =>
      request<{ attachment: ChatAttachment }>('/api/assistant/files/url', { method: 'POST', body: { url } }),
    skills: (query?: string) =>
      request<{ skills: AssistantSkill[] }>(`/api/assistant/skills${query ? `?q=${encodeURIComponent(query)}` : ''}`),
    createSkill: (body: AssistantSkillInput) =>
      request<{ skill: AssistantSkill }>('/api/assistant/skills', { method: 'POST', body }),
    updateSkill: (id: string, body: AssistantSkillInput) =>
      request<{ skill: AssistantSkill }>(`/api/assistant/skills/${id}`, { method: 'PATCH', body }),
    removeSkill: (id: string) => request<{ deleted: boolean }>(`/api/assistant/skills/${id}`, { method: 'DELETE' }),
    exportSkills: () => request<{ bundle: AssistantSkillBundle }>('/api/assistant/skills/export'),
    importSkills: (skills: unknown[]) =>
      request<SkillImportResult>('/api/assistant/skills/import', { method: 'POST', body: { skills } }),
    chatFiles: () => request<{ files: ChatAttachment[] }>('/api/assistant/files'),
    deleteChatFile: (id: string) => request<{ deleted: boolean }>(`/api/assistant/files/${id}`, { method: 'DELETE' }),
    starConversation: (id: string, starred: boolean) =>
      request<{ conversation: AssistantConversation }>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: { starred } }),
    deleteConversation: (id: string) =>
      request<{ deleted: true }>(`/api/assistant/conversations/${id}`, { method: 'DELETE' }),
    deleteConversations: () =>
      request<{ deleted: number }>('/api/assistant/conversations', { method: 'DELETE', body: { confirm: 'DELETE' } }),
    cancel: (conversationId: string, runToken?: number) =>
      request<{ cancelled: true }>('/api/assistant/chat/cancel', { method: 'POST', body: { conversationId, ...(runToken === undefined ? {} : { runToken }) } }),
    approveAction: (id: string) =>
      request<{ action: PendingAction, result?: string }>(`/api/assistant/actions/${id}/approve`, { method: 'POST', body: {} }),
    declineAction: (id: string) =>
      request<{ action: PendingAction, result?: string }>(`/api/assistant/actions/${id}/cancel`, { method: 'POST', body: {} }),
    memories: (params: { q?: string, status?: string, category?: string } = {}) =>
      request<{ memories: AssistantMemory[], total: number, counts: { active: number, historical: number, review: number } }>(
        `/api/assistant/memories${toQuery(params)}`,
      ),
    createMemory: (content: string, category: string) =>
      request<{ memory: AssistantMemory, superseded: AssistantMemory[], reviews: number }>('/api/assistant/memories', {
        method: 'POST',
        body: { content, category },
      }),
    updateMemory: (id: string, patch: { content?: string, category?: string }) =>
      request<{ memory: AssistantMemory, superseded: AssistantMemory[], reviews: number }>(`/api/assistant/memories/${id}`, {
        method: 'PATCH',
        body: patch,
      }),
    correctMemory: (id: string, content: string, category?: string) =>
      request<{ memory: AssistantMemory, superseded: AssistantMemory[], reviews: number }>(`/api/assistant/memories/${id}/correct`, {
        method: 'POST',
        body: { content, category },
      }),
    memoryStatus: (id: string, status: string) =>
      request<{ memory: AssistantMemory }>(`/api/assistant/memories/${id}/status`, { method: 'POST', body: { status } }),
    /** Link a memory to the note it was written out as, or unlink it after the note is gone. */
    memoryNote: (id: string, noteId: string | null) =>
      request<{ memory: AssistantMemory }>(`/api/assistant/memories/${id}/note`, { method: 'POST', body: { noteId } }),
    semantic: () => request<{
      enabled: boolean, available: boolean, model: string, vectors: number, pending: number, today: number, cap: number
    }>('/api/assistant/semantic'),
    reindexSemantic: () => request<{ embedded: number, capped: boolean }>('/api/assistant/semantic/reindex', { method: 'POST' }),
    clearSemantic: () => request<{ deleted: number }>('/api/assistant/semantic', { method: 'DELETE' }),
    memoryHistory: (id: string) =>
      request<{ memory: AssistantMemory, previous: AssistantMemory[], next: AssistantMemory[] }>(`/api/assistant/memories/${id}/history`),
    deleteMemory: (id: string) => request<{ deleted: true }>(`/api/assistant/memories/${id}`, { method: 'DELETE' }),
    clearMemories: () => request<{ deleted: number }>('/api/assistant/memories', { method: 'DELETE', body: { confirm: 'DELETE' } }),
    reviews: () => request<{ reviews: MemoryReview[] }>('/api/assistant/memories/reviews'),
    resolveReview: (id: string, action: string) =>
      request<{ kept: number, deleted: boolean }>(`/api/assistant/memories/reviews/${id}`, { method: 'POST', body: { action } }),
    tasks: (params: { status?: string, view?: string, q?: string, project_id?: string, limit?: number } = {}) =>
      request<{ tasks: AssistantTask[] }>(`/api/assistant/tasks${toQuery(params)}`),
    createTask: (body: Record<string, unknown>) => request<{ task: AssistantTask }>('/api/assistant/tasks', { method: 'POST', body }),
    updateTask: (id: string, body: Record<string, unknown>) =>
      request<{ task: AssistantTask }>(`/api/assistant/tasks/${id}`, { method: 'PATCH', body }),
    deleteTask: (id: string) => request<{ deleted: true }>(`/api/assistant/tasks/${id}`, { method: 'DELETE' }),
    projects: () => request<{ projects: AssistantProject[] }>('/api/assistant/projects'),
    getProject: (id: string) => request<{ project: AssistantProject }>(`/api/assistant/projects/${id}`),
    createProject: (body: { name: string, description?: string, instructions?: string, noteScope?: string[], modelId?: string | null }) =>
      request<{ project: AssistantProject }>('/api/assistant/projects', { method: 'POST', body }),
    updateProject: (id: string, body: { name?: string, description?: string, instructions?: string, noteScope?: string[], modelId?: string | null }) =>
      request<{ project: AssistantProject }>(`/api/assistant/projects/${id}`, { method: 'PATCH', body }),
    deleteProject: (id: string) => request<{ deleted: true }>(`/api/assistant/projects/${id}`, { method: 'DELETE' }),
    automations: () =>
      request<{ automations: AssistantAutomation[], runs: AssistantAutomationRun[], timezone: string }>('/api/assistant/automations'),
    createAutomation: (body: Record<string, unknown>) =>
      request<{ automation: AssistantAutomation }>('/api/assistant/automations', { method: 'POST', body }),
    updateAutomation: (id: string, body: Record<string, unknown>) =>
      request<{ automation: AssistantAutomation }>(`/api/assistant/automations/${id}`, { method: 'PATCH', body }),
    deleteAutomation: (id: string) => request<{ deleted: true }>(`/api/assistant/automations/${id}`, { method: 'DELETE' }),
    notifications: (unreadOnly?: boolean) =>
      request<{ notifications: AssistantNotification[], unread: number }>(`/api/assistant/notifications${unreadOnly ? '?unread=1' : ''}`),
    markNotificationsRead: (id?: string) =>
      request<{ unread: number }>('/api/assistant/notifications/read', { method: 'POST', body: id ? { id } : {} }),
    deleteNotification: (id: string) => request<{ unread: number }>(`/api/assistant/notifications/${id}`, { method: 'DELETE' }),
    settings: () => request<{ settings: AssistantSettings, models: AssistantModel[] }>('/api/assistant/settings'),
    saveSettings: (patch: Record<string, unknown>) =>
      request<{ settings: AssistantSettings }>('/api/assistant/settings', { method: 'PATCH', body: patch }),
    providers: () => request<{ providers: AssistantProvider[] }>('/api/assistant/providers'),
    createProvider: (body: Record<string, unknown>) =>
      request<{ provider: AssistantProvider }>('/api/assistant/providers', { method: 'POST', body }),
    updateProvider: (id: string, body: Record<string, unknown>) =>
      request<{ provider: AssistantProvider }>(`/api/assistant/providers/${id}`, { method: 'PATCH', body }),
    deleteProvider: (id: string) => request<{ deleted: true }>(`/api/assistant/providers/${id}`, { method: 'DELETE' }),
    /** The extra keys a provider rotates through. The plaintext is never in the answer. */
    providerKeys: (id: string) => request<{ keys: AssistantProviderKey[] }>(`/api/assistant/providers/${id}/keys`),
    createProviderKey: (id: string, body: { label?: string, apiKey: string }) =>
      request<{ key: AssistantProviderKey }>(`/api/assistant/providers/${id}/keys`, { method: 'POST', body }),
    updateProviderKey: (id: string, keyId: string, body: { label?: string, enabled?: boolean, apiKey?: string | null }) =>
      request<{ key: AssistantProviderKey }>(`/api/assistant/providers/${id}/keys/${keyId}`, { method: 'PATCH', body }),
    deleteProviderKey: (id: string, keyId: string) =>
      request<{ deleted: true }>(`/api/assistant/providers/${id}/keys/${keyId}`, { method: 'DELETE' }),
    models: () => request<{ models: AssistantModel[] }>('/api/assistant/models'),
    /** The vendor's own list, asked through the worker so the key never reaches the browser. */
    vendorModels: (id: string) =>
      request<{ ok: boolean, error: string | null, models: AssistantVendorModel[] }>(`/api/assistant/providers/${id}/vendor-models`),
    /** The same listing for a provider that has not been saved: nothing is stored, the key is passed in. */
    previewVendorModels: (body: Record<string, unknown>) =>
      request<{ ok: boolean, error: string | null, models: AssistantVendorModel[] }>('/api/assistant/providers/model-list', { method: 'POST', body }),
    createModel: (body: Record<string, unknown>) =>
      request<{ model: AssistantModel }>('/api/assistant/models', { method: 'POST', body }),
    updateModel: (id: string, body: Record<string, unknown>) =>
      request<{ model: AssistantModel }>(`/api/assistant/models/${id}`, { method: 'PATCH', body }),
    deleteModel: (id: string) => request<{ deleted: true }>(`/api/assistant/models/${id}`, { method: 'DELETE' }),
    usage: () =>
      request<{ day: string, today: AssistantUsage, last7Days: AssistantUsage, limits: AssistantLimits }>('/api/assistant/usage'),
    /** One window of spending, per day, per model and per conversation. */
    stats: (range: '7' | '30' | 'all', filter: { model?: string, key?: string } = {}) =>
      request<AssistantStats>(`/api/assistant/stats${toQuery({ range, model: filter.model, key: filter.key })}`),
    /** The account's own totals, which no range narrows — see the type for why. */
    usageOverview: () =>
      request<{ overview: AssistantUsageOverview }>('/api/assistant/stats/overview'),
    activity: () =>
      request<{ activity: { id: string, type: string, summary: string, created_at: number }[] }>('/api/assistant/activity'),
    /**
     * The backup as data rather than as a download.
     *
     * The settings screen has to know how big the file is before it tells the reader it is safe: the
     * import reads a bounded file, and a backup past that bound is one that cannot come back.
     */
    exportBackup: () => request<Record<string, unknown>>('/api/assistant/export'),
    importBackup: (payload: unknown) =>
      request<{ imported: AssistantImportSummary }>('/api/assistant/import', { method: 'POST', body: payload }),
  },
}

/**
 * Which turns a share link covers, as the query the worker reads it back from.
 *
 * Nothing at all for the whole thread, so the everyday link's request is the one it has always been and a
 * reader who never narrows anything sees no difference in the wire.
 */
function shareScopeQuery(messageIds: readonly string[]): string {
  return messageIds.length ? `?messageIds=${messageIds.map(encodeURIComponent).join(',')}` : ''
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (!entries.length) return ''
  return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`
}

import type { RssFetchResult } from '@shared/rss/model'
import type {
  CalendarDto,
  CalendarEventDto,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarGroupDto,
  CalendarGroupWriteInput,
  CalendarMetaDto,
  CalendarPatchInput,
  CalendarPreferences,
  CalendarSearchResultDto,
  CalendarWriteInput,
} from '@shared/calendar/model'
import { CLIENT_HEADER } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type { ReaderUsage } from '@shared/types'
import type { ChatAttachment,
  AssistantSkill,
  AssistantSkillInput,
  AssistantSkillBundle,
  SkillImportResult,
  MessageFeedback,
} from '@shared/assistant'
import type { MarkdownBackupManifest } from '@shared/backup-format'
import type {
  ChannelKind,
  ChannelState,
  BulkAction,
  CurrencyCode,
  LabelEntry,
  LabelKind,
  NextReminder,
  NotifyLocale,
  NotifyLogEntry,
  NotifyLogFilter,
  ReminderRule,
  ReminderRuleInput,
  RenewOptions,
  ScheduleLogEntry,
  SubscriptionBundle,
  SubscriptionDetail,
  SubscriptionInput,
  SubscriptionItem,
  SubscriptionSettings,
} from '@shared/subscriptions/model'
import type { ConversationShareInfo, PublicConversation } from '@shared/assistant'
import type { ProviderBalanceAnswer } from '@shared/provider-balance'
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
  AssistantArtifactVersion,
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
  AssistantRealtimeSession,
  AssistantSearchKey,
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
  SavedMessage,
} from '@shared/assistant'
import type {
  SnoozeMinutes,
  TaskBatchRequestOp,
  TaskBatchResult,
  TaskList,
  TaskPage,
  TaskStatsBucket,
  TaskStep,
  TaskTag,
  TaskTrashPage,
  TodoStats,
  TodoTask,
  TodoTimeEntry,
} from '@shared/todos/model'
import { REMIND_OFFSET_MS, type CounterReadings, type CounterStop, type CounterTick, type CounterKind, type FinishDay, type RemindTier, type TodoCounter, type Worklog } from '@shared/todos/model'
import type {
  EmailAccount,
  EmailBatchInput,
  EmailBatchResult,
  EmailConfig,
  EmailDraftInput,
  EmailFolder,
  EmailListResponse,
  EmailMailboxStats,
  EmailMessage,
  EmailMessageTagInput,
  EmailScheduledSend,
  EmailScheduledSendInput,
  EmailSendInput,
  EmailSendResult,
  EmailSnoozeResult,
  EmailTag,
  EmailTagInput,
  EmailTagPatch,
} from '@shared/email/model'
import type { EmailDeploymentPatch, EmailDeploymentSettings } from '@shared/email/deployment'
import type {
  EmailContact,
  EmailContactInput,
  EmailContactPatch,
  EmailGroup,
  EmailGroupInput,
  EmailGroupPatch,
  EmailGroupWithMembers,
} from '@shared/email/contacts'
import type {
  EmailBlockedSender,
  EmailBlockSenderResult,
  EmailFilter,
  EmailFilterInput,
  EmailFilterPatch,
} from '@shared/email/rules'
import type {
  EmailTemplate,
  EmailTemplateInput,
  EmailTemplatePatch,
} from '@shared/email/templates'
import type {
  EmailSavedSearch,
  EmailSavedSearchInput,
  EmailSavedSearchPatch,
} from '@shared/email/searches'
import { publishBroadcast } from './db'
import { randomLocalId } from './random-id'
import { getLocale, t, translateApiError } from './i18n'


export const CLIENT_ID = randomLocalId()

/**
 * A list as the organizer page reads it: the shared shape plus where it sits.
 *
 * `archivedAt` is the moment the reader put the list away, or null while it is in use; `parentId` is
 * the one container it sits under, or null at the top level. Kept beside the API client rather than
 * in the shared model because they are fields of this screen's answer, not facts every task surface
 * reads.
 */
export type TaskListEntry = TaskList & {
  archivedAt: number | null
  parentId: string | null
}

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
     * names the field it refused, and says what is wrong with it. Mapping the code used to throw that
     * sentence away, so a form could only repeat the generic refusal for a mistake it was able to point at.
     * This line carries both: the route's message, and its `details` rendered as `field: reason` pairs.
     *
     * It is a detail line for a surface that has one, never a toast headline: it is the server's own
     * English, and no catalog key translates it. Everything in it is text the deployment wrote rather than
     * the app, so it arrives already flattened to one bounded plain line with credential-shaped runs taken
     * out — a surface prints it as a child node, and nothing here builds markup.
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

/** How much of the route's own reason a surface is shown. */
const SERVER_REASON_MAX_CHARS = 240
/** A field's reason is a phrase, not a document; a validator's whole error tree is not one line. */
const SERVER_DETAIL_MAX_VALUE_CHARS = 90
const SERVER_DETAIL_MAX_PAIRS = 6
const SERVER_DETAIL_MAX_DEPTH = 2

/**
 * Runs that carry a credential's shape rather than a reason's.
 *
 * A route can echo back what it refused — an API key being validated, a header a remote server sent — and
 * this line is written to sit on a screen a screenshot can leave. Refusing to show a secret is not the
 * same as hiding the mistake: the label in front of it stays, so the reader still sees which field the
 * route was talking about.
 */
const CREDENTIAL_PLACEHOLDER = '[redacted]'
const CREDENTIAL_SHAPED: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${CREDENTIAL_PLACEHOLDER}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, `sk-${CREDENTIAL_PLACEHOLDER}`],
  [/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*)[^\s"',;]{6,}/gi, `$1${CREDENTIAL_PLACEHOLDER}`],
  // A bare opaque run: a key the route printed without naming it.
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, CREDENTIAL_PLACEHOLDER],
]

/**
 * The field-level half of a refusal, as `field.path: what is wrong with it`.
 *
 * Covers the two shapes the routes actually answer with: a flat `{ field: 'reason' }` (or a list of
 * reasons under one field), and a validator's `{ fieldErrors: { field: […] } }` one level deeper. Past
 * that depth the payload is a document rather than an explanation, so it is left out instead of being
 * stringified — an `[object Object]` on a failure line teaches the reader nothing about the field.
 */
function detailPairs(details: unknown): string[] {
  const out: string[] = []
  walk(details, '', 0)
  return out

  function walk(value: unknown, path: string, depth: number): void {
    if (value === null || value === undefined || depth > SERVER_DETAIL_MAX_DEPTH) return
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = truncateText(String(value), SERVER_DETAIL_MAX_VALUE_CHARS)
      if (text) out.push(path ? `${path}: ${text}` : text)
      return
    }
    if (Array.isArray(value)) {
      const scalars = value.filter((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
      if (path && scalars.length === value.length && scalars.length) {
        out.push(`${path}: ${truncateText(scalars.map(String).join('; '), SERVER_DETAIL_MAX_VALUE_CHARS)}`)
        return
      }
      for (const entry of value.slice(0, SERVER_DETAIL_MAX_PAIRS)) walk(entry, path, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, SERVER_DETAIL_MAX_PAIRS)) {
      walk(entry, path ? `${path}.${key}` : key, depth + 1)
    }
  }
}

/**
 * The route's own reason as one line the interface may print, or nothing when it said nothing.
 *
 * Built in the one place a route's answer becomes an error, so every surface that already shows this line
 * — the settings forms' inline refusal, a toast's description — gains the field names without any caller
 * having to reassemble them. Control characters and line breaks go because the line sits inside a
 * sentence; credentials go because a refusal never needs the value it refused to be readable again.
 */
function serverReason(message: string | undefined, details: unknown): string | undefined {
  const flat = [message?.trim(), ...detailPairs(details)]
    .filter((part): part is string => Boolean(part))
    .join(' — ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return undefined
  const safe = CREDENTIAL_SHAPED.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), flat)
  return truncateText(safe, SERVER_REASON_MAX_CHARS)
}

/** The `{ error: { code, message, details } }` half of a route's failure answer. */
interface RouteErrorBody {
  code?: string
  message?: string
  details?: unknown
}

/**
 * The refusal a route answered with, told the way the interface reads it.
 *
 * The headline is the app's own sentence for that code, in the reader's language; the second line is what
 * the route said about the field it refused. One factory for both, because the download path used to build
 * the same error and keep only the code — which is how a too-large archive read as a mystery.
 *
 * Exported for the one caller that cannot reach it through `request()`: the assistant's streamed turn owns
 * its response because on success it is not a body but a `ReadableStream`, so it reads its own failure — and
 * it must not assemble that second line again. What makes the line safe to print is a policy, not a format:
 * how much of it a screen may hold, which control characters may sit inside a sentence, which runs are a
 * credential rather than a diagnosis. Restated in a second place, that policy is free to drift from the one
 * the review set, and the drift shows up as a leak or a truncated reason rather than as a failing test. So
 * the streamed turn calls this, and `stream-refusal.test.ts` pins its output against the JSON path's for the
 * same body, which is the only way the rule stays one rule.
 */
export function routeApiError(status: number, body: unknown): ApiError {
  const error = (body as { error?: RouteErrorBody } | null | undefined)?.error
  const code = error?.code ?? 'unknown'
  const fallback = error?.message ?? t('api.request_failed_status', { status })
  return new ApiError(
    status,
    code,
    translateApiError(code, fallback),
    error?.details,
    serverReason(error?.message, error?.details),
  )
}

/** How much of a file's name a refusal line may hold; the chip beside it already carries the whole name. */
const TRANSFER_NAME_MAX_CHARS = 60

/**
 * The refusal of a bulk transfer, told with the file it was about.
 *
 * The upload and the download own their transport — a progress bar needs byte counts that `fetch` never
 * reports — so neither can throw from inside `request()`. They used to invent the whole sentence: the route's
 * `message` as the headline, or a bare status code when it had none. That lost twice. A composer holding four
 * attachments and one refusal could not say which chip to pull, and the route's own words reached the screen
 * unbounded, unflattened and with any credential it echoed still in them, because the policy that keeps those
 * out lives in the factory.
 *
 * So the headline stays the transfer's own line, naming which direction and which status, and the reason rides
 * beside it as the detail every other surface already prints. The detail comes out of `routeApiError()` rather
 * than being assembled again here: how much of a route's sentence a screen may hold is one policy, and a
 * second place to state it is a second place it can drift.
 */
function transferApiError(status: number, body: unknown, headline: string): ApiError {
  const failure = routeApiError(status, body)
  return new ApiError(status, failure.code, headline, failure.details, failure.serverMessage)
}

export interface RequestOptions {
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
  /**
   * A conditional write's precondition: the revision the caller read. Sent as `If-Match`, which the
   * task routes compare with the row's own revision before they write.
   */
  ifMatch?: string
  /**
   * The key that makes a retried create one create. Sent as `Idempotency-Key`, which the task route
   * answers through the same operation table every MCP write already uses: a create the server landed
   * but whose response was lost is answered with the row it wrote, not with a second one.
   */
  idempotencyKey?: string
  onEtag?: (etag: string | null) => void
  /** A question about *now* must not be answered from the cache; a stored "where is the talk" is a
   * different question's answer. */
  cache?: RequestCache
}

/** What a channel fan-out cost, as the worker reports it after one message. */
export interface DispatchSummary {
  attempted: number
  successCount: number
  failedCount: number
}

/** The fields of a payment a reader may correct; the period is the receipt's, not theirs to edit. */
export interface PaymentPatch {
  date?: string
  amount?: number
  currency?: CurrencyCode
  note?: string
}

/** The settings a save may carry. Anything left out keeps what the account already had. */
export interface SettingsPatch {
  timezone?: string
  notificationHours?: string[]
  showLunar?: boolean
  paymentHistoryLimit?: number
  locale?: NotifyLocale
  baseCurrency?: CurrencyCode
  budgetMonthly?: number | null
  budgetYearly?: number | null
  budgetCategories?: Record<string, number>
  rateOverrides?: Record<string, number>
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, formData, timeoutMs, ifNoneMatch, ifMatch, idempotencyKey, onEtag, cache } = options

  const headers: Record<string, string> = {
    [CLIENT_HEADER]: '1',
    'X-Inkstone-Origin': CLIENT_ID,
    'Accept-Language': getLocale(),
  }
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch
  if (ifMatch) headers['If-Match'] = ifMatch
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
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

    if (!response.ok) throw routeApiError(response.status, data)

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
    throw routeApiError(response.status, data)
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
 * One calendar subscription as its owner's settings screen reads it.
 *
 * The worker's public reader (`routes/todo-feeds.ts`) owns the document; this is the management half:
 * the untrusted slug, the address built from it, whether a passcode stands in front of it, and the two
 * timestamps. A passcode hash has no field here and never travels — `hasPassword` is the whole marker.
 *
 * `url` is the route's answer for convenience, but the screen rebuilds the address from its own
 * `window.location.origin`: behind a proxy the origin the worker saw is not necessarily the one the
 * reader can reach, and a copied subscription has to be reachable from their calendar.
 */
export interface TodoFeedInfo {
  slug: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  createdAt: number
}

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
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText || 'null') as unknown
      } catch {
        // A gateway's HTML page, a truncated write: the status is all the answer says, so the headline the
        // transfer owns stays the whole story rather than quoting markup back at the reader.
        body = null
      }
      const attachment = (body as { attachment?: ChatAttachment } | null)?.attachment
      if (xhr.status >= 200 && xhr.status < 300 && attachment) {
        onProgress(file.size, file.size)
        resolve(attachment)
        return
      }
      reject(transferApiError(
        xhr.status,
        body,
        `Upload failed (${xhr.status}): ${truncateText(file.name, TRANSFER_NAME_MAX_CHARS)}`,
      ))
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
  if (!response.ok) {
    const data = isJsonResponse(response)
      ? await response.json().catch(() => null)
      : null
    throw transferApiError(response.status, data, `Download failed (${response.status})`)
  }
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

/**
 * What one session import did, as the route answered it.
 *
 * `src/worker/assistant/session-import.ts` owns this shape and the worker module is not something the
 * display layer may reach into, so the fields are restated here rather than imported. What keeps the two
 * agreeing is `tests/assistant-session-import.test.ts`, which reads the route's own answer and asserts
 * every one of these numbers against the tables.
 */
export interface SessionImportSummary {
  threads: number
  messages: number
  alreadyImported: number
  skipped: string[]
}

/**
 * Whether this deployment can push at all, and what a browser needs in order to subscribe.
 *
 * `src/worker/assistant/push.ts` owns this shape (`pushConfigStatus`) and the display layer may not reach
 * into a worker module, so it is restated here the way `SessionImportSummary` is. `reason` is the server's
 * own sentence about which variable is missing, which is why `enabled: false` is never a bare no — and why a
 * screen that hides its switch has something to say in its place.
 */
export interface PushConfig {
  enabled: boolean
  publicKey: string | null
  reason?: string
}

/**
 * One device as the account's own list describes it: the push service's origin and a digest, never the
 * credential or any piece of its path.
 *
 * The tail of an endpoint is the ability to place a notification on that machine, and this answer travels
 * through browser logs, screenshots and the clipboard, so the route hands back `<origin>#<digest>`. The
 * digest is one-way and path-independent on purpose: on a short-path service the whole token *is* the first
 * path segment, so no prefix of the endpoint may be echoed. Which of these rows is the reader's own device is
 * answered by `id` — the row id the subscription write returned — and never by comparing endpoint text.
 */
export interface PushSubscriptionRow {
  id: string
  endpoint: string
  createdAt: number
  failures: number
  lastError: string | null
}

/** The triple the browser produced, in the spelling the subscription route validates. */
export interface PushSubscriptionPayload {
  endpoint: string
  keys: { p256dh: string, auth: string }
}

/**
 * Reads the quick-add offset into the absolute reminder list the route accepts.
 *
 * The inline quick-add still speaks "15 minutes before" because that is what a person types, and the
 * editor speaks absolute instants because that is what a reminder is. The conversion happens here,
 * at the network boundary, so the offset never reaches the worker — the route has one shape to
 * validate and the stored row has one meaning. An explicit `reminders` list wins over the offset; a
 * body carrying neither is sent untouched.
 */
function withReminderList(body: Record<string, unknown>): Record<string, unknown> {
  if (!('remind' in body)) return body
  const { remind, ...rest } = body
  if (Array.isArray(rest.reminders)) return rest
  const dueAt = rest.dueAt
  if (typeof dueAt !== 'number' || typeof remind !== 'string') return rest
  if (remind === 'none') return { ...rest, reminders: [] }
  const delay = REMIND_OFFSET_MS[remind as RemindTier]
  if (delay === undefined) return rest
  return { ...rest, reminders: [dueAt - delay] }
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

  calendar: {
    meta: () => request<CalendarMetaDto>('/api/calendar/meta'),
    events: (query: { from: string | number; to: string | number; calendarIds?: string[]; limit?: number }) =>
      request<{ events: CalendarEventDto[] }>(`/api/calendar/events${toQuery({
        from: query.from,
        to: query.to,
        calendarIds: query.calendarIds?.join(','),
        limit: query.limit,
      })}`),
    search: (q: string, limit = 20) =>
      request<{ results: CalendarSearchResultDto[]; truncated: boolean }>(
        `/api/calendar/events/search${toQuery({ q, limit })}`,
      ),
    createEvent: (event: CalendarEventInput) =>
      request<{ event: CalendarEventDto }>('/api/calendar/events', { method: 'POST', body: event }),
    createEvents: (events: CalendarEventInput[], mode: 'create' | 'upsert') =>
      request<{ events: CalendarEventDto[] }>('/api/calendar/events/batch', { method: 'POST', body: { events, mode } }),
    updateEvent: (id: string, patch: CalendarEventPatch) =>
      request<{ event: CalendarEventDto }>(`/api/calendar/events/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      }),
    deleteEvent: (id: string, rev: number) =>
      request<void>(`/api/calendar/events/${encodeURIComponent(id)}${toQuery({ rev })}`, { method: 'DELETE' }),
    createCalendar: (input: CalendarWriteInput) =>
      request<{ calendar: CalendarDto }>('/api/calendar/calendars', { method: 'POST', body: input }),
    updateCalendar: (id: string, patch: CalendarPatchInput) =>
      request<{ calendar: CalendarDto }>(`/api/calendar/calendars/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      }),
    deleteCalendar: (id: string, query: { mode: 'merge' | 'delete'; targetId?: string; rev?: number }) =>
      request<void>(`/api/calendar/calendars/${encodeURIComponent(id)}${toQuery(query)}`, { method: 'DELETE' }),
    mergeCalendar: (id: string, targetId: string) =>
      request<void>(`/api/calendar/calendars/${encodeURIComponent(id)}/merge`, {
        method: 'POST',
        body: { targetId },
      }),
    reorderCalendars: (ids: string[]) =>
      request<void>('/api/calendar/calendars/order', { method: 'PUT', body: { ids } }),
    createGroup: (input: CalendarGroupWriteInput) =>
      request<{ group: CalendarGroupDto }>('/api/calendar/groups', { method: 'POST', body: input }),
    updateGroup: (id: string, name: string) =>
      request<{ group: CalendarGroupDto }>(`/api/calendar/groups/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { name },
      }),
    deleteGroup: (id: string) =>
      request<void>(`/api/calendar/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    reorderGroups: (ids: string[]) =>
      request<void>('/api/calendar/groups/order', { method: 'PUT', body: { ids } }),
    preferences: () => request<{ preferences: CalendarPreferences }>('/api/calendar/preferences'),
    savePreferences: (preferences: CalendarPreferences) =>
      request<{ preferences: CalendarPreferences }>('/api/calendar/preferences', {
        method: 'PUT',
        body: { preferences },
      }),
  },

  mcp: {
    get: () => request<McpSettingsInfo>('/api/mcp'),
    save: (body: {
      enabled?: boolean
      writeEnabled?: boolean
      trashEnabled?: boolean
      /** Whether a key may read tasks at all. */
      todoReadEnabled?: boolean
      emailEnabled?: boolean
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
  email: {
    getConfig: () => request<EmailConfig>('/api/email/config'),
    getDeployment: () => request<EmailDeploymentSettings>('/api/email/deployment'),
    updateDeployment: (body: EmailDeploymentPatch) =>
      request<EmailDeploymentSettings>('/api/email/deployment', { method: 'PATCH', body }),
    listAccounts: () => request<EmailAccount[]>('/api/email/accounts'),
    createAccount: (body: { localPart: string, domain: string, displayName?: string }) =>
      request<EmailAccount>('/api/email/accounts', { method: 'POST', body }),
    ensureAccounts: () => request<EmailAccount[]>('/api/email/accounts/ensure', { method: 'POST' }),
    getAccount: (id: string) => request<EmailAccount>(`/api/email/accounts/${id}`),
    getAutoDraftStatus: (id: string) => request<{
      status: string | null
      reason: string | null
      attempts: number
      updatedAt: string | null
    }>(`/api/email/accounts/${id}/auto-draft`),
    updateAccount: (id: string, body: { displayName?: string, settings?: unknown }) =>
      request<EmailAccount>(`/api/email/accounts/${id}`, { method: 'PATCH', body }),
    deleteAccount: (id: string) => request<void>(`/api/email/accounts/${id}`, { method: 'DELETE' }),
    listFolders: (id: string) => request<EmailFolder[]>(`/api/email/accounts/${id}/folders`),
    createFolder: (id: string, name: string, parentId?: string | null, color?: string | null) =>
      request<EmailFolder>(`/api/email/accounts/${id}/folders`, {
        method: 'POST',
        body: { name, ...(parentId ? { parentId } : {}), ...(color ? { color } : {}) },
      }),
    updateFolder: (id: string, folderId: string, patch: { name?: string, parentId?: string | null, color?: string | null, sortOrder?: number }) =>
      request<EmailFolder>(`/api/email/accounts/${id}/folders/${folderId}`, { method: 'PATCH', body: patch }),
    deleteFolder: (id: string, folderId: string, deleteEmails = false) =>
      request<void>(`/api/email/accounts/${id}/folders/${folderId}${deleteEmails ? '?deleteEmails=true' : ''}`, { method: 'DELETE' }),
    listTags: (id: string) => request<EmailTag[]>(`/api/email/accounts/${id}/tags`),
    createTag: (id: string, input: EmailTagInput) =>
      request<EmailTag>(`/api/email/accounts/${id}/tags`, { method: 'POST', body: input }),
    updateTag: (id: string, tagId: string, patch: EmailTagPatch) =>
      request<EmailTag>(`/api/email/accounts/${id}/tags/${tagId}`, { method: 'PATCH', body: patch }),
    deleteTag: (id: string, tagId: string) =>
      request<void>(`/api/email/accounts/${id}/tags/${tagId}`, { method: 'DELETE' }),
    attachTag: (id: string, messageId: string, input: EmailMessageTagInput) =>
      request<void>(`/api/email/accounts/${id}/emails/${messageId}/tags`, { method: 'POST', body: input }),
    detachTag: (id: string, messageId: string, tagId: string) =>
      request<void>(`/api/email/accounts/${id}/emails/${messageId}/tags/${tagId}`, { method: 'DELETE' }),
    getStats: (id: string) => request<EmailMailboxStats>(`/api/email/accounts/${id}/stats`),
    listFilters: (id: string) => request<EmailFilter[]>(`/api/email/accounts/${id}/filters`),
    createFilter: (id: string, input: EmailFilterInput) =>
      request<EmailFilter>(`/api/email/accounts/${id}/filters`, { method: 'POST', body: input }),
    updateFilter: (id: string, filterId: string, patch: EmailFilterPatch) =>
      request<EmailFilter>(`/api/email/accounts/${id}/filters/${filterId}`, { method: 'PATCH', body: patch }),
    deleteFilter: (id: string, filterId: string) =>
      request<void>(`/api/email/accounts/${id}/filters/${filterId}`, { method: 'DELETE' }),
    listTemplates: (id: string) =>
      request<EmailTemplate[]>(`/api/email/accounts/${id}/templates`),
    createTemplate: (id: string, input: EmailTemplateInput) =>
      request<EmailTemplate>(`/api/email/accounts/${id}/templates`, { method: 'POST', body: input }),
    updateTemplate: (id: string, templateId: string, patch: EmailTemplatePatch) =>
      request<EmailTemplate>(`/api/email/accounts/${id}/templates/${templateId}`, { method: 'PATCH', body: patch }),
    deleteTemplate: (id: string, templateId: string) =>
      request<void>(`/api/email/accounts/${id}/templates/${templateId}`, { method: 'DELETE' }),
    listSearches: (id: string) =>
      request<EmailSavedSearch[]>(`/api/email/accounts/${id}/searches`),
    createSearch: (id: string, input: EmailSavedSearchInput) =>
      request<EmailSavedSearch>(`/api/email/accounts/${id}/searches`, { method: 'POST', body: input }),
    updateSearch: (id: string, searchId: string, patch: EmailSavedSearchPatch) =>
      request<EmailSavedSearch>(`/api/email/accounts/${id}/searches/${searchId}`, { method: 'PATCH', body: patch }),
    deleteSearch: (id: string, searchId: string) =>
      request<void>(`/api/email/accounts/${id}/searches/${searchId}`, { method: 'DELETE' }),
    listBlockedSenders: (id: string) =>
      request<EmailBlockedSender[]>(`/api/email/accounts/${id}/blocklist`),
    addBlockedSender: (id: string, address: string) =>
      request<EmailBlockedSender>(`/api/email/accounts/${id}/blocklist`, { method: 'POST', body: { address } }),
    removeBlockedSender: (id: string, address: string) =>
      request<void>(`/api/email/accounts/${id}/blocklist/${encodeURIComponent(address)}`, { method: 'DELETE' }),
    blockSender: (id: string, messageId: string) =>
      request<EmailBlockSenderResult>(`/api/email/accounts/${id}/emails/${messageId}/block-sender`, { method: 'POST' }),
    listContacts: (query = '') =>
      request<EmailContact[]>(`/api/email/contacts${query ? `?q=${encodeURIComponent(query)}` : ''}`),
    createContact: (input: EmailContactInput) =>
      request<EmailContact>('/api/email/contacts', { method: 'POST', body: input }),
    updateContact: (contactId: string, patch: EmailContactPatch) =>
      request<EmailContact>(`/api/email/contacts/${contactId}`, { method: 'PATCH', body: patch }),
    deleteContact: (contactId: string) =>
      request<void>(`/api/email/contacts/${contactId}`, { method: 'DELETE' }),
    listGroups: () => request<EmailGroupWithMembers[]>('/api/email/groups'),
    createGroup: (input: EmailGroupInput) =>
      request<EmailGroup>('/api/email/groups', { method: 'POST', body: input }),
    updateGroup: (groupId: string, patch: EmailGroupPatch) =>
      request<EmailGroup>(`/api/email/groups/${groupId}`, { method: 'PATCH', body: patch }),
    deleteGroup: (groupId: string) =>
      request<void>(`/api/email/groups/${groupId}`, { method: 'DELETE' }),
    addGroupMember: (groupId: string, contactId: string) =>
      request<void>(`/api/email/groups/${groupId}/members`, { method: 'POST', body: { contactId } }),
    removeGroupMember: (groupId: string, contactId: string) =>
      request<void>(`/api/email/groups/${groupId}/members/${contactId}`, { method: 'DELETE' }),
    retrySend: (id: string, messageId: string) =>
      request<EmailSendResult>(`/api/email/accounts/${id}/emails/${messageId}/retry`, { method: 'POST' }),
    listEmails: (id: string, params: Record<string, string | number | undefined> = {}) =>
      request<EmailListResponse>(`/api/email/accounts/${id}/emails${toQuery(params)}`),
    getEmail: (id: string, messageId: string) =>
      request<EmailMessage>(`/api/email/accounts/${id}/emails/${messageId}`),
    updateEmail: (id: string, messageId: string, body: { read?: boolean, starred?: boolean, important?: boolean, muted?: boolean }) =>
      request<EmailMessage>(`/api/email/accounts/${id}/emails/${messageId}`, { method: 'PATCH', body }),
    snoozeEmail: (id: string, messageId: string, until: string | number) =>
      request<EmailSnoozeResult>(`/api/email/accounts/${id}/emails/${messageId}/snooze`, {
        method: 'POST',
        body: { until },
      }),
    setFollowUp: (id: string, messageId: string, at: string | null) =>
      request<EmailMessage>(`/api/email/accounts/${id}/emails/${messageId}/follow-up`, {
        method: 'POST',
        body: { at },
      }),
    batchEmails: (id: string, input: EmailBatchInput) =>
      request<EmailBatchResult>(`/api/email/accounts/${id}/emails/batch`, { method: 'POST', body: input }),
    deleteEmail: (id: string, messageId: string, permanent = false) =>
      request<void>(`/api/email/accounts/${id}/emails/${messageId}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),
    moveEmail: (id: string, messageId: string, folderId: string) =>
      request<void>(`/api/email/accounts/${id}/emails/${messageId}/move`, { method: 'POST', body: { folderId } }),
    restoreEmail: (id: string, messageId: string) =>
      request<void>(`/api/email/accounts/${id}/emails/${messageId}/restore`, { method: 'POST' }),
    listTrash: (id: string, params: Record<string, string | number | undefined> = {}) =>
      request<EmailListResponse>(`/api/email/accounts/${id}/trash${toQuery(params)}`),
    emptyTrash: (id: string) =>
      request<void>(`/api/email/accounts/${id}/trash?confirm=true`, { method: 'DELETE' }),
    getThread: (id: string, threadId: string) =>
      request<EmailMessage[]>(`/api/email/accounts/${id}/threads/${threadId}`),
    markThreadRead: (id: string, threadId: string) =>
      request<void>(`/api/email/accounts/${id}/threads/${threadId}/read`, { method: 'POST' }),
    muteThread: (id: string, threadId: string, muted: boolean) =>
      request<void>(`/api/email/accounts/${id}/threads/${encodeURIComponent(threadId)}/mute`, {
        method: 'POST',
        body: { muted },
      }),
    send: (id: string, body: EmailSendInput) =>
      request<EmailSendResult>(`/api/email/accounts/${id}/emails`, { method: 'POST', body }),
    reply: (id: string, messageId: string, body: EmailSendInput) =>
      request<EmailSendResult>(`/api/email/accounts/${id}/emails/${messageId}/reply`, { method: 'POST', body }),
    forward: (id: string, messageId: string, body: EmailSendInput) =>
      request<EmailSendResult>(`/api/email/accounts/${id}/emails/${messageId}/forward`, { method: 'POST', body }),
    saveDraft: (id: string, draft: EmailDraftInput) =>
      request<{ draftId: string }>(`/api/email/accounts/${id}/drafts`, { method: 'POST', body: draft }),
    sendDraft: (id: string, draftId: string, body: EmailSendInput) =>
      request<EmailSendResult>(`/api/email/accounts/${id}/drafts/${draftId}/send`, { method: 'POST', body }),
    scheduleDraftSend: (id: string, draftId: string, body: EmailScheduledSendInput) =>
      request<EmailScheduledSend>(`/api/email/accounts/${id}/drafts/${draftId}/schedule`, { method: 'POST', body }),
    cancelScheduledSend: (id: string, jobId: string) =>
      request<void>(`/api/email/accounts/${id}/scheduled/${jobId}`, { method: 'DELETE' }),
    listScheduledSends: (id: string) =>
      request<EmailScheduledSend[]>(`/api/email/accounts/${id}/scheduled`),
    linkAttachment: (
      id: string,
      draftId: string,
      attachmentId: string,
      options: { inline?: boolean; contentId?: string } = {},
    ) =>
      request<{ attachmentId: string; contentId: string | null; disposition: string | null }>(
        `/api/email/accounts/${id}/drafts/${draftId}/attachments`,
        { method: 'POST', body: { attachmentId, ...options } },
      ),
    unlinkAttachment: (id: string, draftId: string, attachmentId: string) =>
      request<void>(`/api/email/accounts/${id}/drafts/${draftId}/attachments/${attachmentId}`, { method: 'DELETE' }),
    search: (id: string, params: Record<string, string | number | undefined>) =>
      request<EmailListResponse>(`/api/email/accounts/${id}/search${toQuery(params)}`),
    attachmentUrl: (attachmentId: string) => `/api/email/files/${attachmentId}`,
    exportAccount: async (id: string) => {
      const { response, filename } = await fetchDownload(
        `/api/email/accounts/${encodeURIComponent(id)}/export`,
        'inkstone-email.zip',
      )
      await saveResponseDownload(response, filename)
    },
    downloadEml: async (id: string, messageId: string, fallbackName = 'message.eml') => {
      const { response, filename } = await fetchDownload(
        `/api/email/accounts/${encodeURIComponent(id)}/emails/${encodeURIComponent(messageId)}/raw`,
        fallbackName,
      )
      await saveResponseDownload(response, filename)
    },
  },

  todos: {
    /**
     * One page of the listing the to-do screen states.
     *
     * Every filter is a parameter and the answer is the server's: the view, the collection, the search
     * text and the offset are decided in SQL, and `total` says how many rows match beside the page.
     */
    list: (params: {
      status?: string, view?: string, list?: string, tag?: string, priority?: string, starred?: string,
      q?: string, dueFrom?: string, dueTo?: string, completedFrom?: string, completedTo?: string,
      archived?: string, scope?: string,
      sort?: string, limit?: number, offset?: number
    } = {}) =>
      request<TaskPage>(`/api/todos${toQuery(params)}`),
    get: (id: string) => request<{ task: TodoTask, steps: TaskStep[] }>(`/api/todos/${id}`),
    /**
     * A new task.
     *
     * `idempotencyKey` is what a replay of a queued create sends: the row the queue already holds is
     * the one operation the server must recognise twice, and a fresh press from the app names none.
     */
    create: (body: Record<string, unknown>, idempotencyKey?: string) =>
      request<{ task: TodoTask }>('/api/todos', {
        method: 'POST',
        body: withReminderList(body),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),
    /**
     * `next` is present when the patch finished a repeating task and it filed the next occurrence.
     *
     * `rev` is the revision the row was read at. Naming it makes the write conditional: a stale one is
     * refused with a 409 instead of replacing an edit this client never saw.
     */
    update: (id: string, body: Record<string, unknown>, rev?: number) =>
      request<{ task: TodoTask, next?: TodoTask }>(`/api/todos/${id}`, {
        method: 'PATCH',
        body: withReminderList(body),
        ...(rev === undefined ? {} : { ifMatch: String(rev) }),
      }),
    /**
     * Picks a task into a day, or takes it back out with `null`.
     *
     * The day is an account-zone `YYYY-MM-DD`, not an instant: "planned for today" is a calendar
     * membership that lapses on its own when the day changes, not a timestamp that has to be cleared.
     * `rev` names the revision the row was read at, so a pick computed from a stale screen is refused
     * rather than painted over whatever the row became in the meantime.
     */
    plan: (id: string, date: string | null, rev?: number) =>
      request<{ task: TodoTask }>(`/api/todos/${id}/plan`, {
        method: 'POST',
        body: { date },
        ...(rev === undefined ? {} : { ifMatch: String(rev) }),
      }),
    /**
     * Places a task before another row, or at the end when `beforeId` is null.
     *
     * `listId` is absent for a move inside the task's own list, null for the inbox, and an id for a
     * cross-list move — the destination and the place land in one write, so a task never sits in the
     * old list with a position meant for the new one.
     */
    move: (id: string, body: { beforeId: string | null, listId?: string | null }) =>
      request<{ task: TodoTask }>(`/api/todos/${id}/move`, { method: 'POST', body }),
    /**
     * "Remind me again": adds one reminder `minutes` from now and answers with the whole pending list.
     * The earlier reminders stay — a snooze is a second chance, not a cancellation. `rev` is the same
     * conditional guard a pick carries, so a snooze replayed from a row that moved since is refused.
     */
    snooze: (id: string, minutes: SnoozeMinutes, rev?: number) =>
      request<{ task: TodoTask, reminders: number[] }>(`/api/todos/${id}/snooze`, {
        method: 'POST',
        body: { minutes },
        ...(rev === undefined ? {} : { ifMatch: String(rev) }),
      }),
    /**
     * The account's one running interval, started on this task.
     *
     * A live press names no instant: "now" is the server's clock, and only a client that was away from
     * the network has a timestamp of its own to defend. Another task's interval is closed where this
     * one begins — the database holds "at most one open row", not this screen's politeness — and a
     * start that is already running answers with the row that is.
     */
    startTimer: (id: string, body: { startAt?: number } = {}) =>
      request<{ entry: TodoTimeEntry }>(`/api/todos/${id}/timer/start`, { method: 'POST', body }),
    /**
     * Stop this task's running interval, split into one row per account day it crossed.
     *
     * `endAt` is absent for the same reason `startAt` is: a reader who presses the button while the
     * device is online means "now", and the server's now is the one the ledger trusts. A 404 means
     * nothing was running on this task, which is the state a stop wants.
     */
    stopTimer: (id: string, body: { endAt?: number } = {}) =>
      request<{ entries: TodoTimeEntry[] }>(`/api/todos/${id}/timer/stop`, { method: 'POST', body }),
    /**
     * Back-fill one span by hand: the answer to "I worked on this and never started the timer".
     *
     * The caller names both ends, because unlike the two timer gestures this one is *about* a period
     * that has already happened. The route refuses a span past its ceiling with a reason rather than
     * trimming it, and splits what crossed the account's midnight into one row per day.
     */
    addTime: (id: string, body: { startAt: number, endAt: number }) =>
      request<{ entries: TodoTimeEntry[] }>(`/api/todos/${id}/time`, { method: 'POST', body }),
    remove: (id: string) => request<{ deleted: true }>(`/api/todos/${id}`, { method: 'DELETE' }),

    /**
     * The trash and its two doors.
     *
     * `trash` pages the rows every other read hides, newest deletion first. `restore` puts the same
     * row back — the undo after a delete uses it rather than creating a copy — and `purge` removes a
     * trashed row for good; both answer 404 for a live task or another account's id.
     */
    trash: (params: { limit?: number, offset?: number } = {}) =>
      request<TaskTrashPage>(`/api/todos/trash${toQuery(params)}`),
    restore: (id: string) =>
      request<{ task: TodoTask, droppedReminders: number }>(`/api/todos/${id}/restore`, { method: 'POST' }),
    purge: (id: string) => request<{ purged: true }>(`/api/todos/${id}/purge`, { method: 'DELETE' }),

    /**
     * One change applied to a set of tasks.
     *
     * The answer is always 200 and names both halves: the ids that changed and the ids that did not,
     * with the reason. A row from another account is `not found`, exactly as it would be on its own
     * route, so a partial answer never tells the caller which ids exist elsewhere.
     */
    batch: (body: { ids: string[], op: TaskBatchRequestOp, value?: string | string[] | null }) =>
      request<TaskBatchResult>('/api/todos/batch', { method: 'POST', body }),

    /**
     * One range of the account's statistics.
     *
     * The bounds are account-zone calendar days; leaving them out asks for the route's own default
     * (the last 30 days), and the answer echoes the range it actually measured so the client never
     * has to guess which days the numbers describe.
     */
    /**
     * The worklog over a window, grouped one dimension at a time.
     *
     * Its own request rather than a field of `stats`: the two read different tables and answer about
     * different things, and a screen that shows only one should not pay for the other.
     */
    worklog: (params: { from: string, to: string, group?: string }) =>
      request<Worklog>(`/api/todos/worklog${toQuery(params)}`),
    /**
     * The end-of-day pass: what the day finished, what it touched and left open, what fell behind, and
     * what tomorrow already holds.
     *
     * One request rather than four listings, because this screen files rows while it is open: four reads
     * made one at a time would let the third answer describe a day the first two had already changed.
     */
    finishDay: (params: { day?: string, limit?: number } = {}) =>
      request<FinishDay>(`/api/todos/finish-day${toQuery(params)}`),
    stats: (params: { from?: string, to?: string, bucket?: TaskStatsBucket } = {}) =>
      request<TodoStats>(`/api/todos/stats${toQuery(params)}`),

    /**
     * The habits screen: every habit with the days behind it, in one read.
     *
     * The days travel with the rows because the screen shades a year under every name; asking per habit
     * would be one round trip per habit, and the server already reads them in one pass.
     */
    counters: () => request<CounterReadings>('/api/todos/counters'),
    createCounter: (body: { title: string, kind?: CounterKind, goal?: number | null, icon?: string | null, color?: string | null }) =>
      request<{ counter: TodoCounter }>('/api/todos/counters', { method: 'POST', body }),
    updateCounter: (id: string, body: { title?: string, kind?: CounterKind, goal?: number | null, icon?: string | null, color?: string | null }) =>
      request<{ counter: TodoCounter }>(`/api/todos/counters/${id}`, { method: 'PATCH', body }),
    removeCounter: (id: string) =>
      request<{ deleted: true }>(`/api/todos/counters/${id}`, { method: 'DELETE' }),
    /**
     * One press on one habit. `day` is the only way a habit reaches a past date, and the server decides
     * which day a press lands on when the caller names none.
     */
    tickCounter: (id: string, body: { delta: number, day?: string }) =>
      request<CounterTick>(`/api/todos/counters/${id}/tick`, { method: 'POST', body }),
    startCounter: (id: string) =>
      request<{ counter: TodoCounter }>(`/api/todos/counters/${id}/timer/start`, { method: 'POST' }),
    /** The server's own clock starts and stops the run; a device never names the instant it began. */
    stopCounter: (id: string) =>
      request<CounterStop>(`/api/todos/counters/${id}/timer/stop`, { method: 'POST' }),

    addStep: (id: string, text: string) =>
      request<{ step: TaskStep }>(`/api/todos/${id}/steps`, { method: 'POST', body: { text } }),
    updateStep: (id: string, stepId: string, body: { text?: string, done?: boolean }) =>
      request<{ step: TaskStep }>(`/api/todos/${id}/steps/${stepId}`, { method: 'PATCH', body }),
    removeStep: (id: string, stepId: string) =>
      request<{ deleted: true }>(`/api/todos/${id}/steps/${stepId}`, { method: 'DELETE' }),

    lists: (params: { archived?: '1' } = {}) =>
      request<{ lists: TaskListEntry[] }>(`/api/todos/lists${toQuery(params)}`),
    createList: (body: { name: string, icon?: string | null, color?: string | null }) =>
      request<{ list: TaskListEntry }>('/api/todos/lists', { method: 'POST', body }),
    updateList: (id: string, body: { name?: string, icon?: string | null, color?: string | null, position?: number, archived?: boolean, parentId?: string | null }) =>
      request<{ list: TaskListEntry }>(`/api/todos/lists/${id}`, { method: 'PATCH', body }),
    removeList: (id: string) => request<{ deleted: true }>(`/api/todos/lists/${id}`, { method: 'DELETE' }),

    tags: () => request<{ tags: TaskTag[] }>('/api/todos/tags'),
    createTag: (body: { name: string, color?: string | null }) =>
      request<{ tag: TaskTag }>('/api/todos/tags', { method: 'POST', body }),
    updateTag: (id: string, body: { name?: string, color?: string | null }) =>
      request<{ tag: TaskTag }>(`/api/todos/tags/${id}`, { method: 'PATCH', body }),
    removeTag: (id: string) => request<{ deleted: true }>(`/api/todos/tags/${id}`, { method: 'DELETE' }),

    /**
     * Import tasks from a CSV the reader picked.
     *
     * The file is the document; `conflict` is the one rule it cannot answer for itself — keep what is here,
     * let the file win, or file a second copy. Rows the parser refused come back in `errors` while the rest
     * still land, so the screen can honestly print both numbers.
     */
    importCsv: (file: File, conflict: 'skip' | 'newer' | 'duplicate' = 'skip') => {
      const form = new FormData()
      form.append('file', file)
      form.append('conflict', conflict)
      return request<{
        created: number
        updated: number
        skipped: number
        missingLists: number
        errors: { line: number, reason: string }[]
      }>('/api/todos/import', { method: 'POST', formData: form })
    },

    /**
     * The calendar subscriptions this account published.
     *
     * `create` mints a new address every time — a feed is never replaced, and revoking one never frees
     * its slug. The passcode is an optional plaintext on the way in only; the answer carries the
     * `hasPassword` marker, and a protected feed's subscriber appends `?key=` to the copied address.
     */
    feed: {
      list: () => request<{ feeds: TodoFeedInfo[] }>('/api/todos/feed'),
      create: (body: { password?: string | null, expiresIn?: number | null } = {}) =>
        request<{ feed: TodoFeedInfo }>('/api/todos/feed', { method: 'POST', body }),
      remove: (slug: string) =>
        request<{ ok: true }>(`/api/todos/feed/${slug}`, { method: 'DELETE' }),
    },
  },

  assistant: {
    /** The conversations that wrote one note: the note's own "from a conversation" backlinks. */
    noteWrites: (noteId: string, signal?: AbortSignal) =>
      request<{ conversations: { id: string, title: string, updatedAt: number }[] }>(
        `/api/assistant/note-writes${toQuery({ noteId })}`, { signal },
      ),
    /** A note the browser wrote from a reply: the worker cannot see that save, so the client reports it. */
    recordNoteWrite: (noteId: string, conversationId: string) =>
      request<{ ok: true }>('/api/assistant/note-writes', { method: 'POST', body: { noteId, conversationId } }),
    conversations: (params: { q?: string, folder?: string, project?: string, tag?: string, noteId?: string, starred?: string, pinned?: string, archived?: string, limit?: string, cursor?: string } = {}, signal?: AbortSignal) =>
      request<{ conversations: AssistantConversation[], nextCursor: string | null }>(`/api/assistant/conversations${toQuery(params)}`, { signal }),
    createConversation: (title?: string, folderId?: string | null, ephemeral = false) =>
      request<{ conversation: AssistantConversation }>('/api/assistant/conversations', {
        method: 'POST',
        body: { title, ...(folderId === undefined ? {} : { folderId }), ...(ephemeral ? { ephemeral: true } : {}) },
      }),
    /** A folder from the notebook's tree; null files the conversation back to unfiled. */
    setConversationProject: (id: string, projectId: string | null) =>
      request<{ conversation: AssistantConversation }>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: { projectId } }),
    /**
     * Which note this thread was started from.
     *
     * An id is the label the chat's origin chip carries, and the worker keeps the first answer, so naming a
     * second note cannot move it under the reader. Null is the reader taking the label off — the one write
     * that is allowed to overwrite it, because a thread mislabelled at creation is otherwise stuck there.
     */
    setConversationNote: (id: string, noteId: string | null) =>
      request<{ conversation: AssistantConversation }>(`/api/assistant/conversations/${id}`, { method: 'PATCH', body: { noteId } }),
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
        /**
         * What a turn that stopped renewing had already written, and whether the ceiling on the run lease
         * cut it short. Present while `streaming` is true as well as after it turns false, which is the only
         * way the words a killed Worker wrote can reach the screen at all.
         */
        partialText: string | null,
        partialTruncated: boolean,
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
    updateConversationArtifact: (id: string, artifactId: string, body: {
      title?: string
      content?: string
      noteId?: string | null
      baseVersion?: number
      source?: 'user' | 'assistant'
      messageId?: string | null
    }) =>
      request<{ artifact: AssistantArtifact }>(
        `/api/assistant/conversations/${id}/artifacts/${artifactId}`, { method: 'PATCH', body },
      ),
    removeConversationArtifact: (id: string, artifactId: string) =>
      request<{ ok: true }>(`/api/assistant/conversations/${id}/artifacts/${artifactId}`, { method: 'DELETE' }),
    /** The snapshots of one draft, newest first and without their bodies. */
    conversationArtifactVersions: (id: string, artifactId: string) =>
      request<{ versions: AssistantArtifactVersion[] }>(`/api/assistant/conversations/${id}/artifacts/${artifactId}/versions`),
    conversationArtifactVersion: (id: string, artifactId: string, versionId: string) =>
      request<{ version: AssistantArtifactVersion }>(`/api/assistant/conversations/${id}/artifacts/${artifactId}/versions/${versionId}`),
    restoreConversationArtifact: (id: string, artifactId: string, versionId: string) =>
      request<{ artifact: AssistantArtifact }>(
        `/api/assistant/conversations/${id}/artifacts/${artifactId}/versions/${versionId}/restore`, { method: 'POST' },
      ),
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
    forkConversation: (conversationId: string, messageId: string, title: string, ephemeral = false) =>
      request<{ conversation: AssistantConversation, messages: AssistantMessage[] }>(
        `/api/assistant/conversations/${conversationId}/fork`,
        { method: 'POST', body: { messageId, title, ...(ephemeral ? { ephemeral: true } : {}) } },
      ),
    /** The reader's verdict on one answer, or null to take it back. Grounds travel with a downvote only. */
    rateAnswer: (conversationId: string, messageId: string, feedback: MessageFeedback | null, reason?: string) =>
      request<{ message: AssistantMessage }>(
        `/api/assistant/conversations/${conversationId}/messages/${messageId}/feedback`,
        { method: 'PATCH', body: { feedback, ...(reason === undefined || reason === '' ? {} : { reason }) } },
      ),
    /**
     * Keep one turn, or take it back off the shelf.
     *
     * The press toggles and there is nothing to send: the answer is what the row holds once the write has
     * landed, which is the only state the caller is allowed to paint.
     */
    setMessageSaved: (conversationId: string, messageId: string) =>
      request<{ conversationId: string, messageId: string, saved: boolean, savedAt: number | null }>(
        `/api/assistant/conversations/${conversationId}/messages/${messageId}/saved`,
        { method: 'POST' },
      ),
    /**
     * The answers the reader kept, most recently kept first, each with the thread it belongs to.
     *
     * `cursor` is the opaque one the previous page handed back: the route refuses a caller that composes
     * its own rather than answering it with the first page again, so this method only ever forwards what it
     * was given. `SavedMessage` and `nextCursor` are the worker's own shape (`listSavedMessages` in
     * `src/worker/assistant/store.ts`), and `tests/assistant-saved-message.test.ts` is what keeps the two
     * agreeing — it reads this route's answer and asserts every row and both page bounds.
     */
    savedMessages: (params: { cursor?: string, limit?: number } = {}, signal?: AbortSignal) =>
      request<{ items: SavedMessage[], nextCursor: string | null }>(
        `/api/assistant/saved-messages${toQuery(params)}`,
        { signal },
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
    memories: (params: { q?: string, status?: string, category?: string, noteId?: string } = {}) =>
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
    projects: () => request<{ projects: AssistantProject[] }>('/api/assistant/projects'),
    getProject: (id: string) => request<{ project: AssistantProject }>(`/api/assistant/projects/${id}`),
    createProject: (body: { name: string, description?: string, instructions?: string, noteScope?: string[], noteIds?: string[], modelId?: string | null }) =>
      request<{ project: AssistantProject }>('/api/assistant/projects', { method: 'POST', body }),
    updateProject: (id: string, body: { name?: string, description?: string, instructions?: string, noteScope?: string[], noteIds?: string[], modelId?: string | null }) =>
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
    /** Whether this deployment can push, and with which public key. Nothing here invents an answer. */
    pushConfig: () => request<PushConfig>('/api/assistant/push/config'),
    /**
     * The account's devices, read without writing anything first.
     *
     * This is what lets a settings screen open with the truth on it instead of with nothing: the write routes
     * answer with the same list, but only once a device has been added or removed. The rows are the redacted
     * view — endpoint digest and row id — so nothing here carries a credential.
     */
    pushSubscriptions: () => request<{ subscriptions: PushSubscriptionRow[] }>('/api/assistant/push/subscriptions'),
    /**
     * Hands this browser's subscription to the account.
     *
     * The answer is the account's whole device list plus `deviceId`, the row this endpoint resolves to. The
     * id is the only handle that can point at "my row" once the list carries digests instead of path heads,
     * so the write reports it rather than leaving the screen to compare endpoint text.
     */
    subscribePush: (body: PushSubscriptionPayload) =>
      request<{ subscriptions: PushSubscriptionRow[], deviceId: string }>('/api/assistant/push/subscriptions', { method: 'POST', body }),
    /**
     * Takes one row out of the account's device list, by the id the list gave.
     *
     * Not by its endpoint: the list only ever carries a digest of one, and the path behind it is the
     * credential. The row id is the handle the reader's own screen holds, and the answer is the list that
     * remains.
     */
    unsubscribePush: (id: string) =>
      request<{ removed: boolean, subscriptions: PushSubscriptionRow[] }>(`/api/assistant/push/subscriptions/${id}`, { method: 'DELETE' }),
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
    /**
     * What is left in each of a provider's keys.
     *
     * The worker asks the vendor and hands back a reading per key row; no credential travels in either
     * direction, and `supported: false` is the answer for a provider that does not report one.
     */
    providerBalance: (id: string) => request<ProviderBalanceAnswer>(`/api/assistant/providers/${id}/balance`),
    /**
     * The key one hosted web-search engine is queried with, and its state.
     *
     * `hasKey` and the last four characters are the whole of what comes back — the same bargain a provider's
     * key makes. Writing is a `PUT` rather than a `POST` because an engine holds exactly one key: writing it
     * again replaces it, and there is no second credential a vendor would have to guess between.
     */
    searchKeys: () => request<{ keys: AssistantSearchKey[] }>('/api/assistant/search-keys'),
    putSearchKey: (engine: string, body: { apiKey: string }) =>
      request<{ key: AssistantSearchKey }>(`/api/assistant/search-keys/${encodeURIComponent(engine)}`, { method: 'PUT', body }),
    deleteSearchKey: (engine: string) =>
      request<{ deleted: true }>(`/api/assistant/search-keys/${encodeURIComponent(engine)}`, { method: 'DELETE' }),
    models: () => request<{ models: AssistantModel[] }>('/api/assistant/models'),
    /** A short-lived credential for a realtime voice session; the long-lived provider key stays server-side. */
    realtimeSession: (modelId?: string) =>
      request<{ session: AssistantRealtimeSession }>(
        '/api/assistant/realtime/session', { method: 'POST', body: modelId ? { modelId } : {} },
      ),
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
    /**
     * One chat log exported somewhere else, read in as threads of this account.
     *
     * The text rather than the `File`: the route reads a bounded JSON body the same way the backup import
     * beside it does, and the byte ceiling that counts is the one the worker applies to the text.
     */
    importSessionFile: (payload: { filename: string, text: string }) =>
      request<{ imported: SessionImportSummary }>('/api/assistant/sessions/import', { method: 'POST', body: payload }),
  },

  /**
   * The subscription app.
   *
   * One bundle call and then per-entity writes: the app is opened rarely and read all at once, while
   * every change afterwards is one row. `bundle()` is the only request that carries the overview with
   * it, because recomputing a year of spending after every edit would make a toggle feel like a reload.
   */
  subscriptions: {
    bundle: () => request<SubscriptionBundle>('/api/subscriptions'),
    /**
     * Drop the cached day of exchange rates and read a fresh one.
     *
     * The answer is where the numbers now came from, not the numbers: the dashboard redraws from the
     * bundle it already refetches, and a second copy of those totals here could only ever disagree.
     */
    refreshRates: () =>
      request<{ source: 'feed' | 'approximate', at: number | null }>('/api/subscriptions/rates/refresh', { method: 'POST' }),
    create: (input: SubscriptionInput) =>
      request<SubscriptionDetail>('/api/subscriptions', { method: 'POST', body: input }),
    detail: (id: string) => request<SubscriptionDetail>(`/api/subscriptions/${encodeURIComponent(id)}`),
    update: (id: string, input: SubscriptionInput) =>
      request<SubscriptionDetail>(`/api/subscriptions/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
    remove: (id: string) =>
      request<{ ok: true }>(`/api/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    trashList: () => request<{ items: SubscriptionItem[] }>('/api/subscriptions/trash'),
    search: (query: string, limit?: number) =>
      request<{ items: SubscriptionItem[] }>(
        `/api/subscriptions/search?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ''}`,
      ),
    restore: (id: string) =>
      request<SubscriptionDetail>(`/api/subscriptions/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
    purge: (id: string) =>
      request<{ ok: true }>(`/api/subscriptions/${encodeURIComponent(id)}/purge`, { method: 'DELETE' }),
    emptyTrash: () => request<{ purged: number }>('/api/subscriptions/trash/empty', { method: 'POST' }),
    toggle: (id: string, isActive: boolean) =>
      request<SubscriptionDetail>(`/api/subscriptions/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
        body: { isActive },
      }),
    renew: (id: string, options: RenewOptions) =>
      request<SubscriptionDetail>(`/api/subscriptions/${encodeURIComponent(id)}/renew`, {
        method: 'POST',
        body: options,
      }),
    testNotify: (id: string) =>
      request<{ result: DispatchSummary }>(`/api/subscriptions/${encodeURIComponent(id)}/test-notify`, { method: 'POST' }),
    updatePayment: (id: string, paymentId: string, patch: PaymentPatch) =>
      request<SubscriptionDetail>(
        `/api/subscriptions/${encodeURIComponent(id)}/payments/${encodeURIComponent(paymentId)}`,
        { method: 'PUT', body: patch },
      ),
    deletePayment: (id: string, paymentId: string) =>
      request<SubscriptionDetail>(
        `/api/subscriptions/${encodeURIComponent(id)}/payments/${encodeURIComponent(paymentId)}`,
        { method: 'DELETE' },
      ),
    replaceRules: (id: string, rules: ReminderRuleInput[]) =>
      request<{ rules: ReminderRule[] }>(`/api/subscriptions/${encodeURIComponent(id)}/reminders`, {
        method: 'PUT',
        body: { rules },
      }),
    addRule: (id: string, rule: ReminderRuleInput) =>
      request<{ rule: ReminderRule }>(`/api/subscriptions/${encodeURIComponent(id)}/reminders`, {
        method: 'POST',
        body: rule,
      }),
    applyPresetRules: (id: string) =>
      request<{ rules: ReminderRule[] }>(`/api/subscriptions/${encodeURIComponent(id)}/reminders`, {
        method: 'POST',
        body: { preset: true },
      }),
    updateRule: (id: string, ruleId: string, patch: ReminderRuleInput) =>
      request<{ rule: ReminderRule }>(
        `/api/subscriptions/${encodeURIComponent(id)}/reminders/${encodeURIComponent(ruleId)}`,
        { method: 'PUT', body: patch },
      ),
    acknowledgeRule: (id: string, ruleId: string) =>
      request<{ rule: ReminderRule }>(
        `/api/subscriptions/${encodeURIComponent(id)}/reminders/${encodeURIComponent(ruleId)}/acknowledge`,
        { method: 'POST' },
      ),
    deleteRule: (id: string, ruleId: string) =>
      request<{ ok: true }>(
        `/api/subscriptions/${encodeURIComponent(id)}/reminders/${encodeURIComponent(ruleId)}`,
        { method: 'DELETE' },
      ),
    nextReminder: (id: string) =>
      request<{ nextReminder: NextReminder | null; allUpcoming: NextReminder[] }>(
        `/api/subscriptions/${encodeURIComponent(id)}/next-reminder`,
      ),
    bulk: (ids: string[], action: BulkAction, category?: string) =>
      request<{ changed: number }>('/api/subscriptions/bulk', { method: 'POST', body: { ids, action, category } }),
    importRows: (rows: Record<string, unknown>[]) =>
      request<{ created: number; skipped: Array<{ row: number; reason: string }> }>(
        '/api/subscriptions/import',
        { method: 'POST', body: { rows } },
      ),
    addLabel: (kind: LabelKind, name: string) =>
      request<{ labels: LabelEntry[] }>(`/api/subscriptions/labels/${kind}`, { method: 'POST', body: { name } }),
    setLabelStyle: (kind: LabelKind, name: string, style: { icon?: string | null; color?: string | null }) =>
      request<{ label: LabelEntry }>(`/api/subscriptions/labels/${kind}/style`, {
        method: 'PUT',
        body: { name, ...style },
      }),
    renameLabel: (kind: LabelKind, name: string, to: string) =>
      request<{ labels: LabelEntry[] }>(`/api/subscriptions/labels/${kind}/rename`, {
        method: 'PUT',
        body: { name, to },
      }),
    removeLabel: (kind: LabelKind, name: string) =>
      request<{ labels: LabelEntry[] }>(
        `/api/subscriptions/labels/${kind}?name=${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
    saveSettings: (patch: SettingsPatch) =>
      request<{ settings: SubscriptionSettings }>('/api/subscriptions/settings', { method: 'PUT', body: patch }),
    saveChannel: (kind: ChannelKind, input: { enabled?: boolean; config: Record<string, unknown> }) =>
      request<{ channel: ChannelState }>(`/api/subscriptions/channels/${kind}`, { method: 'PUT', body: input }),
    clearChannel: (kind: ChannelKind) =>
      request<{ channels: ChannelState[] }>(`/api/subscriptions/channels/${kind}`, { method: 'DELETE' }),
    testChannel: (kind: ChannelKind) =>
      request<{ result: { success: boolean; channel: ChannelKind; error?: string } }>(
        `/api/subscriptions/channels/${kind}/test`,
        { method: 'POST' },
      ),
    notifyLogs: (filter: NotifyLogFilter = {}) =>
      request<{ logs: NotifyLogEntry[] }>(`/api/subscriptions/logs/notify${toQuery({
        subscriptionId: filter.subscriptionId,
        channel: filter.channel,
        status: filter.status,
        since: filter.since,
        until: filter.until,
        limit: filter.limit,
      })}`),
    scheduleLogs: (limit = 20) =>
      request<{ logs: ScheduleLogEntry[] }>(`/api/subscriptions/logs/schedule${toQuery({ limit })}`),
    rotateInboundToken: () =>
      request<{ token: string; hint: string }>('/api/subscriptions/inbound-token', { method: 'POST' }),
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

/**
 * The worker side of every WebSSH AI feature.
 *
 * All calls go through `runOneShot`, which is the app's existing assistant gateway: the reader's
 * configured provider and model, the provider key ring, the daily request ceiling and the usage meter
 * are the same ones the chat assistant spends. There is no second AI path in this module.
 *
 * What is deliberately absent: credentials, private keys, ciphertexts, host addresses and usernames
 * are never read here. The scope is a host label and a session's status, and the transcript is the
 * reader's own terminal tail after `text.ts` has stripped its control sequences and redacted secrets.
 */

import {
  WEBSSH_AI_LIMITS,
  type WebsshAiAuditAnomaly,
  type WebsshAiAuditSummaryResult,
  type WebsshAiCommandResult,
  type WebsshAiConfig,
  type WebsshAiDiagnoseResult,
  type WebsshAiFileFinding,
  type WebsshAiFileMode,
  type WebsshAiFileResult,
  type WebsshAiFixSuggestion,
  type WebsshAiHandoffView,
  type WebsshAiRecordingMatch,
  type WebsshAiRecordingSearchResult,
  type WebsshAiRiskResult,
  type WebsshAiSummaryMode,
  type WebsshAiSummaryResult,
} from '@shared/webssh/ai'
import type { Env } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import { AssistantStore } from '../../assistant/store'
import { OneShotError, runOneShot, type OneShotResult } from '../../assistant/one-shot'
import { recordAudit } from '../audit'
import { parseCastLine } from '../recording/cast'
import { loadSessionRecording, requireReadyRecording } from '../recording/repository'
import {
  auditSummaryPrompt,
  commandPrompt,
  diagnosePrompt,
  filePrompt,
  recordingSearchPrompt,
  riskPrompt,
  summaryPrompt,
  type PromptScope,
} from './prompts'
import {
  boundedString,
  parseJsonObject,
  readConfidence,
  readInteger,
  readRiskLevel,
  readSeverity,
  readStringList,
  sanitizeTerminalText,
  stripTerminalControl,
  tailString,
} from './text'

const COMMAND_TIMEOUT_MS = 45_000
const SUMMARY_TIMEOUT_MS = 60_000
const FILE_TIMEOUT_MS = 60_000
const RECORDING_TIMEOUT_MS = 60_000
const AUDIT_TIMEOUT_MS = 60_000

export interface AiCallScope {
  hostId?: string
  sessionId?: string
}

interface CallResult extends OneShotResult {
  model: string
}

/**
 * One structured call, metered and audited.
 *
 * The audit row names the feature, the model and the spend, never the prompt: the transcript is the
 * reader's terminal, and a security log is not the place it should be copied to.
 */
async function callModel(
  env: Env,
  userId: string,
  kind: string,
  scope: AiCallScope,
  prompt: { system: string, user: string },
  options: { maxOutputTokens: number, temperature: number, timeoutMs: number, signal?: AbortSignal },
): Promise<CallResult> {
  const store = new AssistantStore(env.DB, userId, env)
  const settings = await store.getSettings()
  let answer: OneShotResult
  try {
    answer = await runOneShot(store, settings, {
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
      structured: true,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    // The reader gets a stable code; the operator gets the provider's own sentence, which may name
    // the host or the HTTP status but never the prompt or the key.
    console.warn(
      '[inkstone] WebSSH AI upstream failed:',
      error instanceof OneShotError ? error.message : error instanceof Error ? error.name : error,
    )
    void recordAudit(env.DB, {
      userId,
      eventType: 'ai_request',
      sessionId: scope.sessionId ?? '',
      hostId: scope.hostId ?? '',
      metadata: {
        kind,
        ok: false,
        reason: error instanceof OneShotError ? error.kind : 'upstream',
      },
    }).catch((auditError) => {
      console.warn('[inkstone] WebSSH AI failure audit write failed:', (auditError as Error).message)
    })
    throw mapOneShotError(error)
  }
  void recordAudit(env.DB, {
    userId,
    eventType: 'ai_request',
    sessionId: scope.sessionId ?? '',
    hostId: scope.hostId ?? '',
    metadata: {
      kind,
      ok: true,
      model: answer.modelLabel,
      inputTokens: answer.usage.inputTokens,
      outputTokens: answer.usage.outputTokens,
    },
  }).catch((auditError) => {
    console.warn('[inkstone] WebSSH AI audit write failed:', (auditError as Error).message)
  })
  return { ...answer, model: answer.modelLabel }
}

function mapOneShotError(error: unknown): ApiError {
  if (error instanceof OneShotError) {
    if (error.kind === 'no_model') {
      return new ApiError(409, 'webssh_ai_unavailable', 'No assistant model is configured. Add and activate one in Assistant settings.')
    }
    if (error.kind === 'quota') {
      return new ApiError(429, 'webssh_ai_quota', 'The daily assistant request limit has been reached. Try again later.')
    }
    if (error.kind === 'timeout') {
      return new ApiError(502, 'webssh_ai_upstream', 'The model did not answer before the deadline.')
    }
    return new ApiError(502, 'webssh_ai_upstream', 'The assistant model could not answer this request right now.')
  }
  if (error instanceof ApiError) return error
  return new ApiError(502, 'webssh_ai_upstream', 'The assistant model could not answer this request right now.')
}

/** The object a model answered, or a refusal the reader can act on. */
function requireObject(answer: CallResult): Record<string, unknown> {
  const parsed = parseJsonObject(answer.text)
  if (!parsed) throw new ApiError(422, 'webssh_ai_invalid_output', 'The model returned an answer this app could not read. Nothing was changed.')
  return parsed
}

/** The host label and session status that may travel; nothing from `webssh_credentials` or `webssh_keys`. */
export async function loadPromptScope(
  env: Env,
  userId: string,
  input: AiCallScope,
): Promise<{ scope: PromptScope | null, hostId: string | null, sessionId: string | null }> {
  let hostId = typeof input.hostId === 'string' && isValidId(input.hostId) ? input.hostId : null
  let sessionId = typeof input.sessionId === 'string' && isValidId(input.sessionId) ? input.sessionId : null
  let sessionStatus: string | null = null
  let sessionStartedAt: number | null = null

  if (sessionId) {
    const row = await env.DB.prepare(
      `SELECT host_id, status, started_at FROM webssh_sessions WHERE id = ?1 AND user_id = ?2`,
    )
      .bind(sessionId, userId)
      .first<{ host_id: string, status: string, started_at: number }>()
    if (!row) throw ApiError.notFound('That session does not exist')
    hostId = row.host_id
    sessionStatus = row.status
    sessionStartedAt = Number(row.started_at)
  }

  if (!hostId) return { scope: null, hostId: null, sessionId }
  const host = await env.DB.prepare(
    `SELECT name, term_type, encoding FROM webssh_hosts
      WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  )
    .bind(userId, hostId)
    .first<{ name: string, term_type: string, encoding: string }>()
  if (!host) throw ApiError.notFound('That host does not exist')
  return {
    scope: {
      hostLabel: host.name,
      hostTerm: host.term_type,
      hostEncoding: host.encoding,
      sessionStatus,
      sessionStartedAt,
    },
    hostId,
    sessionId,
  }
}

export async function aiConfig(env: Env, userId: string): Promise<WebsshAiConfig> {
  const store = new AssistantStore(env.DB, userId, env)
  const settings = await store.getSettings()
  const [models, providers] = await Promise.all([store.listModels(), store.listProviders()])
  const active = settings.activeModelId
    ? models.find((model) => model.id === settings.activeModelId && model.enabled)
    : undefined
  const provider = active ? providers.find((entry) => entry.id === active.providerId) : undefined
  if (!active || !provider) return { available: false, modelLabel: null }
  return { available: true, modelLabel: active.label || active.model }
}

export async function generateCommand(
  env: Env,
  userId: string,
  input: { prompt: string, transcript: string, shell: string, cwd: string, scope: AiCallScope },
  signal?: AbortSignal,
): Promise<WebsshAiCommandResult> {
  const loaded = await loadPromptScope(env, userId, input.scope)
  const prompt = commandPrompt({
    prompt: boundedString(input.prompt, WEBSSH_AI_LIMITS.promptChars),
    transcript: tailString(input.transcript, WEBSSH_AI_LIMITS.transcriptChars),
    shell: boundedString(input.shell, 40),
    cwd: boundedString(input.cwd, 300),
    scope: loaded.scope,
  })
  const answer = await callModel(env, userId, 'command', { hostId: loaded.hostId ?? undefined, sessionId: loaded.sessionId ?? undefined }, prompt, {
    maxOutputTokens: 1400,
    temperature: 0.1,
    timeoutMs: COMMAND_TIMEOUT_MS,
    signal,
  })
  const row = requireObject(answer)
  const command = boundedString(row.command, WEBSSH_AI_LIMITS.commandChars)
  return {
    command,
    explanation: boundedString(row.explanation, 1200),
    risk: readRiskLevel(row.risk),
    riskReason: boundedString(row.riskReason, 600),
    model: answer.model,
  }
}

export async function diagnoseCommand(
  env: Env,
  userId: string,
  input: { command: string, exitCode: number | null, transcript: string, scope: AiCallScope },
  signal?: AbortSignal,
): Promise<WebsshAiDiagnoseResult> {
  const loaded = await loadPromptScope(env, userId, input.scope)
  const prompt = diagnosePrompt({
    command: boundedString(input.command, WEBSSH_AI_LIMITS.commandChars),
    exitCode: input.exitCode,
    transcript: tailString(input.transcript, WEBSSH_AI_LIMITS.transcriptChars),
    scope: loaded.scope,
  })
  const answer = await callModel(env, userId, 'diagnose', { hostId: loaded.hostId ?? undefined, sessionId: loaded.sessionId ?? undefined }, prompt, {
    // A thinking model spends part of its allowance before the JSON begins; 1100 tokens was enough
    // to be cut off mid-object on a two-thousand-token diagnosis.
    maxOutputTokens: 3000,
    temperature: 0.1,
    timeoutMs: COMMAND_TIMEOUT_MS,
    signal,
  })
  const row = requireObject(answer)
  const fixes: WebsshAiFixSuggestion[] = Array.isArray(row.fixes)
    ? row.fixes.slice(0, 4).flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const fix = item as Record<string, unknown>
      const command = boundedString(fix.command, WEBSSH_AI_LIMITS.commandChars)
      if (!command) return []
      return [{
        command,
        explanation: boundedString(fix.explanation, 800),
        risk: readRiskLevel(fix.risk),
      }]
    })
    : []
  return {
    summary: boundedString(row.summary, 1600),
    causes: readStringList(row.causes, 6, 500),
    fixes,
    confidence: readConfidence(row.confidence),
    needsMoreOutput: row.needsMoreOutput === true,
    model: answer.model,
  }
}

export async function assessCommandRisk(
  env: Env,
  userId: string,
  input: { command: string, transcript: string, scope: AiCallScope },
  signal?: AbortSignal,
): Promise<WebsshAiRiskResult> {
  const loaded = await loadPromptScope(env, userId, input.scope)
  const prompt = riskPrompt({
    command: boundedString(input.command, WEBSSH_AI_LIMITS.commandChars),
    transcript: tailString(input.transcript, WEBSSH_AI_LIMITS.transcriptChars),
    scope: loaded.scope,
  })
  const answer = await callModel(env, userId, 'risk', { hostId: loaded.hostId ?? undefined, sessionId: loaded.sessionId ?? undefined }, prompt, {
    maxOutputTokens: 1400,
    temperature: 0,
    timeoutMs: COMMAND_TIMEOUT_MS,
    signal,
  })
  const row = requireObject(answer)
  return {
    level: readRiskLevel(row.level),
    reasons: readStringList(row.reasons, 5, 500),
    saferAlternative: boundedString(row.saferAlternative, WEBSSH_AI_LIMITS.commandChars) || null,
    model: answer.model,
  }
}

export async function summarizeSession(
  env: Env,
  userId: string,
  input: { transcript: string, mode: WebsshAiSummaryMode, scope: AiCallScope },
  signal?: AbortSignal,
): Promise<WebsshAiSummaryResult> {
  const loaded = await loadPromptScope(env, userId, input.scope)
  const prompt = summaryPrompt({
    transcript: tailString(input.transcript, WEBSSH_AI_LIMITS.transcriptChars),
    mode: input.mode,
    scope: loaded.scope,
  })
  const answer = await callModel(env, userId, `summary_${input.mode}`, { hostId: loaded.hostId ?? undefined, sessionId: loaded.sessionId ?? undefined }, prompt, {
    maxOutputTokens: 3000,
    temperature: 0.2,
    timeoutMs: SUMMARY_TIMEOUT_MS,
    signal,
  })
  const row = requireObject(answer)
  const result: WebsshAiSummaryResult = {
    summary: boundedString(row.summary, 2400),
    highlights: readStringList(row.highlights, 8, 500),
    // The handoff persists only when a host is known; `savedAt` is the caller's proof it landed.
    openIssues: readStringList(row.openIssues, 8, 500),
    nextSteps: readStringList(row.nextSteps, 8, 500),
    model: answer.model,
    savedAt: null,
  }
  if (input.mode === 'handoff' && loaded.hostId) {
    const createdAt = Date.now()
    await env.DB.prepare(
      `INSERT INTO webssh_ai_summaries
         (user_id, host_id, session_id, kind, summary, highlights, open_issues, next_steps, model, created_at)
       VALUES (?1, ?2, ?3, 'handoff', ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(user_id, host_id, kind) DO UPDATE SET
         session_id = excluded.session_id,
         summary = excluded.summary,
         highlights = excluded.highlights,
         open_issues = excluded.open_issues,
         next_steps = excluded.next_steps,
         model = excluded.model,
         created_at = excluded.created_at`,
    )
      .bind(
        userId,
        loaded.hostId,
        loaded.sessionId ?? '',
        result.summary,
        JSON.stringify(result.highlights),
        JSON.stringify(result.openIssues),
        JSON.stringify(result.nextSteps),
        result.model,
        createdAt,
      )
      .run()
    result.savedAt = createdAt
  }
  return result
}

export async function latestHandoff(env: Env, userId: string, hostId: string): Promise<WebsshAiHandoffView | null> {
  if (!isValidId(hostId)) throw ApiError.badRequest('Invalid host id')
  const row = await env.DB.prepare(
    `SELECT summary, highlights, open_issues, next_steps, model, created_at
       FROM webssh_ai_summaries
      WHERE user_id = ?1 AND host_id = ?2 AND kind = 'handoff'`,
  )
    .bind(userId, hostId)
    .first<{ summary: string, highlights: string, open_issues: string, next_steps: string, model: string, created_at: number }>()
  if (!row) return null
  return {
    summary: String(row.summary ?? '').slice(0, 2400),
    highlights: parseStringJson(row.highlights, 8, 500),
    openIssues: parseStringJson(row.open_issues, 8, 500),
    nextSteps: parseStringJson(row.next_steps, 8, 500),
    model: String(row.model ?? ''),
    createdAt: Number(row.created_at ?? 0),
  }
}

function parseStringJson(value: string, maxItems: number, maxChars: number): string[] {
  try {
    return readStringList(JSON.parse(value), maxItems, maxChars)
  } catch {
    return []
  }
}

export async function askFile(
  env: Env,
  userId: string,
  input: { path: string, content: string, question: string, mode: WebsshAiFileMode, scope: AiCallScope },
  signal?: AbortSignal,
): Promise<WebsshAiFileResult> {
  const loaded = await loadPromptScope(env, userId, input.scope)
  const raw = boundedString(input.content, WEBSSH_AI_LIMITS.fileChars)
  const truncated = raw.length < input.content.trim().length
  const prompt = filePrompt({
    path: boundedString(input.path, 400),
    content: raw,
    question: boundedString(input.question, WEBSSH_AI_LIMITS.questionChars),
    mode: input.mode,
  })
  const answer = await callModel(env, userId, `file_${input.mode}`, { hostId: loaded.hostId ?? undefined, sessionId: loaded.sessionId ?? undefined }, prompt, {
    maxOutputTokens: 3000,
    temperature: 0.1,
    timeoutMs: FILE_TIMEOUT_MS,
    signal,
  })
  const row = requireObject(answer)
  const findings: WebsshAiFileFinding[] = Array.isArray(row.findings)
    ? row.findings.slice(0, 20).flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const finding = item as Record<string, unknown>
      return [{
        line: readInteger(finding.line, 1, 1_000_000),
        severity: readSeverity(finding.severity),
        message: boundedString(finding.message, 800),
      }]
    })
    : []
  return {
    answer: boundedString(row.answer, 3000),
    findings,
    truncated,
    model: answer.model,
  }
}

export async function searchRecording(
  env: Env,
  userId: string,
  input: { sessionId: string, query: string },
  signal?: AbortSignal,
): Promise<WebsshAiRecordingSearchResult> {
  const row = await loadSessionRecording(env, userId, input.sessionId)
  requireReadyRecording(row)
  const bucket = env.FILES
  if (!bucket) throw new ApiError(503, 'storage_unavailable', 'The recording store is not bound')
  const object = await bucket.head(row.r2_key)
  if (!object) throw ApiError.notFound('The recording object is missing')
  if (object.size > WEBSSH_AI_LIMITS.recordingBytes) {
    throw new ApiError(413, 'webssh_ai_too_large', `That recording is larger than ${WEBSSH_AI_LIMITS.recordingBytes / 1024 / 1024} MB and cannot be searched here.`)
  }
  const body = await bucket.get(row.r2_key)
  if (!body) throw ApiError.notFound('The recording object is missing')
  const text = await body.text()

  const lines: string[] = []
  let scannedMs = 0
  let totalChars = 0
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue
    let parsed: ReturnType<typeof parseCastLine>
    try {
      parsed = parseCastLine(rawLine)
    } catch {
      throw new ApiError(422, 'webssh_ai_invalid_output', 'That recording could not be read as a cast file.')
    }
    if (!parsed.event || parsed.event[1] !== 'o') continue
    const atMs = Math.round(parsed.event[0] * 1000)
    scannedMs = Math.max(scannedMs, atMs)
    for (const line of stripTerminalControl(parsed.event[2]).split('\n')) {
      const clean = line.trim()
      if (!clean) continue
      lines.push(`[${atMs}] ${clean}`)
      totalChars += clean.length
    }
  }

  const truncated = totalChars > WEBSSH_AI_LIMITS.recordingChars
  const sampled = truncated ? sampleRecordingLines(lines, WEBSSH_AI_LIMITS.recordingChars) : lines
  const prompt = recordingSearchPrompt({
    query: boundedString(input.query, WEBSSH_AI_LIMITS.recordingQueryChars),
    lines: sampled,
    truncated,
  })
  const answer = await callModel(env, userId, 'recording_search', { sessionId: input.sessionId, hostId: row.host_id }, prompt, {
    maxOutputTokens: 3000,
    temperature: 0.1,
    timeoutMs: RECORDING_TIMEOUT_MS,
    signal,
  })
  const parsed = requireObject(answer)
  const matches: WebsshAiRecordingMatch[] = Array.isArray(parsed.matches)
    ? parsed.matches.slice(0, 8).flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const match = item as Record<string, unknown>
      const atMs = readInteger(match.atMs, 0, Math.max(1, scannedMs))
      if (atMs === null) return []
      return [{
        atMs,
        text: boundedString(match.text, 500),
        reason: boundedString(match.reason, 500),
      }]
    })
    : []
  return { matches, scannedMs, truncated, model: answer.model }
}

/** Keep the shape of a long recording: take evenly spaced lines so the whole timeline is represented. */
function sampleRecordingLines(lines: string[], maxChars: number): string[] {
  if (!lines.length) return []
  const total = lines.reduce((sum, line) => sum + line.length, 0)
  const stride = Math.max(1, Math.ceil(total / maxChars))
  const out: string[] = []
  let used = 0
  for (let index = 0; index < lines.length; index += stride) {
    const line = lines[index]!
    if (used + line.length > maxChars) break
    out.push(line)
    used += line.length
  }
  return out
}

interface AuditRow {
  event_type: string
  session_id: string
  host_id: string
  metadata: string
  created_at: number
  host_name: string | null
}

export async function summarizeAudit(
  env: Env,
  userId: string,
  days: number,
  signal?: AbortSignal,
): Promise<WebsshAiAuditSummaryResult> {
  const windowDays = Math.max(1, Math.min(WEBSSH_AI_LIMITS.auditDaysMax, Math.trunc(days)))
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000
  const rows = await env.DB.prepare(
    `SELECT e.event_type, e.session_id, e.host_id, e.metadata, e.created_at, h.name AS host_name
       FROM webssh_audit_events e
       LEFT JOIN webssh_hosts h ON h.user_id = e.user_id AND h.id = e.host_id
      WHERE e.user_id = ?1 AND e.created_at >= ?2
      ORDER BY e.created_at DESC
      LIMIT ?3`,
  )
    .bind(userId, since, WEBSSH_AI_LIMITS.auditEvents)
    .all<AuditRow>()
  const events = rows.results.map((row) => ({
    at: Number(row.created_at),
    type: row.event_type,
    host: row.host_name || row.host_id || null,
    session: row.session_id || null,
    metadata: parseAuditMetadata(row.metadata),
  }))
  if (!events.length) {
    // No model is spent on an empty window. The interface owns the sentence, because it is copy the
    // reader reads rather than a fact the worker should translate.
    return { overview: '', anomalies: [], recommendations: [], model: '' }
  }
  const prompt = auditSummaryPrompt({ days: windowDays, events })
  const answer = await callModel(env, userId, 'audit_summary', {}, prompt, {
    maxOutputTokens: 3000,
    temperature: 0.1,
    timeoutMs: AUDIT_TIMEOUT_MS,
    signal,
  })
  const parsed = requireObject(answer)
  const anomalies: WebsshAiAuditAnomaly[] = Array.isArray(parsed.anomalies)
    ? parsed.anomalies.slice(0, 8).flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const anomaly = item as Record<string, unknown>
      const severity = anomaly.severity === 'danger' ? 'danger' : 'warning'
      const title = boundedString(anomaly.title, 300)
      if (!title) return []
      return [{ severity, title, detail: boundedString(anomaly.detail, 900) }]
    })
    : []
  return {
    overview: boundedString(parsed.overview, 2000),
    anomalies,
    recommendations: readStringList(parsed.recommendations, 5, 500),
    model: answer.model,
  }
}

function parseAuditMetadata(raw: string): Record<string, string | number | boolean | null> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value
      else if (typeof value === 'string') out[key] = sanitizeTerminalText(value).slice(0, 200)
    }
    return out
  } catch {
    return {}
  }
}



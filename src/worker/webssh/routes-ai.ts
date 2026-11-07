/**
 * The WebSSH AI REST surface, mounted at `/api/webssh/ai`.
 *
 * Every route is an explicit action the reader pressed in the terminal. There is no background
 * generation and no automatic spend: a turn that would cost the reader's AI quota only happens
 * when a button in `WebsshAiPanel`, the file dialog, the recording library or the audit panel asks.
 *
 * The routes validate and bound, then hand the work to `ai/service.ts`; the prompts and the model
 * call live there so the HTTP layer never assembles a prompt of its own.
 */

import { Hono, type Context } from 'hono'
import type {
  WebsshAiAuditSummaryResult,
  WebsshAiCommandResult,
  WebsshAiConfig,
  WebsshAiDiagnoseResult,
  WebsshAiFileMode,
  WebsshAiFileResult,
  WebsshAiHandoffView,
  WebsshAiRecordingSearchResult,
  WebsshAiRiskResult,
  WebsshAiSummaryMode,
  WebsshAiSummaryResult,
} from '@shared/webssh/ai'
import { WEBSSH_AI_LIMITS } from '@shared/webssh/ai'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  aiConfig,
  askFile,
  assessCommandRisk,
  diagnoseCommand,
  generateCommand,
  latestHandoff,
  searchRecording,
  summarizeAudit,
  summarizeSession,
} from './ai/service'
import { boundedString, optionalBoundedString, tailString } from './ai/text'

const BODY_LIMIT = 96 * 1024
const FILE_BODY_LIMIT = 256 * 1024
const SMALL_BODY_LIMIT = 16 * 1024

export const websshAiRoutes = new Hono<AppBindings>()

websshAiRoutes.use('*', requireAuth)

function ownerId(c: Context<AppBindings>): string {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

function scopeId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !isValidId(value)) throw ApiError.badRequest(`Invalid ${field}`)
  return value
}

/** The host and session ids any request may name; both are ownership-checked in the service. */
function readScope(row: Record<string, unknown>): { hostId?: string, sessionId?: string } {
  const hostId = scopeId(row.hostId, 'host id')
  const sessionId = scopeId(row.sessionId, 'session id')
  return {
    ...(hostId ? { hostId } : {}),
    ...(sessionId ? { sessionId } : {}),
  }
}

websshAiRoutes.get('/config', async (c) => {
  const config = await aiConfig(c.env, ownerId(c))
  return c.json<WebsshAiConfig>(config)
})

websshAiRoutes.post('/command', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const request = boundedString(body.prompt, WEBSSH_AI_LIMITS.promptChars)
  if (!request) throw ApiError.badRequest('Describe the command you want first')
  const result = await generateCommand(
    c.env,
    ownerId(c),
    {
      prompt: request,
      transcript: tailString(body.transcript, WEBSSH_AI_LIMITS.transcriptChars),
      shell: boundedString(body.shell, 40),
      cwd: boundedString(body.cwd, 300),
      scope: readScope(body),
    },
    c.req.raw.signal,
  )
  return c.json<WebsshAiCommandResult>(result)
})

websshAiRoutes.post('/diagnose', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const command = boundedString(body.command, WEBSSH_AI_LIMITS.commandChars)
  if (!command) throw ApiError.badRequest('The failed command is required')
  const exitCode = readExitCode(body.exitCode)
  const result = await diagnoseCommand(
    c.env,
    ownerId(c),
    {
      command,
      exitCode,
      transcript: tailString(body.transcript, WEBSSH_AI_LIMITS.transcriptChars),
      scope: readScope(body),
    },
    c.req.raw.signal,
  )
  return c.json<WebsshAiDiagnoseResult>(result)
})

function readExitCode(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw ApiError.badRequest('The exit code must be an integer from 0 to 255')
  }
  return value
}

websshAiRoutes.post('/risk', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const command = boundedString(body.command, WEBSSH_AI_LIMITS.commandChars)
  if (!command) throw ApiError.badRequest('A command is required')
  const result = await assessCommandRisk(
    c.env,
    ownerId(c),
    {
      command,
      transcript: tailString(body.transcript, WEBSSH_AI_LIMITS.transcriptChars),
      scope: readScope(body),
    },
    c.req.raw.signal,
  )
  return c.json<WebsshAiRiskResult>(result)
})

websshAiRoutes.post('/summary', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const transcript = tailString(body.transcript, WEBSSH_AI_LIMITS.transcriptChars)
  if (!transcript) throw ApiError.badRequest('There is no terminal output to summarise yet')
  const mode: WebsshAiSummaryMode = body.mode === 'handoff' ? 'handoff' : 'session'
  const result = await summarizeSession(
    c.env,
    ownerId(c),
    { transcript, mode, scope: readScope(body) },
    c.req.raw.signal,
  )
  return c.json<WebsshAiSummaryResult>(result)
})

websshAiRoutes.get('/handoff', async (c) => {
  const hostId = c.req.query('hostId')
  if (typeof hostId !== 'string' || !isValidId(hostId)) throw ApiError.badRequest('Invalid host id')
  const handoff = await latestHandoff(c.env, ownerId(c), hostId)
  return c.json<{ handoff: WebsshAiHandoffView | null }>({ handoff })
})

websshAiRoutes.post('/file', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, FILE_BODY_LIMIT)
  const path = boundedString(body.path, 400)
  if (!path) throw ApiError.badRequest('A file path is required')
  const content = boundedString(body.content, WEBSSH_AI_LIMITS.fileChars)
  if (!content) throw ApiError.badRequest('There is no file content to read')
  const mode: WebsshAiFileMode = body.mode === 'summary' || body.mode === 'anomaly' ? body.mode : 'question'
  const question = optionalBoundedString(body.question, WEBSSH_AI_LIMITS.questionChars)
  if (mode === 'question' && !question) throw ApiError.badRequest('Write the question you want answered')
  const result = await askFile(
    c.env,
    ownerId(c),
    { path, content, question: question ?? '', mode, scope: readScope(body) },
    c.req.raw.signal,
  )
  return c.json<WebsshAiFileResult>(result)
})

websshAiRoutes.post('/recording-search', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  const sessionId = scopeId(body.sessionId, 'session id')
  if (!sessionId) throw ApiError.badRequest('A session id is required')
  const query = boundedString(body.query, WEBSSH_AI_LIMITS.recordingQueryChars)
  if (!query) throw ApiError.badRequest('Describe what to look for in the recording')
  const result = await searchRecording(c.env, ownerId(c), { sessionId, query }, c.req.raw.signal)
  return c.json<WebsshAiRecordingSearchResult>(result)
})

websshAiRoutes.post('/audit-summary', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  const days = typeof body.days === 'number' && Number.isFinite(body.days)
    ? Math.max(1, Math.min(WEBSSH_AI_LIMITS.auditDaysMax, Math.trunc(body.days)))
    : 7
  const result = await summarizeAudit(c.env, ownerId(c), days, c.req.raw.signal)
  return c.json<WebsshAiAuditSummaryResult>(result)
})

/**
 * The WebSSH AI calls, kept apart from `api.ts` so the terminal, SFTP and audit panels can import
 * only the surface they use.
 *
 * Every call is an explicit press. The shapes come from `@shared/webssh/ai`, which is also what the
 * worker validates, so a renamed field fails the type check on both sides rather than at runtime.
 */

import type {
  WebsshAiAuditSummaryRequest,
  WebsshAiAuditSummaryResult,
  WebsshAiCommandRequest,
  WebsshAiCommandResult,
  WebsshAiConfig,
  WebsshAiDiagnoseRequest,
  WebsshAiDiagnoseResult,
  WebsshAiFileRequest,
  WebsshAiFileResult,
  WebsshAiHandoffView,
  WebsshAiRecordingSearchRequest,
  WebsshAiRecordingSearchResult,
  WebsshAiRiskRequest,
  WebsshAiRiskResult,
  WebsshAiSummaryRequest,
  WebsshAiSummaryResult,
} from '@shared/webssh/ai'
import { request } from '../../lib/api'

export const websshAiApi = {
  config: async () => await request<WebsshAiConfig>('/api/webssh/ai/config'),

  command: async (body: WebsshAiCommandRequest) =>
    await request<WebsshAiCommandResult>('/api/webssh/ai/command', { method: 'POST', body }),

  diagnose: async (body: WebsshAiDiagnoseRequest) =>
    await request<WebsshAiDiagnoseResult>('/api/webssh/ai/diagnose', { method: 'POST', body }),

  risk: async (body: WebsshAiRiskRequest) =>
    await request<WebsshAiRiskResult>('/api/webssh/ai/risk', { method: 'POST', body }),

  summary: async (body: WebsshAiSummaryRequest) =>
    await request<WebsshAiSummaryResult>('/api/webssh/ai/summary', { method: 'POST', body }),

  handoff: async (hostId: string) =>
    (await request<{ handoff: WebsshAiHandoffView | null }>(
      `/api/webssh/ai/handoff?hostId=${encodeURIComponent(hostId)}`,
    )).handoff,

  file: async (body: WebsshAiFileRequest) =>
    await request<WebsshAiFileResult>('/api/webssh/ai/file', { method: 'POST', body }),

  recordingSearch: async (body: WebsshAiRecordingSearchRequest) =>
    await request<WebsshAiRecordingSearchResult>('/api/webssh/ai/recording-search', { method: 'POST', body }),

  auditSummary: async (body: WebsshAiAuditSummaryRequest = {}) =>
    await request<WebsshAiAuditSummaryResult>('/api/webssh/ai/audit-summary', { method: 'POST', body }),
}

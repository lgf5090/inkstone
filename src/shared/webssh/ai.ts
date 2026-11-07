/**
 * The WebSSH AI surface.
 *
 * Every helper here is a request or an answer for one explicit press in the terminal app. Nothing is
 * generated in the background, and no shape carries a password, a private key, a credential id or a
 * ciphertext: the worker only ever reads the host label and the terminal text the reader sends.
 *
 * The caps live beside the shapes because both halves need the same numbers: the browser trims a
 * transcript before it leaves, and the worker trims it again before it reaches a model.
 */

export type WebsshAiRiskLevel = 'safe' | 'caution' | 'danger'

/** Which session or host an answer is about, when the caller knows. */
export interface WebsshAiScope {
  hostId?: string
  sessionId?: string
}

/** The natural-language request behind one proposed shell command. */
export interface WebsshAiCommandRequest extends WebsshAiScope {
  prompt: string
  /** The tail of the terminal, so cwd, distro and shell can be read from output the reader sees. */
  transcript?: string
  shell?: string
  cwd?: string
}

export interface WebsshAiCommandResult {
  command: string
  explanation: string
  risk: WebsshAiRiskLevel
  riskReason: string
  model: string
}

/** A command that already ran, with whatever exit status the caller knows. */
export interface WebsshAiDiagnoseRequest extends WebsshAiScope {
  command: string
  exitCode?: number | null
  transcript: string
}

export interface WebsshAiFixSuggestion {
  command: string
  explanation: string
  risk: WebsshAiRiskLevel
}

export interface WebsshAiDiagnoseResult {
  summary: string
  causes: string[]
  fixes: WebsshAiFixSuggestion[]
  confidence: 'low' | 'medium' | 'high'
  needsMoreOutput: boolean
  model: string
}

export interface WebsshAiRiskRequest extends WebsshAiScope {
  command: string
  transcript?: string
}

export interface WebsshAiRiskResult {
  level: WebsshAiRiskLevel
  reasons: string[]
  saferAlternative: string | null
  model: string
}

export type WebsshAiSummaryMode = 'session' | 'handoff'

export interface WebsshAiSummaryRequest extends WebsshAiScope {
  transcript: string
  mode: WebsshAiSummaryMode
}

export interface WebsshAiSummaryResult {
  summary: string
  highlights: string[]
  openIssues: string[]
  nextSteps: string[]
  model: string
  /** Set when the worker stored the handoff for the next connection to this host. */
  savedAt: number | null
}

/** The last handoff stored for one host, as the workspace card reads it. */
export interface WebsshAiHandoffView {
  summary: string
  highlights: string[]
  openIssues: string[]
  nextSteps: string[]
  model: string
  createdAt: number
}

export type WebsshAiFileMode = 'summary' | 'question' | 'anomaly'

export interface WebsshAiFileRequest extends WebsshAiScope {
  path: string
  content: string
  question?: string
  mode: WebsshAiFileMode
}

export interface WebsshAiFileFinding {
  /** A 1-based line in the content the caller sent, or null when the finding is file-wide. */
  line: number | null
  severity: 'info' | 'warning' | 'danger'
  message: string
}

export interface WebsshAiFileResult {
  answer: string
  findings: WebsshAiFileFinding[]
  truncated: boolean
  model: string
}

export interface WebsshAiRecordingSearchRequest {
  sessionId: string
  query: string
}

export interface WebsshAiRecordingMatch {
  /** Where in the recording the match happened, in milliseconds from the first event. */
  atMs: number
  /** The output line the model matched, already stripped of control sequences. */
  text: string
  reason: string
}

export interface WebsshAiRecordingSearchResult {
  matches: WebsshAiRecordingMatch[]
  scannedMs: number
  truncated: boolean
  model: string
}

export interface WebsshAiAuditSummaryRequest {
  /** The window in days, 1-30; the worker clamps it. */
  days?: number
}

export interface WebsshAiAuditAnomaly {
  severity: 'warning' | 'danger'
  title: string
  detail: string
}

export interface WebsshAiAuditSummaryResult {
  overview: string
  anomalies: WebsshAiAuditAnomaly[]
  recommendations: string[]
  model: string
}

/** Whether this account has a model the WebSSH AI buttons can spend. */
export interface WebsshAiConfig {
  available: boolean
  modelLabel: string | null
}

/**
 * The bounds every surface shares. A transcript is the tail of a terminal, not a file: 16k characters
 * is several screens of output, which is what a diagnosis actually needs.
 */
export const WEBSSH_AI_LIMITS = {
  promptChars: 600,
  commandChars: 400,
  transcriptChars: 16000,
  fileChars: 48000,
  questionChars: 600,
  recordingQueryChars: 600,
  recordingBytes: 8 * 1024 * 1024,
  recordingChars: 120000,
  auditDaysMax: 30,
  auditEvents: 300,
} as const

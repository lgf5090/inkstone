import type { ParsedColumn } from '@shared/development/database/types'

export interface SavedConnectionSelection {
  kind: 'saved'
  id: string
}

export interface LocalConnectionSelection {
  kind: 'local'
  name: string
  file?: File
}

export type StudioSelection = SavedConnectionSelection | LocalConnectionSelection

export type StudioTabKind = 'query' | 'data' | 'schema' | 'tools' | 'erd'

export interface StudioTab {
  id: string
  kind: StudioTabKind
  table?: string
  initialSql?: string
}

export const FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'notNull',
] as const

export type FilterOperator = (typeof FILTER_OPERATORS)[number]

export interface FilterCondition {
  id: string
  column: string
  op: FilterOperator
  value: string
}

export interface ColumnDraft {
  id: string
  name: string
  type: string
  notNull: boolean
  pk: boolean
  unique: boolean
  default: string
  isNew?: boolean
  deleted?: boolean
  original?: ParsedColumn
}

export interface RowKeyPk {
  kind: 'pk'
  values: Record<string, unknown>
}

export interface RowKeyRowid {
  kind: 'rowid'
  rowid: number | bigint | string
}

export interface RowKeyNone {
  kind: 'none'
}

export type RowKey = RowKeyPk | RowKeyRowid | RowKeyNone

export interface SqlStatement {
  sql: string
  params: unknown[]
}

export interface ExportCreateResult {
  id: string
  size: number
  url: string
}

export type AiMode = 'generate' | 'explain' | 'optimize'

export interface AiStatus {
  configured: boolean
  modelLabel?: string
}

export interface AiChatInput {
  mode: AiMode
  prompt?: string
  currentSql?: string
  schemaText?: string
}

export type AiStreamEvent =
  | { type: 'start'; model?: string }
  | { type: 'delta'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'done'; aborted?: boolean }
  | { type: 'error'; code: string; message: string }

export interface AgentChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AgentToolResult {
  id: string
  name: string
  content: string
  isError?: boolean
}

export type AgentStreamEvent =
  | { type: 'start'; model?: string }
  | { type: 'delta'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_calls'; calls: AgentToolCall[] }
  | { type: 'tool_results'; results: AgentToolResult[] }
  | { type: 'done'; aborted?: boolean }
  | { type: 'error'; code: string; message: string }

export type AgentMessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call'
      callId: string
      toolName: string
      state: 'running' | 'result' | 'output-error'
    }

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  parts: AgentMessagePart[]
  createdAt: number
}

export type AgentStatus = 'idle' | 'submitted' | 'streaming' | 'error'

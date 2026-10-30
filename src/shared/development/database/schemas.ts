import { z } from 'zod'
import {
  EXPORT_FORMATS,
  HISTORY_LIMIT_MAX,
  HISTORY_LIMIT_MIN,
  MAX_AI_MESSAGE_CHARS,
  MAX_AI_MESSAGES,
  MAX_EXPORT_BYTES,
  MAX_HISTORY_SQL_LENGTH,
  MAX_QUERY_ROWS,
  MAX_SAVED_SQL_LENGTH,
  MAX_SQL_LENGTH,
} from './types'

export const DATABASE_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/

export const DatabaseIdSchema = z.string().regex(DATABASE_ID_RE, 'Invalid id')
const ConnectionIdSchema = DatabaseIdSchema
const ConnectionNameSchema = z.string().trim().min(1).max(100)
const AccountIdSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid account id')
const D1DatabaseIdSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, 'Invalid database id')
const TursoUrlSchema = z.string().trim().min(1).max(2_048)
const SecretSchema = z.string().min(1).max(4_096)
const ParamsSchema = z.array(z.unknown()).max(1_000)

export const CreateConnectionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('d1'),
    name: ConnectionNameSchema,
    d1AccountId: AccountIdSchema,
    d1DatabaseId: D1DatabaseIdSchema,
    d1DatabaseName: z.string().max(200).optional(),
    secret: SecretSchema,
  }),
  z.object({
    type: z.literal('turso'),
    name: ConnectionNameSchema,
    tursoUrl: TursoUrlSchema,
    secret: SecretSchema,
  }),
])

export const UpdateConnectionSchema = z.object({
  name: ConnectionNameSchema.optional(),
  d1AccountId: AccountIdSchema.optional(),
  d1DatabaseId: D1DatabaseIdSchema.optional(),
  d1DatabaseName: z.string().max(200).optional(),
  tursoUrl: TursoUrlSchema.optional(),
  secret: z.string().max(4_096).optional(),
})

export const ConnectionFlagsSchema = z.object({
  isFavorite: z.boolean().optional(),
  isPinned: z.boolean().optional(),
})

export const ConnectionOrderSchema = z.object({
  ids: z.array(ConnectionIdSchema).max(200),
})

export const D1DatabasesSchema = z
  .object({
    accountId: AccountIdSchema.optional(),
    apiToken: SecretSchema.optional(),
    connectionId: ConnectionIdSchema.optional(),
  })
  .refine(
    (value) => Boolean(value.connectionId) || Boolean(value.accountId && value.apiToken),
    'Provide connectionId or accountId with apiToken',
  )

export const TestConnectionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('d1'),
      connectionId: ConnectionIdSchema.optional(),
      d1AccountId: AccountIdSchema.optional(),
      d1DatabaseId: D1DatabaseIdSchema.optional(),
      secret: SecretSchema.optional(),
    })
    .refine(
      (value) => Boolean(value.connectionId) || Boolean(value.d1AccountId && value.d1DatabaseId && value.secret),
      'Provide connectionId or account, database and secret',
    ),
  z
    .object({
      type: z.literal('turso'),
      connectionId: ConnectionIdSchema.optional(),
      tursoUrl: TursoUrlSchema.optional(),
      secret: SecretSchema.optional(),
    })
    .refine(
      (value) => Boolean(value.connectionId) || Boolean(value.tursoUrl && value.secret),
      'Provide connectionId or url and secret',
    ),
])

export const QuerySchema = z.object({
  connectionId: ConnectionIdSchema,
  sql: z.string().min(1).max(MAX_SQL_LENGTH),
  params: ParamsSchema.optional(),
  recordHistory: z.boolean().optional(),
})

export const QueryBatchSchema = z.object({
  connectionId: ConnectionIdSchema,
  statements: z
    .array(
      z.object({
        sql: z.string().min(1).max(MAX_SQL_LENGTH),
        params: ParamsSchema.optional(),
      }),
    )
    .min(1)
    .max(20),
  recordHistory: z.boolean().optional(),
})

export const SavedQueryCreateSchema = z.object({
  connectionId: ConnectionIdSchema,
  name: ConnectionNameSchema,
  sql: z.string().min(1).max(MAX_SAVED_SQL_LENGTH),
  namespace: z.string().trim().max(50).optional(),
})

export const SavedQueryUpdateSchema = z.object({
  name: ConnectionNameSchema.optional(),
  sql: z.string().min(1).max(MAX_SAVED_SQL_LENGTH).optional(),
  namespace: z.string().trim().max(50).optional(),
})

export const DatabaseSettingsSchema = z.object({
  historyLimit: z.number().int().min(HISTORY_LIMIT_MIN).max(HISTORY_LIMIT_MAX),
})

export const ExportCreateSchema = z.object({
  format: z.enum(EXPORT_FORMATS),
  filename: z.string().trim().min(1).max(200),
  content: z.string().max(MAX_EXPORT_BYTES),
})

export const AiChatSchema = z.object({
  mode: z.enum(['generate', 'explain', 'optimize']),
  prompt: z.string().max(MAX_AI_MESSAGE_CHARS).optional(),
  currentSql: z.string().max(MAX_AI_MESSAGE_CHARS).optional(),
  schemaText: z.string().max(MAX_AI_MESSAGE_CHARS).optional(),
})

const AiMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(MAX_AI_MESSAGE_CHARS),
})

export const AgentChatSchema = z.object({
  messages: z.array(AiMessageSchema).min(1).max(MAX_AI_MESSAGES),
  allowWrites: z.boolean().optional(),
})

export const ToolRunQuerySchema = z.object({
  connectionId: ConnectionIdSchema,
  sql: z.string().min(1).max(MAX_SQL_LENGTH),
  params: ParamsSchema.optional(),
  confirm: z.boolean().optional(),
})

export const PreviewTableSchema = z.object({
  connectionId: ConnectionIdSchema,
  table: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(MAX_QUERY_ROWS).optional(),
})

export const HistoryQuerySchema = z.object({
  connectionId: ConnectionIdSchema,
  limit: z.number().int().min(1).max(HISTORY_LIMIT_MAX).optional(),
})

export const HistorySqlSchema = z.string().min(1).max(MAX_HISTORY_SQL_LENGTH)

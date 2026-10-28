import type { DatabaseErrorKind } from './types'

const CHECKS: ReadonlyArray<[DatabaseErrorKind, readonly string[]]> = [
  ['syntax', ['syntax error', 'near "', 'incomplete input', 'unrecognized token']],
  ['no_table', ['no such table']],
  ['no_column', ['no such column']],
  ['unique', ['unique constraint', 'duplicate']],
  ['foreign_key', ['foreign key constraint']],
  ['not_null', ['not null constraint', 'cannot be null']],
  ['check', ['check constraint']],
  ['constraint', ['constraint failed', 'constraint']],
  ['type_mismatch', ['datatype mismatch', 'type mismatch']],
  ['busy', ['database is locked', 'database is busy']],
  ['readonly', ['readonly', 'read-only']],
  ['rate_limit', ['rate limit', 'too many requests', '429']],
  ['timeout', ['timeout', 'timed out']],
  ['permission', ['authorization', 'permission denied', 'not authorized', 'authentication']],
]

export function classifyDatabaseError(message: string): DatabaseErrorKind {
  const lower = message.toLowerCase()
  for (const [kind, needles] of CHECKS) {
    if (needles.some((needle) => lower.includes(needle))) return kind
  }
  return 'unknown'
}

export function databaseErrorMessage(kind: DatabaseErrorKind): string {
  switch (kind) {
    case 'syntax':
      return 'SQL syntax error'
    case 'no_table':
      return 'Table does not exist'
    case 'no_column':
      return 'Column does not exist'
    case 'unique':
      return 'A unique constraint was violated'
    case 'foreign_key':
      return 'A foreign key constraint was violated'
    case 'not_null':
      return 'A NOT NULL constraint was violated'
    case 'check':
      return 'A CHECK constraint was violated'
    case 'constraint':
      return 'A constraint was violated'
    case 'type_mismatch':
      return 'A value does not match the column type'
    case 'busy':
      return 'The database is busy; try again'
    case 'readonly':
      return 'The database is read-only'
    case 'rate_limit':
      return 'The database is rate limiting requests'
    case 'timeout':
      return 'The query timed out'
    case 'permission':
      return 'The database refused the credentials'
    case 'confirmation_required':
      return 'Writing requires explicit confirmation'
    default:
      return 'The query failed'
  }
}

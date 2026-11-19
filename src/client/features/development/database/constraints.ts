import { quoteIdent } from '@shared/development/database/sql-utils'
import {
  findMatchingParen,
  isKeyword,
  parseReferenceAction,
  renderTokens,
  simpleIndexColumn,
  splitTopLevel,
  tokenize,
  upper,
  type Token,
} from './schema-parse'

export type RefAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

export const REF_ACTIONS: readonly RefAction[] = [
  'NO ACTION',
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'SET DEFAULT',
]

export type DiagramConstraintKind = 'foreign-key' | 'unique' | 'check' | 'unknown'

export interface DiagramConstraint {
  id: string
  kind: DiagramConstraintKind
  name?: string
  raw: string
  columns?: string[]
  refTable?: string
  refColumns?: string[]
  onUpdate?: RefAction
  onDelete?: RefAction
  uniqueColumns?: string[]
  expression?: string
}

const idCounters = new Map<string, number>()

export function makeDiagramId(prefix: string): string {
  const next = (idCounters.get(prefix) ?? 0) + 1
  idCounters.set(prefix, next)
  return `${prefix}-${next.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function normalizeRefAction(value: string | undefined): RefAction {
  const normalized = (value ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
  return (REF_ACTIONS as readonly string[]).includes(normalized)
    ? (normalized as RefAction)
    : 'NO ACTION'
}

export function splitIdentifierList(text: string): string[] {
  if (!text.trim()) return []
  return splitTopLevel(tokenize(text))
    .map((term) => simpleIndexColumn(term))
    .filter((name): name is string => Boolean(name))
}

function readQualifiedName(tokens: Token[], start: number): { name: string; next: number } | null {
  const parts: string[] = []
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token || token.type !== 'ident') break
    parts.push(token.text)
    i += 1
    if (tokens[i]?.type === 'punct' && tokens[i]!.text === '.') {
      i += 1
      continue
    }
    break
  }
  return parts.length > 0 ? { name: parts.join('.'), next: i } : null
}

function parseColumnList(tokens: Token[], start: number): { columns: string[]; next: number } | null {
  if (!(tokens[start]?.type === 'punct' && tokens[start]!.text === '(')) return null
  const end = findMatchingParen(tokens, start)
  const columns = splitTopLevel(tokens.slice(start + 1, end))
    .map((term) => simpleIndexColumn(term))
    .filter((name): name is string => Boolean(name))
  if (columns.length === 0) return null
  return { columns, next: end + 1 }
}

function hasUnsupportedTail(tokens: Token[], start: number): boolean {
  let i = start
  while (i < tokens.length) {
    const keyword = upper(tokens[i])
    if (keyword === 'ON' && isKeyword(tokens[i + 1], 'CONFLICT')) {
      i += 3
      continue
    }
    return true
  }
  return false
}

function parseForeignKeys(tokens: Token[], start: number, name?: string): DiagramConstraint | null {
  if (!isKeyword(tokens[start], 'FOREIGN') || !isKeyword(tokens[start + 1], 'KEY')) return null
  const local = parseColumnList(tokens, start + 2)
  if (!local) return null
  if (!isKeyword(tokens[local.next], 'REFERENCES')) return null

  const table = readQualifiedName(tokens, local.next + 1)
  if (!table) return null

  let i = table.next
  let refColumns: string[] = []
  if (tokens[i]?.type === 'punct' && tokens[i]!.text === '(') {
    const remote = parseColumnList(tokens, i)
    if (!remote) return null
    refColumns = remote.columns
    i = remote.next
  }

  let onUpdate: RefAction | undefined
  let onDelete: RefAction | undefined
  for (;;) {
    const keyword = upper(tokens[i])
    if (keyword === 'ON' && (isKeyword(tokens[i + 1], 'DELETE') || isKeyword(tokens[i + 1], 'UPDATE'))) {
      const target = isKeyword(tokens[i + 1], 'DELETE') ? 'delete' : 'update'
      const action = parseReferenceAction(tokens, i + 2)
      if (!action) return null
      if (target === 'delete') onDelete = normalizeRefAction(action.value)
      else onUpdate = normalizeRefAction(action.value)
      i = action.next
      continue
    }
    if (keyword === 'MATCH' || keyword === 'DEFERRABLE' || (keyword === 'NOT' && isKeyword(tokens[i + 1], 'DEFERRABLE'))) {
      return null
    }
    break
  }
  if (hasUnsupportedTail(tokens, i)) return null

  return {
    id: '',
    kind: 'foreign-key',
    ...(name ? { name } : {}),
    raw: '',
    columns: local.columns,
    refTable: table.name,
    ...(refColumns.length > 0 ? { refColumns } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    ...(onDelete ? { onDelete } : {}),
  }
}

export function parseTableConstraint(raw: string): DiagramConstraint | null {
  const tokens = tokenize(raw)
  if (tokens.length === 0) return null

  let i = 0
  let name: string | undefined
  if (isKeyword(tokens[0], 'CONSTRAINT')) {
    const token = tokens[1]
    if (!token || token.type !== 'ident') return null
    name = token.text
    i = 2
  }

  const kind = upper(tokens[i])
  let parsed: DiagramConstraint | null = null
  if (kind === 'PRIMARY') return null

  if (kind === 'FOREIGN') {
    parsed = parseForeignKeys(tokens, i, name)
  } else if (kind === 'UNIQUE') {
    const columns = parseColumnList(tokens, i + 1)
    if (columns && !hasUnsupportedTail(tokens, columns.next)) {
      parsed = {
        id: '',
        kind: 'unique',
        ...(name ? { name } : {}),
        raw: '',
        uniqueColumns: columns.columns,
      }
    }
  } else if (kind === 'CHECK') {
    if (tokens[i + 1]?.type === 'punct' && tokens[i + 1]!.text === '(') {
      const end = findMatchingParen(tokens, i + 1)
      if (!hasUnsupportedTail(tokens, end + 1)) {
        parsed = {
          id: '',
          kind: 'check',
          ...(name ? { name } : {}),
          raw: '',
          expression: renderTokens(tokens.slice(i + 2, end)),
        }
      }
    }
  }

  if (!parsed) {
    return { id: '', kind: 'unknown', ...(name ? { name } : {}), raw }
  }
  parsed.raw = raw
  parsed.id = makeDiagramId('constraint')
  return parsed
}

function quoteQualified(name: string): string {
  return name.split('.').map((part) => quoteIdent(part)).join('.')
}

export function serializeConstraint(constraint: DiagramConstraint): string {
  if (constraint.kind === 'unknown') return constraint.raw
  const prefix = constraint.name ? `CONSTRAINT ${quoteIdent(constraint.name)} ` : ''

  if (constraint.kind === 'foreign-key') {
    const columns = constraint.columns ?? []
    const refColumns = constraint.refColumns ?? []
    const actions = [
      constraint.onUpdate ? `ON UPDATE ${constraint.onUpdate}` : '',
      constraint.onDelete ? `ON DELETE ${constraint.onDelete}` : '',
    ].filter(Boolean)
    return (
      `${prefix}FOREIGN KEY (${columns.map(quoteIdent).join(', ')}) ` +
      `REFERENCES ${quoteQualified(constraint.refTable ?? '')}` +
      `${refColumns.length > 0 ? ` (${refColumns.map(quoteIdent).join(', ')})` : ''}` +
      `${actions.length > 0 ? ` ${actions.join(' ')}` : ''}`
    )
  }

  if (constraint.kind === 'unique') {
    const columns = constraint.uniqueColumns ?? []
    return `${prefix}UNIQUE (${columns.map(quoteIdent).join(', ')})`
  }

  return `${prefix}CHECK (${constraint.expression ?? ''})`
}

function normalizeExpression(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

export function constraintSignature(constraint: DiagramConstraint): string {
  if (constraint.kind === 'unknown') {
    return JSON.stringify(['unknown', normalizeExpression(constraint.raw)])
  }
  const lower = (values: string[] | undefined): string[] =>
    (values ?? []).map((value) => value.toLowerCase())
  return JSON.stringify([
    constraint.kind,
    constraint.name?.toLowerCase() ?? '',
    lower(constraint.columns),
    (constraint.refTable ?? '').toLowerCase(),
    lower(constraint.refColumns),
    constraint.onUpdate ?? 'NO ACTION',
    constraint.onDelete ?? 'NO ACTION',
    lower(constraint.uniqueColumns),
    normalizeExpression(constraint.expression),
  ])
}

export function sameConstraint(left: DiagramConstraint, right: DiagramConstraint): boolean {
  return constraintSignature(left) === constraintSignature(right)
}

export function isForeignKeyConstraint(
  constraint: DiagramConstraint,
): constraint is DiagramConstraint & {
  kind: 'foreign-key'
  columns: string[]
  refTable: string
} {
  return constraint.kind === 'foreign-key'
    && Array.isArray(constraint.columns)
    && constraint.columns.length > 0
    && Boolean(constraint.refTable)
}
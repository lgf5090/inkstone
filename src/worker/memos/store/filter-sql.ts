/**
 * The part of a memo filter SQL can answer on its own.
 *
 * A filter used to be read as a whole only after every row of the account had been loaded, so a tag
 * query paid for the bodies of twenty thousand memos before it picked sixteen. This compiler turns the
 * conditions whose meaning is a column into SQL, and the list query asks only those rows.
 *
 * It is deliberately conservative. An expression it cannot translate exactly is left to the evaluator
 * rather than approximated, and `pushdown` may return a *necessary* condition (one implied by the
 * expression) so a scan still narrows without ever dropping a match. A `null` pushdown means the scan
 * has to read the rows; a non-null `complete` means the SQL is the whole answer.
 */
import type { MemoFilterBinaryOperator, MemoFilterNode } from '@shared/memos/filter'
import { parseDurationSeconds, parseTimestampSeconds } from '@shared/memos/filter/datetime'

export interface MemoFilterSql {
  sql: string
  params: unknown[]
}

export interface MemoFilterSqlPlan {
  /** The whole expression as SQL, when every node translated exactly. */
  complete: MemoFilterSql | null
  /** A condition the expression implies, when only part of it translated. */
  pushdown: MemoFilterSql | null
}

const TEXT_SEARCH = 'i.content_search'

function combine(parts: readonly (MemoFilterSql | null)[], operator: 'AND' | 'OR'): MemoFilterSql | null {
  const present = parts.filter((part): part is MemoFilterSql => part !== null)
  if (!present.length) return null
  return {
    sql: `(${present.map((part) => part.sql).join(` ${operator} `)})`,
    params: present.flatMap((part) => part.params),
  }
}

function sequence(left: MemoFilterSql, right: MemoFilterSql, operator: 'AND' | 'OR'): MemoFilterSql {
  return {
    sql: `(${left.sql} ${operator} ${right.sql})`,
    params: [...left.params, ...right.params],
  }
}

/** A constant the evaluator would have read from a literal, or the turn's own clock. */
function constant(node: MemoFilterNode, now: number): unknown {
  if (node.kind === 'literal') return node.value
  if (node.kind === 'field' && node.name === 'now') return now
  return undefined
}

interface Value {
  sql: string
  params: unknown[]
  kind: 'string' | 'number' | 'bool'
}

/** A column as a value: the field the SQL row actually holds. */
function column(node: MemoFilterNode): Value | null {
  if (node.kind !== 'field') return null
  switch (node.name) {
    case 'content':
      return { sql: 'i.content', params: [], kind: 'string' }
    case 'visibility':
      return { sql: 'i.visibility', params: [], kind: 'string' }
    case 'pinned':
      return { sql: 'i.pinned', params: [], kind: 'number' }
    case 'has_link':
      return { sql: 'i.has_link', params: [], kind: 'number' }
    case 'has_code':
      return { sql: 'i.has_code', params: [], kind: 'number' }
    case 'has_task_list':
      return { sql: 'i.has_task_list', params: [], kind: 'number' }
    case 'has_incomplete_tasks':
      return { sql: 'i.has_incomplete_tasks', params: [], kind: 'number' }
    case 'has_location':
      return { sql: 'i.has_location', params: [], kind: 'number' }
    case 'created_ts':
      return { sql: 'i.created_at', params: [], kind: 'number' }
    case 'updated_ts':
      return { sql: 'i.updated_at', params: [], kind: 'number' }
    case 'space':
      return { sql: 'i.space_id', params: [], kind: 'string' }
    case 'creator':
      return { sql: 'i.user_id', params: [], kind: 'string' }
    default:
      return null
  }
}

function valueOf(node: MemoFilterNode, now: number, viewerId: string): Value | null {
  const direct = constant(node, now)
  if (direct !== undefined) {
    const kind = typeof direct === 'number' ? 'number' : typeof direct === 'boolean' ? 'bool' : 'string'
    return { sql: '?', params: [direct], kind }
  }
  if (node.kind === 'unary' && node.operator === '-') {
    const inner = valueOf(node.operand, now, viewerId)
    if (!inner || inner.kind !== 'number') return null
    return { sql: `(-${inner.sql})`, params: inner.params, kind: 'number' }
  }
  if (node.kind === 'binary' && (node.operator === '+' || node.operator === '-')) {
    const left = valueOf(node.left, now, viewerId)
    const right = valueOf(node.right, now, viewerId)
    if (!left || !right || left.kind !== 'number' || right.kind !== 'number') return null
    return { sql: `(${left.sql} ${node.operator} ${right.sql})`, params: [...left.params, ...right.params], kind: 'number' }
  }
  if (node.kind === 'call' && node.target === null) {
    const argument = node.args[0]
    // duration() and timestamp() are resolved here, in the worker, rather than left to SQLite: the
    // parser already validated the literal and the evaluator would have used these same seconds.
    if (node.method === 'duration' || node.method === 'timestamp') {
      const literal = argument?.kind === 'literal' && typeof argument.value === 'string' ? argument.value : null
      if (literal === null) return null
      const seconds = node.method === 'duration'
        ? parseDuration(literal)
        : parseTimestamp(literal)
      return seconds === null ? null : { sql: '?', params: [seconds], kind: 'number' }
    }
  }
  return column(node)
}

/** Durations and timestamps are re-read from the shared helpers so the two paths cannot drift. */
function parseDuration(value: string): number | null {
  return parseDurationSeconds(value)
}

function parseTimestamp(value: string): number | null {
  return parseTimestampSeconds(value)
}

/**
 * One comparison, when one side is a column and the other a constant.
 *
 * The visibility column stores the lowercase form and the evaluator compares the uppercase one, so a
 * literal that is not already uppercase can never match; that is translated as the constant it is.
 */
function comparison(
  operator: MemoFilterBinaryOperator,
  leftNode: MemoFilterNode,
  rightNode: MemoFilterNode,
  now: number,
  viewerId: string,
  tags: boolean,
): MemoFilterSql | null {
  if (tags) return tagComparison(operator, leftNode, rightNode, now)
  const left = valueOf(leftNode, now, viewerId)
  const right = valueOf(rightNode, now, viewerId)
  if (!left || !right) return null
  if (left.sql !== '?' && right.sql !== '?') return null
  if (left.sql === '?' && right.sql === '?') return null

  if (operator === '==') return equality(left, right, leftNode, viewerId)
  if (operator === '!=') return equality(left, right, leftNode, viewerId, true)
  if (operator === '+' || operator === '-') return null
  if (left.kind !== 'number' || right.kind !== 'number') return null
  return { sql: `(${left.sql} ${operator} ${right.sql})`, params: [...left.params, ...right.params] }
}

function equality(
  left: Value,
  right: Value,
  leftNode: MemoFilterNode,
  viewerId: string,
  negate = false,
): MemoFilterSql | null {
  if (leftNode.kind === 'field' && leftNode.name === 'visibility' && left.sql === 'i.visibility' && right.sql === '?') {
    const literal = right.params[0]
    if (typeof literal !== 'string') return null
    // Upper-cased values are the only strings the evaluator can match; anything else is a constant.
    if (literal !== literal.toUpperCase()) return { sql: negate ? '1' : '0', params: [] }
    return { sql: `(i.visibility ${negate ? '<>' : '='} ?)`, params: [literal.toLowerCase()] }
  }
  if (leftNode.kind === 'field' && leftNode.name === 'creator' && left.sql === 'i.user_id' && right.sql === '?') {
    const literal = right.params[0]
    if (typeof literal !== 'string') return null
    const value = literal === 'me' ? viewerId : literal.startsWith('users/') ? literal.slice('users/'.length) : null
    if (value === null) return { sql: negate ? '1' : '0', params: [] }
    return { sql: `(i.user_id ${negate ? '<>' : '='} ?)`, params: [value] }
  }
  if (leftNode.kind === 'field' && leftNode.name === 'space' && left.sql === 'i.space_id') {
    if (right.sql === '?') {
      const literal = right.params[0]
      if (literal === null) return { sql: negate ? '(i.space_id IS NOT NULL)' : '(i.space_id IS NULL)', params: [] }
      if (typeof literal !== 'string') return null
      const value = literal.startsWith('spaces/') ? literal.slice('spaces/'.length) : null
      if (value === null) return { sql: negate ? '1' : '0', params: [] }
      return { sql: `(i.space_id ${negate ? '<>' : '='} ?)`, params: [value] }
    }
  }
  if (left.kind === 'number' && right.sql === '?') {
    const literal = right.params[0]
    if (typeof literal === 'number') {
      return { sql: `(${left.sql} ${negate ? '<>' : '='} ?)`, params: [literal] }
    }
    // A boolean column is stored as 0/1.
    if (typeof literal === 'boolean') {
      return { sql: `(${left.sql} ${negate ? '<>' : '='} ?)`, params: [literal ? 1 : 0] }
    }
  }
  if (left.kind === 'string' && right.kind === 'string' && right.sql === '?') {
    return { sql: `(${left.sql} ${negate ? '<>' : '='} ?)`, params: [right.params[0]] }
  }
  if (left.kind === 'bool' && right.kind === 'bool' && right.sql === '?') {
    return { sql: negate ? '0' : '1', params: [] }
  }
  return null
}

/**
 * `tag in [...]` and the equivalent `tags` field.
 *
 * The evaluator's `in` on a tag list means "any of these tags", which is a row in `memos_tags`.
 */
function tagComparison(
  operator: MemoFilterBinaryOperator,
  leftNode: MemoFilterNode,
  rightNode: MemoFilterNode,
  now: number,
): MemoFilterSql | null {
  if (operator !== 'in') return null
  if (isTagField(rightNode)
    && leftNode.kind === 'literal'
    && typeof leftNode.value === 'string') {
    return {
      sql: 'EXISTS (SELECT 1 FROM memos_tags t WHERE t.memo_id = i.id AND t.tag = ?)',
      params: [leftNode.value],
    }
  }
  if (leftNode.kind !== 'field' || leftNode.name !== 'tag' && leftNode.name !== 'tags') return null
  if (rightNode.kind !== 'list') return null
  const values = rightNode.items.map((item) => constant(item, now))
  if (values.some((value) => typeof value !== 'string')) return null
  if (!values.length) return { sql: '0', params: [] }
  return {
    sql: `EXISTS (SELECT 1 FROM memos_tags t WHERE t.memo_id = i.id AND t.tag IN (${values.map(() => '?').join(', ')}))`,
    params: values,
  }
}

function isTagField(node: MemoFilterNode): boolean {
  return node.kind === 'field' && (node.name === 'tag' || node.name === 'tags')
}

/** A string method on the content column, which is what the client's search box builds. */
function stringCall(node: MemoFilterNode, now: number): MemoFilterSql | null {
  if (node.kind !== 'call' || node.target === null) return null
  if (node.target.kind !== 'field' || node.target.name !== 'content') return null
  const argument = node.args[0]
  const literal = argument ? constant(argument, now) : undefined
  if (typeof literal !== 'string') return null
  const needle = literal.toLocaleLowerCase()
  // An empty needle matches everything in the evaluator; SQLite's instr/substr disagree at the edges.
  if (!needle) return { sql: '1', params: [] }
  switch (node.method) {
    case 'contains':
      return { sql: `(instr(${TEXT_SEARCH}, ?) > 0)`, params: [needle] }
    case 'startsWith':
      return { sql: `(instr(${TEXT_SEARCH}, ?) = 1)`, params: [needle] }
    case 'endsWith':
      return { sql: `(substr(${TEXT_SEARCH}, -length(?)) = ?)`, params: [needle, needle] }
    default:
      // `matches` is a regular expression; SQLite has no equivalent here, so the evaluator keeps it.
      return null
  }
}

/** `sets.contains(tags, [...])` and the comprehension spellings of the same question. */
function tagSetCall(node: MemoFilterNode, now: number): MemoFilterSql | null {
  if (node.kind !== 'call' || node.target === null) return null
  if (node.target.kind === 'field' && node.target.name === 'sets') {
    const tagsNode = node.args[0]
    const listNode = node.args[1]
    if (!tagsNode || !listNode || !isTagField(tagsNode) || listNode.kind !== 'list') return null
    const values = listNode.items.map((item) => constant(item, now))
    if (values.some((value) => typeof value !== 'string')) return null
    if (node.method === 'contains') {
      if (!values.length) return { sql: '1', params: [] }
      return {
        sql: `(${values.map(() => 'EXISTS (SELECT 1 FROM memos_tags t WHERE t.memo_id = i.id AND t.tag = ?)').join(' AND ')})`,
        params: values,
      }
    }
    if (node.method === 'intersects') {
      if (!values.length) return { sql: '0', params: [] }
      const sql = `EXISTS (SELECT 1 FROM memos_tags t WHERE t.memo_id = i.id AND t.tag IN (${values.map(() => '?').join(', ')}))`
      return { sql, params: values }
    }
    return null
  }
  // tags.exists(t => t == "...") and tags.all(...): the bound variable is only translatable when its
  // predicate is one equality, which is what the UI's tag chips produce.
  if (!isTagField(node.target)) return null
  const binding = node.args[0]
  const predicate = node.args[1]
  if (!binding || binding.kind !== 'field' || !predicate) return null
  const match = boundTag(predicate, binding.name, now)
  if (match === null) return null
  if (node.method === 'exists') {
    return {
      sql: `EXISTS (SELECT 1 FROM memos_tags t WHERE t.memo_id = i.id AND ${match.sql})`,
      params: match.params,
    }
  }
  if (node.method === 'all') {
    return {
      sql: `(EXISTS (SELECT 1 FROM memos_tags t WHERE t.memo_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM memos_tags t WHERE t.memo_id = i.id AND NOT (${match.sql})))`,
      params: match.params,
    }
  }
  if (node.method === 'exists_one') {
    return {
      sql: `((SELECT COUNT(*) FROM memos_tags t WHERE t.memo_id = i.id AND (${match.sql})) = 1)`,
      params: match.params,
    }
  }
  return null
}

/** A predicate `x == "tag"` on the bound variable, as a condition over the tag row. */
function boundTag(node: MemoFilterNode, variable: string, now: number): MemoFilterSql | null {
  if (node.kind !== 'binary' || node.operator !== '==') return null
  const other = node.left.kind === 'field' && node.left.name === variable
    ? node.right
    : node.right.kind === 'field' && node.right.name === variable
      ? node.left
      : null
  if (other === null) return null
  const value = constant(other, now)
  if (typeof value !== 'string') return null
  return { sql: 't.tag = ?', params: [value] }
}

function booleanOf(node: MemoFilterNode, now: number, viewerId: string): MemoFilterSql | null {
  if (node.kind === 'literal') {
    return typeof node.value === 'boolean' ? { sql: node.value ? '1' : '0', params: [] } : null
  }
  if (node.kind === 'field') {
    switch (node.name) {
      case 'pinned':
      case 'has_link':
      case 'has_code':
      case 'has_task_list':
      case 'has_incomplete_tasks':
      case 'has_location': {
        const value = column(node)
        return value ? { sql: `(${value.sql} = 1)`, params: [] } : null
      }
      default:
        return null
    }
  }
  if (node.kind === 'unary' && node.operator === '!') {
    const inner = booleanOf(node.operand, now, viewerId)
    return inner ? { sql: `(NOT ${inner.sql})`, params: inner.params } : null
  }
  if (node.kind === 'binary') {
    if (node.operator === '&&') {
      const left = booleanOf(node.left, now, viewerId)
      const right = booleanOf(node.right, now, viewerId)
      return left && right ? sequence(left, right, 'AND') : null
    }
    if (node.operator === '||') {
      const left = booleanOf(node.left, now, viewerId)
      const right = booleanOf(node.right, now, viewerId)
      return left && right ? sequence(left, right, 'OR') : null
    }
    const isTag = isTagField(node.left) || isTagField(node.right)
    return comparison(node.operator, node.left, node.right, now, viewerId, isTag)
  }
  if (node.kind === 'call') {
    return stringCall(node, now) ?? tagSetCall(node, now)
  }
  return null
}

/**
 * A condition the expression cannot do without.
 *
 * `A && B` gives up either side's pushdown when the other is untranslatable; `A || B` needs both, or
 * the SQL would drop the branch it cannot see. Negation flips a necessary condition into one that is
 * still necessary for the negated expression (the contrapositive).
 */
function pushdownOf(node: MemoFilterNode, now: number, viewerId: string): MemoFilterSql | null {
  const complete = booleanOf(node, now, viewerId)
  if (complete) return complete
  if (node.kind === 'unary' && node.operator === '!') {
    const inner = pushdownOf(node.operand, now, viewerId)
    return inner ? { sql: `(NOT ${inner.sql})`, params: inner.params } : null
  }
  if (node.kind === 'binary' && node.operator === '&&') {
    return combine([
      pushdownOf(node.left, now, viewerId),
      pushdownOf(node.right, now, viewerId),
    ], 'AND')
  }
  if (node.kind === 'binary' && node.operator === '||') {
    const left = pushdownOf(node.left, now, viewerId)
    const right = pushdownOf(node.right, now, viewerId)
    return left && right ? sequence(left, right, 'OR') : null
  }
  return null
}

export function planMemoFilterSql(ast: MemoFilterNode, viewerId: string, now: number): MemoFilterSqlPlan {
  return {
    complete: booleanOf(ast, now, viewerId),
    pushdown: pushdownOf(ast, now, viewerId),
  }
}
